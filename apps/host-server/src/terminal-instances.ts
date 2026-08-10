import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { tryDecodeProjectSessionPayload } from "@yaade/rpc"
import { fileUriToPath } from "@yaade/shared"

export type TerminalInstanceState =
  | "starting"
  | "running"
  | "exited"
  | "failed"
  | "disconnected"

export type TerminalInstance = {
  id: string
  generation: number
  projectId: string
  checkoutKey: string
  checkoutPath: string
  title: string
  ptyId: string | null
  processState: TerminalInstanceState
  createdAt: string
  startedAt: string | null
  lastActivityAt: string | null
  endedAt: string | null
  exitCode: number | null
  endReason: string | null
  revision: number
}

export type TerminalInstanceEvent = {
  type: "terminal.instance"
  kind: "instance.created" | "instance.updated" | "instance.ended" | "instance.removed"
  instance: TerminalInstance
}

type TerminalInstanceRow = {
  id: string
  generation: number
  project_id: string
  checkout_key: string
  checkout_path: string
  title: string
  pty_id: string | null
  process_state: string
  created_at: string
  started_at: string | null
  last_activity_at: string | null
  ended_at: string | null
  exit_code: number | null
  end_reason: string | null
  revision: number
}

const FINAL_TRANSCRIPT_BYTES = 256 * 1024

function nowIso(): string {
  return new Date().toISOString()
}

function state(value: string): TerminalInstanceState {
  switch (value) {
    case "starting":
    case "running":
    case "exited":
    case "failed":
    case "disconnected":
      return value
    default:
      return "disconnected"
  }
}

function toInstance(row: TerminalInstanceRow): TerminalInstance {
  return {
    id: row.id,
    generation: row.generation,
    projectId: row.project_id,
    checkoutKey: row.checkout_key,
    checkoutPath: row.checkout_path,
    title: row.title,
    ptyId: row.pty_id,
    processState: state(row.process_state),
    createdAt: row.created_at,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
    endReason: row.end_reason,
    revision: row.revision,
  }
}

function boundedTranscript(output: string): { output: string; truncated: number } {
  const bytes = Buffer.from(output, "utf8")
  if (bytes.byteLength <= FINAL_TRANSCRIPT_BYTES) return { output, truncated: 0 }
  return {
    output: bytes.subarray(bytes.byteLength - FINAL_TRANSCRIPT_BYTES).toString("utf8"),
    truncated: 1,
  }
}

export class TerminalInstanceService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly emit: (event: TerminalInstanceEvent) => void,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS terminal_instances(
        id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL DEFAULT 1,
        project_id TEXT NOT NULL,
        checkout_key TEXT NOT NULL,
        checkout_path TEXT NOT NULL,
        title TEXT NOT NULL,
        pty_id TEXT,
        process_state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        last_activity_at TEXT,
        ended_at TEXT,
        exit_code INTEGER,
        end_reason TEXT,
        transcript TEXT NOT NULL DEFAULT '',
        transcript_truncated INTEGER NOT NULL DEFAULT 0,
        removed_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_terminal_instances_project
        ON terminal_instances(project_id, removed_at, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_instances_pty
        ON terminal_instances(pty_id) WHERE pty_id IS NOT NULL;
    `)
    db.prepare(
      `UPDATE terminal_instances
          SET process_state='disconnected', ended_at=COALESCE(ended_at, ?),
              end_reason=COALESCE(end_reason, 'host_restart'), revision=revision+1
        WHERE process_state IN ('starting','running')`,
    ).run(nowIso())
    db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES(12)").run()
    this.backfillLegacyProjectTerminals()
  }

  reserve(input: {
    projectId: string
    checkoutKey: string
    checkoutPath: string
    title: string
    id?: string
    generation?: number
  }): TerminalInstance {
    const id = input.id ?? `terminal-${randomUUID()}`
    const generation = input.generation ?? 1
    const createdAt = nowIso()
    this.db.prepare(
      `INSERT INTO terminal_instances(
        id,generation,project_id,checkout_key,checkout_path,title,process_state,created_at,revision
      ) VALUES(?,?,?,?,?,?,'starting',?,1)`,
    ).run(id, generation, input.projectId, input.checkoutKey, input.checkoutPath, input.title, createdAt)
    const instance = this.get(id)
    if (!instance) throw new Error("terminal instance reservation was not persisted")
    this.emit({ type: "terminal.instance", kind: "instance.created", instance })
    return instance
  }

  bindPty(id: string, generation: number, ptyId: string, title?: string | null): TerminalInstance | null {
    const timestamp = nowIso()
    const changed = this.db.prepare(
      `UPDATE terminal_instances SET pty_id=?, title=COALESCE(NULLIF(?, ''), title),
          process_state='running', started_at=?, last_activity_at=?, ended_at=NULL,
          exit_code=NULL, end_reason=NULL, transcript='', transcript_truncated=0,
          revision=revision+1
        WHERE id=? AND generation=? AND removed_at IS NULL AND process_state='starting'`,
    ).run(ptyId, title ?? null, timestamp, timestamp, id, generation)
    return Number(changed.changes) === 0 ? this.get(id) : this.updated(id, "instance.updated")
  }

  fail(id: string, generation: number, reason: string): TerminalInstance | null {
    const changed = this.db.prepare(
      `UPDATE terminal_instances SET process_state='failed', ended_at=?, end_reason=?, revision=revision+1
        WHERE id=? AND generation=? AND removed_at IS NULL AND process_state='starting'`,
    ).run(nowIso(), reason.slice(0, 512), id, generation)
    return Number(changed.changes) === 0 ? this.get(id) : this.updated(id, "instance.ended")
  }

  onPtyExit(ptyId: string, exitCode: number | null, output: string, truncated = false): TerminalInstance | null {
    const current = this.byPtyId(ptyId)
    if (!current) return null
    const transcript = boundedTranscript(output)
    const changed = this.db.prepare(
      `UPDATE terminal_instances SET process_state='exited', ended_at=COALESCE(ended_at, ?),
          exit_code=COALESCE(?, exit_code), end_reason=COALESCE(end_reason, 'process_exit'),
          transcript=?, transcript_truncated=?, revision=revision+1
        WHERE id=? AND generation=? AND pty_id=? AND removed_at IS NULL
          AND process_state IN ('starting','running')`,
    ).run(
      nowIso(),
      exitCode,
      transcript.output,
      truncated || transcript.truncated === 1 ? 1 : 0,
      current.id,
      current.generation,
      ptyId,
    )
    return Number(changed.changes) === 0 ? this.get(current.id) : this.updated(current.id, "instance.ended")
  }

  beginRestart(id: string, generation: number): TerminalInstance | null {
    const changed = this.db.prepare(
      `UPDATE terminal_instances SET generation=generation+1, pty_id=NULL,
          process_state='starting', started_at=NULL, last_activity_at=NULL, ended_at=NULL,
          exit_code=NULL, end_reason=NULL, transcript='', transcript_truncated=0,
          revision=revision+1
        WHERE id=? AND generation=? AND removed_at IS NULL
          AND process_state IN ('exited','failed','disconnected')`,
    ).run(id, generation)
    return Number(changed.changes) === 0 ? this.get(id) : this.updated(id, "instance.updated")
  }

  close(id: string, generation: number, _output: string): TerminalInstance | null {
    const changed = this.db.prepare(
      `UPDATE terminal_instances SET process_state=CASE
            WHEN process_state IN ('starting','running') THEN 'exited' ELSE process_state END,
          ended_at=COALESCE(ended_at, ?), end_reason=COALESCE(end_reason, 'closed'),
          transcript='', transcript_truncated=0, removed_at=?, revision=revision+1
        WHERE id=? AND generation=? AND removed_at IS NULL`,
    ).run(nowIso(), nowIso(), id, generation)
    if (Number(changed.changes) === 0) return this.get(id)
    const instance = this.get(id, true)
    if (instance) this.emit({ type: "terminal.instance", kind: "instance.removed", instance })
    return instance
  }

  get(id: string, includeRemoved = false): TerminalInstance | null {
    const row = this.db.prepare(
      `SELECT * FROM terminal_instances WHERE id=?${includeRemoved ? "" : " AND removed_at IS NULL"}`,
    ).get(id) as TerminalInstanceRow | undefined
    return row ? toInstance(row) : null
  }

  byPtyId(ptyId: string): TerminalInstance | null {
    const row = this.db.prepare(
      `SELECT * FROM terminal_instances WHERE pty_id=? AND removed_at IS NULL LIMIT 1`,
    ).get(ptyId) as TerminalInstanceRow | undefined
    return row ? toInstance(row) : null
  }

  listProject(projectId: string): TerminalInstance[] {
    const rows = this.db.prepare(
      `SELECT * FROM terminal_instances WHERE project_id=? AND removed_at IS NULL
        ORDER BY created_at DESC, id DESC`,
    ).all(projectId) as TerminalInstanceRow[]
    return rows.map(toInstance)
  }

  listLiveForCheckout(checkoutPath: string): TerminalInstance[] {
    const rows = this.db.prepare(
      `SELECT * FROM terminal_instances WHERE checkout_path=? AND removed_at IS NULL
        AND process_state IN ('starting','running')`,
    ).all(checkoutPath) as TerminalInstanceRow[]
    return rows.map(toInstance)
  }

  transcript(id: string): { output: string; truncated: boolean } | null {
    const row = this.db.prepare(
      `SELECT transcript, transcript_truncated FROM terminal_instances
        WHERE id=? AND removed_at IS NULL`,
    ).get(id) as { transcript: string; transcript_truncated: number } | undefined
    return row ? { output: row.transcript, truncated: row.transcript_truncated === 1 } : null
  }

  private updated(id: string, kind: TerminalInstanceEvent["kind"]): TerminalInstance | null {
    const instance = this.get(id)
    if (instance) this.emit({ type: "terminal.instance", kind, instance })
    return instance
  }

  private backfillLegacyProjectTerminals(): void {
    const migrated = this.db.prepare(
      "SELECT version FROM schema_migrations WHERE version=13",
    ).get()
    if (migrated) return
    const projectSessionTable = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='project_sessions'",
    ).get()
    if (!projectSessionTable) {
      this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES(13)").run()
      return
    }
    const sessions = this.db.prepare(
      `SELECT ps.id, ps.project_path, ps.created_at, ps.payload_json, p.id AS project_id
         FROM project_sessions ps
         JOIN projects p ON p.root_path=ps.project_path
        WHERE ps.archived_at IS NULL`,
    ).all() as Array<{
      id: string
      project_path: string
      created_at: string
      payload_json: string
      project_id: string
    }>
    const insert = this.db.prepare(
      `INSERT INTO terminal_instances(
        id,generation,project_id,checkout_key,checkout_path,title,pty_id,
        process_state,created_at,ended_at,end_reason,revision
      ) VALUES(?,1,?,?,?,?,NULL,'disconnected',?,?,'host_restart',1)`,
    )
    this.db.exec("BEGIN IMMEDIATE")
    try {
      for (const session of sessions) {
        let payload
        try {
          payload = tryDecodeProjectSessionPayload(JSON.parse(session.payload_json))
        } catch {
          payload = null
        }
        if (!payload) continue
        for (const leaf of payload.sessions) {
          if (leaf.agentProvider) continue
          let checkoutPath: string
          try {
            checkoutPath = fileUriToPath(leaf.cwdRootUri)
          } catch {
            continue
          }
          const checkoutKey = checkoutPath === session.project_path ? "main" : checkoutPath
          insert.run(
            `terminal-${randomUUID()}`,
            session.project_id,
            checkoutKey,
            checkoutPath,
            leaf.label?.trim() || "Terminal",
            session.created_at,
            nowIso(),
          )
        }
      }
      this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES(13)").run()
      this.db.exec("COMMIT")
    } catch (error) {
      try { this.db.exec("ROLLBACK") } catch { /* ignore */ }
      throw error
    }
  }
}
