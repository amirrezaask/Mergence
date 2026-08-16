import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const MAX_QUEUE_ENTRIES = 10_000
const MAX_QUEUE_BYTES = 50 * 1024 * 1024
const MAX_QUEUE_AGE_MS = 14 * 24 * 60 * 60 * 1000
let discardedSinceLastRead = 0

export function hookQueueDir(dataDir?: string): string {
  const root =
    dataDir ??
    process.env.JET_DATA_DIR ??
    path.join(os.homedir(), ".local", "share", "jet")
  return path.join(root, "hook-queue")
}

/** Persist a failed hook delivery for later drain. */
export function enqueueFailedHook(
  payload: unknown,
  meta: { provider: string; sessionId: string; ingestUrl: string },
  dataDir?: string,
): string {
  const dir = hookQueueDir(dataDir)
  fs.mkdirSync(dir, { recursive: true })
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const file = path.join(dir, `${id}.json`)
  const serialized = JSON.stringify({
      id,
      enqueuedAt: new Date().toISOString(),
      retryCount: 0,
      nextAttemptAt: new Date().toISOString(),
      meta,
      payload,
    })
  const temporary = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temporary, serialized, "utf8")
  fs.renameSync(temporary, file)
  enforceQueueBounds(dir)
  return file
}

export type QueuedHook = {
  file: string
  payload: unknown
  meta: { provider: string; sessionId: string; ingestUrl: string }
  retryCount: number
  nextAttemptAt: string
}

/** List queued hook files (oldest first). */
export async function listQueuedHooks(dataDir?: string): Promise<QueuedHook[]> {
  const dir = hookQueueDir(dataDir)
  let files: string[]
  try {
    files = (await fs.promises.readdir(dir))
      .filter(file => file.endsWith(".json"))
      .sort()
  } catch (error) {
    if (isMissingFileError(error)) return []
    throw error
  }
  const out: QueuedHook[] = []
  const now = Date.now()
  for (const name of files) {
    const file = path.join(dir, name)
    try {
      const raw = JSON.parse(await fs.promises.readFile(file, "utf8")) as {
        payload: unknown
        meta: QueuedHook["meta"]
        enqueuedAt?: string
        retryCount?: number
        nextAttemptAt?: string
      }
      const enqueuedAt = Date.parse(raw.enqueuedAt ?? "")
      if (Number.isFinite(enqueuedAt) && now - enqueuedAt > MAX_QUEUE_AGE_MS) {
        await removeQueuedHook(file)
        discardedSinceLastRead += 1
        continue
      }
      const nextAttemptAt = raw.nextAttemptAt ?? new Date(0).toISOString()
      if (Date.parse(nextAttemptAt) > now) continue
      if (!raw.meta || typeof raw.meta.provider !== "string" || typeof raw.meta.sessionId !== "string") {
        throw new Error("invalid hook metadata")
      }
      out.push({
        file,
        payload: raw.payload,
        meta: raw.meta,
        retryCount: Math.max(0, raw.retryCount ?? 0),
        nextAttemptAt,
      })
    } catch {
      await removeQueuedHook(file)
      discardedSinceLastRead += 1
    }
  }
  return out
}

export async function markQueuedHookRetry(file: string, error: unknown): Promise<void> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(file, "utf8")) as Record<string, unknown>
    const retryCount = Math.max(0, Number(parsed.retryCount ?? 0)) + 1
    const delayMs = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(retryCount, 8))
    const next = {
      ...parsed,
      retryCount,
      nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
      lastError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    }
    const temporary = `${file}.tmp-${process.pid}`
    await fs.promises.writeFile(temporary, JSON.stringify(next), "utf8")
    await fs.promises.rename(temporary, file)
  } catch {
    await removeQueuedHook(file)
    discardedSinceLastRead += 1
  }
}

export function consumeHookQueueDiscardCount(): number {
  const count = discardedSinceLastRead
  discardedSinceLastRead = 0
  return count
}

function enforceQueueBounds(dir: string): void {
  const files = fs.readdirSync(dir)
    .filter(name => name.endsWith(".json"))
    .sort()
  let bytes = 0
  const sizes = files.map(name => {
    const file = path.join(dir, name)
    let size = 0
    try { size = fs.statSync(file).size } catch { /* removed concurrently */ }
    bytes += size
    return { file, size }
  })
  while (sizes.length > MAX_QUEUE_ENTRIES || bytes > MAX_QUEUE_BYTES) {
    const oldest = sizes.shift()
    if (!oldest) break
    removeQueuedHookSync(oldest.file)
    bytes -= oldest.size
    discardedSinceLastRead += 1
  }
}

export async function removeQueuedHook(file: string): Promise<void> {
  try {
    await fs.promises.unlink(file)
  } catch (error) {
    if (!isMissingFileError(error)) throw error
  }
}

function removeQueuedHookSync(file: string): void {
  try {
    fs.unlinkSync(file)
  } catch {
    /* ignore */
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
