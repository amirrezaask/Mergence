import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { DatabaseSession } from "../database.js"
import { cliProviderDescriptor, isCliProvider } from "@yaade/shared"
import {
  getCliAgentDriver,
  listCliAgentDrivers,
  type AgentEvent,
  type AgentProvider,
} from "@yaade/agent-telemetry"
import { ensureAgentTelemetrySchema } from "./schema.js"

export type AgentRunProcessState =
  | "reserved"
  | "starting"
  | "running"
  | "exited"
  | "disconnected"

export type AgentRunActivityState =
  | "starting"
  | "working"
  | "running_tool"
  | "waiting_for_permission"
  | "waiting_for_user"
  | "idle"
  | "failed"

export type AgentRunTelemetryState =
  | "connecting"
  | "connected"
  | "degraded"
  | "process_only"

export type AgentRun = {
  runId: string
  launchRequestId: string
  generation: number
  provider: AgentProvider
  projectId: string
  workspaceId: string
  checkoutKey: string
  checkoutPath: string
  title: string
  ptyId: string | null
  nativeSessionId: string | null
  processState: AgentRunProcessState
  activityState: AgentRunActivityState
  telemetryState: AgentRunTelemetryState
  createdAt: string
  startedAt: string | null
  lastActivityAt: string | null
  endedAt: string | null
  exitCode: number | null
  endReason: string | null
  telemetryError: string | null
  revision: number
}

export type AgentRunEvent = {
  type: "agents.run"
  /** Compatibility routing key; equal to run.runId. */
  sessionId: string
  kind: "run.created" | "run.updated" | "run.ended"
  run: AgentRun
}

export type ReserveAgentRunInput = {
  launchRequestId: string
  provider: AgentProvider
  projectId: string
  workspaceId: string
  checkoutKey: string
  checkoutPath: string
  title: string
}

export type ProviderAvailability = {
  provider: AgentProvider
  available: boolean
  binary: string
  version: string | null
  capabilities: ReturnType<ReturnType<typeof getCliAgentDriver>["getCapabilities"]>
  error: string | null
}

type AgentRunRow = {
  run_id: string
  launch_request_id: string
  generation: number
  provider: string
  project_id: string
  workspace_id: string
  checkout_key: string
  checkout_path: string
  title: string
  pty_id: string | null
  native_session_id: string | null
  process_state: string
  activity_state: string
  telemetry_state: string
  created_at: string
  started_at: string | null
  last_activity_at: string | null
  ended_at: string | null
  exit_code: number | null
  end_reason: string | null
  telemetry_error: string | null
  revision: number
  transcript?: string
  transcript_truncated?: number
  removed_at?: string | null
}

const TELEMETRY_GRACE_MS = (() => {
  const raw = Number(process.env.JET_TELEMETRY_GRACE_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 10_000
})()
const PROVIDER_CACHE_MS = 30_000

function nowIso(): string {
  return new Date().toISOString()
}

function asProvider(value: string): AgentProvider | null {
  return isCliProvider(value) ? value : null
}

function asProcessState(value: string): AgentRunProcessState {
  switch (value) {
    case "reserved":
    case "starting":
    case "running":
    case "exited":
    case "disconnected":
      return value
    default:
      return "disconnected"
  }
}

function asActivityState(value: string): AgentRunActivityState {
  switch (value) {
    case "starting":
    case "working":
    case "running_tool":
    case "waiting_for_permission":
    case "waiting_for_user":
    case "idle":
    case "failed":
      return value
    default:
      return "idle"
  }
}

function asTelemetryState(value: string): AgentRunTelemetryState {
  switch (value) {
    case "connecting":
    case "connected":
    case "degraded":
    case "process_only":
      return value
    default:
      return "degraded"
  }
}

function rowToRun(row: AgentRunRow): AgentRun | null {
  const provider = asProvider(row.provider)
  if (!provider) return null
  return {
    runId: row.run_id,
    launchRequestId: row.launch_request_id,
    generation: row.generation,
    provider,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    checkoutKey: row.checkout_key,
    checkoutPath: row.checkout_path,
    title: row.title,
    ptyId: row.pty_id,
    nativeSessionId: row.native_session_id,
    processState: asProcessState(row.process_state),
    activityState: asActivityState(row.activity_state),
    telemetryState: asTelemetryState(row.telemetry_state),
    createdAt: row.created_at,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
    endReason: row.end_reason,
    telemetryError: row.telemetry_error,
    revision: row.revision,
  }
}

function processOnly(provider: AgentProvider): boolean {
  const caps = getCliAgentDriver(provider).getCapabilities()
  return !caps.sessionLifecycle && !caps.promptLifecycle && !caps.toolLifecycle && !caps.permissions
}

function activityForEvent(event: AgentEvent): AgentRunActivityState | null {
  switch (event.kind) {
    case "process.started":
    case "session.started":
    case "session.resumed":
    case "prompt.submitted":
    case "turn.started":
      return "working"
    case "tool.started":
      return "running_tool"
    case "permission.requested":
      return "waiting_for_permission"
    case "turn.completed":
    case "tool.completed":
    case "session.ended":
      return "idle"
    case "turn.failed":
    case "session.failed":
      return "failed"
    default:
      return null
  }
}

function resolveBinary(binary: string): string | null {
  if (path.isAbsolute(binary)) return fs.existsSync(binary) ? binary : null
  const delimiter = process.platform === "win32" ? ";" : ":"
  const suffixes = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""]
  for (const segment of (process.env.PATH ?? "").split(delimiter)) {
    const root = segment || process.cwd()
    for (const suffix of suffixes) {
      const candidate = path.join(root, `${binary}${suffix}`)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        /* next path entry */
      }
    }
  }
  return null
}

function versionFor(binary: string): { version: string | null; error: string | null } {
  try {
    const result = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 1_500,
      windowsHide: true,
    })
    if (result.error) return { version: null, error: result.error.message }
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim()
    if (result.status !== 0 && !output) {
      return { version: null, error: `--version exited ${result.status ?? "unknown"}` }
    }
    return { version: output.split(/\r?\n/, 1)[0]?.slice(0, 160) ?? null, error: null }
  } catch (error) {
    return { version: null, error: error instanceof Error ? error.message : String(error) }
  }
}

export class AgentRunService {
  private readonly telemetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private providerCache: { expiresAt: number; values: ProviderAvailability[] } | null = null

  constructor(
    private readonly db: DatabaseSession,
    private readonly emit: (event: AgentRunEvent) => void,
  ) {
    ensureAgentTelemetrySchema(db)
  }

  reserve(input: ReserveAgentRunInput): { run: AgentRun; created: boolean } {
    const existing = this.byLaunchRequestId(input.launchRequestId)
    if (existing) return { run: existing, created: false }
    const createdAt = nowIso()
    const runId = `run-${randomUUID()}`
    try {
      this.db.prepare(
        `INSERT INTO agent_runs(
          run_id, launch_request_id, generation, provider, project_id, workspace_id,
          checkout_key, checkout_path, title, pty_id, native_session_id,
          process_state, activity_state, telemetry_state, created_at, revision
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'reserved','starting','connecting',?,1)`,
      ).run(
        runId,
        input.launchRequestId,
        1,
        input.provider,
        input.projectId,
        input.workspaceId,
        input.checkoutKey,
        input.checkoutPath,
        input.title,
        null,
        null,
        createdAt,
      )
    } catch {
      const raced = this.byLaunchRequestId(input.launchRequestId)
      if (raced) return { run: raced, created: false }
      throw new Error("could not reserve agent run")
    }
    const run = this.get(runId)
    if (!run) throw new Error("agent run reservation was not persisted")
    this.emit({ type: "agents.run", sessionId: run.runId, kind: "run.created", run })
    return { run, created: true }
  }

  begin(runId: string, generation: number): AgentRun | null {
    const changed = this.db.prepare(
      `UPDATE agent_runs SET process_state='starting', activity_state='starting',
          revision=revision+1
        WHERE run_id=? AND generation=? AND process_state='reserved'`,
    ).run(runId, generation)
    if (Number(changed.changes) === 0) return this.get(runId)
    return this.updated(runId)
  }

  bindPty(runId: string, generation: number, ptyId: string): AgentRun | null {
    const current = this.get(runId)
    if (!current || current.generation !== generation) return null
    if (current.processState === "exited" || current.processState === "disconnected") return current
    const telemetryState: AgentRunTelemetryState = processOnly(current.provider)
      ? "process_only"
      : "connecting"
    const timestamp = nowIso()
    const changed = this.db.prepare(
      `UPDATE agent_runs
          SET pty_id=?, process_state='running', activity_state='starting',
              telemetry_state=?, started_at=COALESCE(started_at, ?),
              last_activity_at=?, telemetry_error=NULL, revision=revision+1
        WHERE run_id=? AND generation=? AND process_state IN ('reserved','starting','running')`,
    ).run(ptyId, telemetryState, timestamp, timestamp, runId, generation)
    if (Number(changed.changes) === 0) return this.get(runId)
    const run = this.updated(runId)
    if (run?.telemetryState === "connecting") this.scheduleTelemetryGrace(run)
    return run
  }

  failReservation(runId: string, generation: number, reason: string): AgentRun | null {
    this.clearTelemetryGrace(runId)
    const changed = this.db.prepare(
      `UPDATE agent_runs
          SET process_state='exited', activity_state='failed', telemetry_state='degraded',
              ended_at=COALESCE(ended_at, ?), end_reason=?, telemetry_error=?, revision=revision+1
        WHERE run_id=? AND generation=? AND process_state IN ('reserved','starting')`,
    ).run(nowIso(), "launch_failed", reason.slice(0, 512), runId, generation)
    return Number(changed.changes) === 0 ? this.get(runId) : this.ended(runId)
  }

  markTelemetryDegraded(runId: string, generation: number, reason: string): AgentRun | null {
    const run = this.get(runId)
    if (!run || run.generation !== generation || run.telemetryState === "process_only") {
      return run
    }
    const changed = this.db.prepare(
      `UPDATE agent_runs SET telemetry_state='degraded', telemetry_error=?, revision=revision+1
        WHERE run_id=? AND generation=? AND process_state IN ('reserved','starting','running')`,
    ).run(reason.slice(0, 512), runId, generation)
    return Number(changed.changes) === 0 ? this.get(runId) : this.updated(runId)
  }

  onPtyExit(ptyId: string, exitCode: number | null, expectedExit = false): AgentRun | null {
    const run = this.byPtyId(ptyId)
    if (!run) return null
    this.clearTelemetryGrace(run.runId)
    const reason = expectedExit || exitCode === 0 ? "completed" : "process_exit"
    const activity = expectedExit || exitCode === 0 ? "idle" : "failed"
    const changed = this.db.prepare(
      `UPDATE agent_runs
          SET process_state='exited', activity_state=?, ended_at=COALESCE(ended_at, ?),
              exit_code=COALESCE(?, exit_code), end_reason=COALESCE(end_reason, ?),
              revision=revision+1
        WHERE run_id=? AND generation=? AND pty_id=? AND process_state IN ('reserved','starting','running')`,
    ).run(activity, nowIso(), exitCode, reason, run.runId, run.generation, ptyId)
    return Number(changed.changes) === 0 ? this.get(run.runId) : this.ended(run.runId)
  }

  stop(runId: string, generation?: number): AgentRun | null {
    const run = this.get(runId)
    if (!run) return null
    if (generation != null && generation !== run.generation) return run
    if (run.processState === "exited" || run.processState === "disconnected") return run
    this.clearTelemetryGrace(runId)
    const changed = this.db.prepare(
      `UPDATE agent_runs SET process_state='exited', activity_state='idle',
          ended_at=COALESCE(ended_at, ?), end_reason=COALESCE(end_reason, 'stopped'),
          revision=revision+1
        WHERE run_id=? AND generation=? AND process_state IN ('reserved','starting','running')`,
    ).run(nowIso(), runId, run.generation)
    return Number(changed.changes) === 0 ? this.get(runId) : this.ended(runId)
  }

  /** Telemetry may enrich ended history, but never changes process state. */
  onTelemetry(event: AgentEvent): AgentRun | null {
    const run = this.get(event.sessionId)
    if (!run) return null
    if (event.processId && run.ptyId && event.processId !== run.ptyId) return run
    // Host process lifecycle is authoritative for liveness, but it is not
    // provider telemetry. Do not make a hook-less provider look connected.
    if (event.kind === "process.started" || event.kind === "process.exited") return run
    this.clearTelemetryGrace(run.runId)
    const activity = activityForEvent(event)
    const changed = this.db.prepare(
      `UPDATE agent_runs
          SET native_session_id=COALESCE(NULLIF(?, ''), native_session_id),
              telemetry_state=CASE WHEN telemetry_state='process_only' THEN telemetry_state ELSE 'connected' END,
              activity_state=CASE WHEN process_state IN ('exited','disconnected') THEN activity_state ELSE COALESCE(?, activity_state) END,
              last_activity_at=?, revision=revision+1
        WHERE run_id=? AND generation=?`,
    ).run(
      event.nativeSessionId,
      activity,
      event.receivedAt || nowIso(),
      run.runId,
      run.generation,
    )
    return Number(changed.changes) === 0 ? this.get(run.runId) : this.updated(run.runId)
  }

  get(runId: string): AgentRun | null {
    const row = this.db.prepare(
      `SELECT * FROM agent_runs WHERE run_id=?`,
    ).get(runId) as AgentRunRow | undefined
    return row ? rowToRun(row) : null
  }

  byLaunchRequestId(launchRequestId: string): AgentRun | null {
    const row = this.db.prepare(
      `SELECT * FROM agent_runs WHERE launch_request_id=?`,
    ).get(launchRequestId) as AgentRunRow | undefined
    return row ? rowToRun(row) : null
  }

  byPtyId(ptyId: string): AgentRun | null {
    const row = this.db.prepare(
      `SELECT * FROM agent_runs WHERE pty_id=? ORDER BY revision DESC LIMIT 1`,
    ).get(ptyId) as AgentRunRow | undefined
    return row ? rowToRun(row) : null
  }

  listLive(projectId?: string): AgentRun[] {
    const rows = (projectId
      ? this.db.prepare(
          `SELECT * FROM agent_runs
             WHERE project_id=? AND removed_at IS NULL AND process_state IN ('starting','running')
             ORDER BY started_at DESC, created_at DESC`,
        ).all(projectId)
      : this.db.prepare(
          `SELECT * FROM agent_runs
             WHERE removed_at IS NULL AND process_state IN ('starting','running')
             ORDER BY started_at DESC, created_at DESC`,
        ).all()) as AgentRunRow[]
    return rows.flatMap(row => {
      const run = rowToRun(row)
      return run ? [run] : []
    })
  }

  listProject(projectId: string): AgentRun[] {
    const rows = this.db.prepare(
      `SELECT * FROM agent_runs WHERE project_id=? AND removed_at IS NULL
        ORDER BY created_at DESC, run_id DESC`,
    ).all(projectId) as AgentRunRow[]
    return rows.flatMap(row => {
      const run = rowToRun(row)
      return run ? [run] : []
    })
  }

  listLiveForCheckout(checkoutPath: string): AgentRun[] {
    const rows = this.db.prepare(
      `SELECT * FROM agent_runs WHERE checkout_path=? AND removed_at IS NULL
        AND process_state IN ('starting','running')`,
    ).all(checkoutPath) as AgentRunRow[]
    return rows.flatMap(row => {
      const run = rowToRun(row)
      return run ? [run] : []
    })
  }

  storeTranscript(ptyId: string, output: string, truncated = false): void {
    const bytes = Buffer.from(output, "utf8")
    const limit = 256 * 1024
    const bounded = bytes.byteLength <= limit
      ? output
      : bytes.subarray(bytes.byteLength - limit).toString("utf8")
    this.db.prepare(
      `UPDATE agent_runs SET transcript=?, transcript_truncated=?, revision=revision+1
        WHERE pty_id=? AND removed_at IS NULL`,
    ).run(bounded, truncated || bytes.byteLength > limit ? 1 : 0, ptyId)
  }

  transcript(runId: string): { output: string; truncated: boolean } | null {
    const row = this.db.prepare(
      `SELECT transcript, transcript_truncated FROM agent_runs
        WHERE run_id=? AND removed_at IS NULL`,
    ).get(runId) as { transcript: string; transcript_truncated: number } | undefined
    return row ? { output: row.transcript, truncated: row.transcript_truncated === 1 } : null
  }

  close(runId: string, generation?: number): AgentRun | null {
    const run = this.get(runId)
    if (!run) return null
    if (generation != null && generation !== run.generation) return run
    this.clearTelemetryGrace(runId)
    const changed = this.db.prepare(
      `UPDATE agent_runs SET process_state=CASE
            WHEN process_state IN ('reserved','starting','running') THEN 'exited' ELSE process_state END,
          activity_state=CASE WHEN process_state IN ('reserved','starting','running') THEN 'idle' ELSE activity_state END,
          ended_at=COALESCE(ended_at, ?), end_reason=COALESCE(end_reason, 'closed'),
          transcript='', transcript_truncated=0, removed_at=?, revision=revision+1
        WHERE run_id=? AND generation=? AND removed_at IS NULL`,
    ).run(nowIso(), nowIso(), runId, run.generation)
    if (Number(changed.changes) === 0) return this.get(runId)
    const removed = this.db.prepare("SELECT * FROM agent_runs WHERE run_id=?").get(runId) as AgentRunRow | undefined
    const result = removed ? rowToRun(removed) : null
    if (result) this.emit({ type: "agents.run", sessionId: result.runId, kind: "run.ended", run: result })
    return result
  }

  listActivity(input?: { limit?: number; cursor?: string; projectId?: string }): {
    runs: AgentRun[]
    nextCursor: string | null
  } {
    const limit = Math.min(Math.max(input?.limit ?? 100, 1), 200)
    const cursor = input?.cursor ? decodeCursor(input.cursor) : null
    const clauses = ["process_state IN ('exited','disconnected')"]
    const params: Array<string | number> = []
    if (input?.projectId) {
      clauses.push("project_id=?")
      params.push(input.projectId)
    }
    if (cursor) {
      clauses.push("(COALESCE(ended_at, created_at) < ? OR (COALESCE(ended_at, created_at) = ? AND run_id < ?))")
      params.push(cursor.at, cursor.at, cursor.runId)
    }
    params.push(limit + 1)
    const rows = this.db.prepare(
      `SELECT * FROM agent_runs WHERE ${clauses.join(" AND ")}
         ORDER BY COALESCE(ended_at, created_at) DESC, run_id DESC LIMIT ?`,
    ).all(...params) as AgentRunRow[]
    const page = rows.slice(0, limit).flatMap(row => {
      const run = rowToRun(row)
      return run ? [run] : []
    })
    const tail = page.at(-1)
    return {
      runs: page,
      nextCursor: rows.length > limit && tail ? encodeCursor(tail.endedAt ?? tail.createdAt, tail.runId) : null,
    }
  }

  listProviders(refresh = false): ProviderAvailability[] {
    if (!refresh && this.providerCache && this.providerCache.expiresAt > Date.now()) {
      return this.providerCache.values
    }
    const values = listCliAgentDrivers().map(driver => {
      const binary = cliProviderDescriptor(driver.provider).binary
      const resolved = resolveBinary(binary)
      const detail = resolved ? versionFor(resolved) : { version: null, error: `${binary} is not on PATH` }
      return {
        provider: driver.provider,
        available: Boolean(resolved),
        binary,
        version: detail.version,
        capabilities: driver.getCapabilities(),
        error: detail.error,
      }
    })
    this.providerCache = { values, expiresAt: Date.now() + PROVIDER_CACHE_MS }
    return values
  }

  providerAvailable(provider: AgentProvider): ProviderAvailability {
    return this.listProviders(true).find(item => item.provider === provider) ?? {
      provider,
      available: false,
      binary: cliProviderDescriptor(provider).binary,
      version: null,
      capabilities: getCliAgentDriver(provider).getCapabilities(),
      error: "unknown provider",
    }
  }

  private scheduleTelemetryGrace(run: AgentRun): void {
    this.clearTelemetryGrace(run.runId)
    this.telemetryTimers.set(run.runId, setTimeout(() => {
      const current = this.get(run.runId)
      if (!current || current.generation !== run.generation) return
      if (current.processState !== "running" || current.telemetryState !== "connecting") return
      const changed = this.db.prepare(
        `UPDATE agent_runs SET telemetry_state='degraded', telemetry_error='No provider telemetry received within 10 seconds', revision=revision+1
          WHERE run_id=? AND generation=? AND process_state='running' AND telemetry_state='connecting'`,
      ).run(run.runId, run.generation)
      if (Number(changed.changes) > 0) this.updated(run.runId)
    }, TELEMETRY_GRACE_MS))
  }

  private clearTelemetryGrace(runId: string): void {
    const timer = this.telemetryTimers.get(runId)
    if (timer) clearTimeout(timer)
    this.telemetryTimers.delete(runId)
  }

  private updated(runId: string): AgentRun | null {
    const run = this.get(runId)
    if (run) this.emit({ type: "agents.run", sessionId: run.runId, kind: "run.updated", run })
    return run
  }

  private ended(runId: string): AgentRun | null {
    const run = this.get(runId)
    if (run) this.emit({ type: "agents.run", sessionId: run.runId, kind: "run.ended", run })
    return run
  }
}

function encodeCursor(at: string, runId: string): string {
  return Buffer.from(JSON.stringify({ at, runId })).toString("base64url")
}

function decodeCursor(value: string): { at: string; runId: string } | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    if (
      decoded && typeof decoded === "object" &&
      "at" in decoded && typeof decoded.at === "string" &&
      "runId" in decoded && typeof decoded.runId === "string"
    ) return { at: decoded.at, runId: decoded.runId }
  } catch {
    /* invalid cursors are treated as the first page */
  }
  return null
}
