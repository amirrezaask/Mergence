import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { AgentAttachment } from "@yaade/agent-protocol"

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const DEFAULT_ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const MAX_ATTACHMENT_PRUNE_BATCH = 500
const ALLOWED_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/markdown",
  "application/json",
])

export type AgentAttachmentUpload = {
  threadId: string
  name: string
  mediaType: string
  contentBase64: string
}

export type AgentAttachmentDescriptor = {
  id: string
  name: string
  mediaType: string
  size: number
}

type AttachmentStorageRow = {
  attachment_id: string
  storage_key: string
}

export type AgentAttachmentCleanupResult = {
  deleted: number
  missingFiles: number
}

function attachmentRoot(dataDir: string): string {
  return path.resolve(dataDir, "agent-attachments")
}

function attachmentPath(root: string, storageKey: string): string | null {
  const storagePath = path.resolve(root, storageKey)
  return path.dirname(storagePath) === root ? storagePath : null
}

async function deleteRowsAndFiles(
  db: DatabaseSync,
  dataDir: string,
  rows: ReadonlyArray<AttachmentStorageRow>,
): Promise<AgentAttachmentCleanupResult> {
  const root = attachmentRoot(dataDir)
  const deletedIds: string[] = []
  let missingFiles = 0
  for (const row of rows) {
    const storagePath = attachmentPath(root, row.storage_key)
    if (!storagePath) {
      // The row cannot safely name a file under our storage root. Remove its
      // stale capability without ever following its path.
      deletedIds.push(row.attachment_id)
      continue
    }
    try {
      await fs.unlink(storagePath)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error
      }
      missingFiles++
    }
    deletedIds.push(row.attachment_id)
  }
  if (deletedIds.length > 0) {
    const deleteRow = db.prepare("DELETE FROM agent_attachments WHERE attachment_id=?")
    db.exec("BEGIN")
    try {
      for (const id of deletedIds) deleteRow.run(id)
      db.exec("COMMIT")
    } catch (error) {
      try {
        db.exec("ROLLBACK")
      } catch {
        /* Preserve the deletion failure. */
      }
      throw error
    }
  }
  return { deleted: deletedIds.length, missingFiles }
}

/** Remove every temporary upload owned by one durable agent thread. */
export async function deleteAgentAttachmentsForThread(
  db: DatabaseSync,
  dataDir: string,
  threadId: string,
): Promise<AgentAttachmentCleanupResult> {
  const rows = db.prepare(
    "SELECT attachment_id, storage_key FROM agent_attachments WHERE thread_id=?",
  ).all(threadId) as AttachmentStorageRow[]
  return deleteRowsAndFiles(db, dataDir, rows)
}

/** Bounded retention pass for abandoned temporary uploads. */
export async function pruneAgentAttachments(
  db: DatabaseSync,
  dataDir: string,
  options: {
    readonly now?: Date
    readonly maxAgeMs?: number
    readonly limit?: number
  } = {},
): Promise<AgentAttachmentCleanupResult> {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_ATTACHMENT_RETENTION_MS
  const limit = options.limit ?? MAX_ATTACHMENT_PRUNE_BATCH
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error("invalid attachment retention age")
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ATTACHMENT_PRUNE_BATCH) {
    throw new Error(`attachment prune limit must be between 1 and ${MAX_ATTACHMENT_PRUNE_BATCH}`)
  }
  const cutoff = new Date((options.now ?? new Date()).getTime() - maxAgeMs).toISOString()
  const rows = db.prepare(
    `SELECT attachment_id, storage_key FROM agent_attachments
      WHERE created_at < ? ORDER BY created_at ASC LIMIT ?`,
  ).all(cutoff, limit) as AttachmentStorageRow[]
  return deleteRowsAndFiles(db, dataDir, rows)
}

export async function storeAgentAttachment(
  db: DatabaseSync,
  dataDir: string,
  input: AgentAttachmentUpload,
): Promise<AgentAttachmentDescriptor> {
  if (!db.prepare("SELECT 1 FROM agent_threads WHERE thread_id=?").get(input.threadId)) {
    throw new Error("agent thread not found")
  }
  if (!ALLOWED_MEDIA_TYPES.has(input.mediaType)) {
    throw new Error(`unsupported agent attachment type: ${input.mediaType}`)
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64)) {
    throw new Error("invalid attachment encoding")
  }
  const content = Buffer.from(input.contentBase64, "base64")
  if (content.byteLength === 0 || content.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`agent attachment must be between 1 and ${MAX_ATTACHMENT_BYTES} bytes`)
  }
  const id = `aat-${randomUUID()}`
  const name = path.basename(input.name).slice(0, 240) || "attachment"
  const storageKey = id
  const root = attachmentRoot(dataDir)
  const filePath = path.join(root, storageKey)
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  await fs.writeFile(filePath, content, { mode: 0o600 })
  const createdAt = new Date().toISOString()
  try {
    db.prepare(
      `INSERT INTO agent_attachments(
        attachment_id, thread_id, name, media_type, size, storage_key, created_at
      ) VALUES(?,?,?,?,?,?,?)`,
    ).run(id, input.threadId, name, input.mediaType, content.byteLength, storageKey, createdAt)
  } catch (error) {
    await fs.unlink(filePath).catch(() => {})
    throw error
  }
  // Retention is deliberately best-effort here. A later upload can clean up
  // abandoned files without making the active upload fail.
  void pruneAgentAttachments(db, dataDir).catch(() => {})
  return { id, name, mediaType: input.mediaType, size: content.byteLength }
}

export async function resolveAgentAttachment(
  db: DatabaseSync,
  dataDir: string,
  threadId: string,
  attachmentId: string,
): Promise<AgentAttachment> {
  const row = db.prepare(
    `SELECT name, media_type, size, storage_key, created_at
       FROM agent_attachments WHERE attachment_id=? AND thread_id=?`,
  ).get(attachmentId, threadId) as {
    name: string
    media_type: string
    size: number
    storage_key: string
    created_at: string
  } | undefined
  if (!row) throw new Error(`unknown agent attachment: ${attachmentId}`)
  const root = attachmentRoot(dataDir)
  const storagePath = attachmentPath(root, row.storage_key)
  if (!storagePath) throw new Error("invalid agent attachment storage key")
  const stat = await fs.lstat(storagePath)
  if (!stat.isFile() || stat.size !== row.size || stat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error("agent attachment changed after upload")
  }
  return AgentAttachment.make({
    id: attachmentId,
    name: row.name,
    mediaType: row.media_type,
    size: row.size,
    source: { type: "temporary-upload", storageKey: storagePath },
    createdAt: row.created_at,
  })
}

/** Read one validated upload without following a replaced storage symlink. */
export async function readAgentAttachment(
  db: DatabaseSync,
  dataDir: string,
  threadId: string,
  attachmentId: string,
): Promise<Uint8Array> {
  const attachment = await resolveAgentAttachment(db, dataDir, threadId, attachmentId)
  if (attachment.source.type !== "temporary-upload") {
    throw new Error("attachment content is not a temporary upload")
  }
  const handle = await fs.open(
    attachment.source.storageKey,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  )
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== attachment.size || stat.size > MAX_ATTACHMENT_BYTES) {
      throw new Error("agent attachment changed while reading")
    }
    const content = await handle.readFile()
    if (content.byteLength !== attachment.size) {
      throw new Error("agent attachment changed while reading")
    }
    return content
  } finally {
    await handle.close()
  }
}
