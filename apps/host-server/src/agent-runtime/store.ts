import type { DatabaseSync } from "node:sqlite"
import {
  AgentCommandResult,
  AgentCommandEnvelope,
  AgentEventEnvelope,
  AgentThreadSnapshot,
  type AgentCommandResult as AgentCommandResultType,
  type AgentCommandEnvelope as AgentCommandEnvelopeType,
  type AgentEventEnvelope as AgentEventEnvelopeType,
  type AgentThreadSnapshot as AgentThreadSnapshotType,
} from "@yaade/agent-protocol"
import { reduceAgentThreadEvent } from "@yaade/agent-runtime"
import { Schema } from "effect"

function decode<T>(schema: any, value: string): T | null {
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(value)) as T
  } catch {
    return null
  }
}

/** SQLite transaction boundary: reduce + event + snapshot commit precedes publication. */
export class AgentThreadStore {
  private readonly snapshots = new Map<string, AgentThreadSnapshotType>()

  constructor(private readonly db: DatabaseSync) {}

  getSnapshot(threadId: string): AgentThreadSnapshotType | null {
    const cached = this.snapshots.get(threadId)
    if (cached) return cached
    const row = this.db.prepare("SELECT snapshot_json, snapshot_sequence FROM agent_threads WHERE thread_id=?").get(threadId) as
      | { snapshot_json: string; snapshot_sequence: number }
      | undefined
    if (!row) return null
    let snapshot = decode<AgentThreadSnapshotType>(AgentThreadSnapshot, row.snapshot_json)
    if (!snapshot) return null
    for (const event of this.listEvents(threadId, row.snapshot_sequence)) {
      const reduced = reduceAgentThreadEvent(snapshot, event)
      if (reduced.status === "applied") snapshot = reduced.snapshot
    }
    this.snapshots.set(threadId, snapshot)
    return snapshot
  }

  listSnapshots(projectSessionId?: string): AgentThreadSnapshotType[] {
    const rows = this.db.prepare("SELECT thread_id FROM agent_threads ORDER BY updated_at DESC").all() as Array<{ thread_id: string }>
    return rows.flatMap(row => {
      const snapshot = this.getSnapshot(row.thread_id)
      return snapshot && (!projectSessionId || snapshot.state.projectSessionId === projectSessionId) ? [snapshot] : []
    })
  }

  listEvents(threadId: string, after = 0): AgentEventEnvelopeType[] {
    const rows = this.db.prepare(
      "SELECT envelope_json FROM agent_thread_events WHERE thread_id=? AND sequence>? ORDER BY sequence",
    ).all(threadId, after) as Array<{ envelope_json: string }>
    return rows.flatMap(row => {
      const event = decode(AgentEventEnvelope, row.envelope_json)
      return event ? [event as AgentEventEnvelopeType] : []
    })
  }

  append(envelope: AgentEventEnvelopeType): {
    readonly snapshot: AgentThreadSnapshotType
    readonly applied: boolean
  } {
    const current = this.getSnapshot(envelope.threadId) ?? undefined
    const duplicate = this.db.prepare(
      "SELECT 1 FROM agent_thread_events WHERE thread_id=? AND event_id=?",
    ).get(envelope.threadId, envelope.eventId)
    if (duplicate && current) return { snapshot: current, applied: false }
    const reduced = reduceAgentThreadEvent(current, envelope)
    if (reduced.status === "rejected") {
      throw new Error(reduced.violations.map(v => v.message).join("; "))
    }
    if (reduced.status === "ignored") {
      return { snapshot: reduced.snapshot, applied: false }
    }
    const snapshot = reduced.snapshot
    const persistSnapshot = shouldPersistSnapshot(envelope)
    this.db.exec("BEGIN IMMEDIATE")
    try {
      if (!current || persistSnapshot) {
        this.db.prepare(
          `INSERT INTO agent_threads(thread_id, snapshot_json, snapshot_sequence, updated_at) VALUES(?,?,?,?)
           ON CONFLICT(thread_id) DO UPDATE SET snapshot_json=excluded.snapshot_json,
             snapshot_sequence=excluded.snapshot_sequence, updated_at=excluded.updated_at`,
        ).run(envelope.threadId, JSON.stringify(snapshot), envelope.sequence, envelope.receivedAt)
      } else {
        this.db.prepare("UPDATE agent_threads SET updated_at=? WHERE thread_id=?")
          .run(envelope.receivedAt, envelope.threadId)
      }
      this.db.prepare(
        "INSERT INTO agent_thread_events(thread_id, sequence, event_id, envelope_json) VALUES(?,?,?,?)",
      ).run(envelope.threadId, envelope.sequence, envelope.eventId, JSON.stringify(envelope))
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
    this.snapshots.set(String(envelope.threadId), snapshot)
    return { snapshot, applied: true }
  }

  getCommandState(threadId: string, commandId: string):
    | { readonly state: "pending" }
    | { readonly state: "completed"; readonly result: AgentCommandResultType }
    | null {
    const row = this.db.prepare(
      "SELECT state, result_json FROM agent_thread_commands WHERE thread_id=? AND command_id=?",
    ).get(threadId, commandId) as { state: string; result_json: string } | undefined
    if (!row) return null
    if (row.state === "pending") return { state: "pending" }
    const result = decode<AgentCommandResultType>(AgentCommandResult, row.result_json)
    return result ? { state: "completed", result } : null
  }

  getCommand(threadId: string, commandId: string): AgentCommandResultType | null {
    const command = this.getCommandState(threadId, commandId)
    return command?.state === "completed" ? command.result : null
  }

  claimCommand(threadId: string, command: AgentCommandEnvelopeType, now: string): boolean {
    const decoded = Schema.decodeUnknownSync(AgentCommandEnvelope)(command)
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO agent_thread_commands(
        thread_id, command_id, result_json, state, command_json, created_at
      ) VALUES(?,?,?,?,?,?)`,
    ).run(threadId, decoded.commandId, "null", "pending", JSON.stringify(decoded), now)
    return result.changes === 1
  }

  recordCommand(threadId: string, result: AgentCommandResultType, now: string): void {
    this.db.prepare(
      `INSERT INTO agent_thread_commands(thread_id, command_id, result_json, state, created_at)
       VALUES(?,?,?,'completed',?)
       ON CONFLICT(thread_id, command_id) DO UPDATE SET
         result_json=excluded.result_json, state='completed'`,
    ).run(threadId, result.commandId, JSON.stringify(result), now)
  }

  deleteThread(threadId: string): boolean {
    this.snapshots.delete(threadId)
    return this.db.prepare("DELETE FROM agent_threads WHERE thread_id=?").run(threadId).changes === 1
  }
}

const SNAPSHOT_INTERVAL = 32

function shouldPersistSnapshot(envelope: AgentEventEnvelopeType): boolean {
  if (envelope.sequence % SNAPSHOT_INTERVAL === 0) return true
  switch (envelope.event.type) {
    case "thread.opened":
    case "thread.closed":
    case "turn.completed":
    case "turn.failed":
    case "turn.interrupted":
    case "item.completed":
    case "action.requested":
    case "action.resolved":
    case "configuration.updated":
    case "capabilities.updated":
      return true
    default:
      return false
  }
}
