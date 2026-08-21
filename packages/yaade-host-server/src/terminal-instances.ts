import { randomUUID } from "node:crypto";
import type { DatabaseSession } from "./database.js";
import type { AgentEvent, AgentProvider } from "@yaade/agent-telemetry";
import { tryDecodeProjectSessionPayload } from "@yaade/rpc";
import { fileUriToPath, isCliProvider } from "@yaade/shared";
import {
  matchesProcessIdentity,
  type ProcessIdentity,
} from "@yaade/node-host";

export type TerminalInstanceState =
  | "starting"
  | "running"
  | "exited"
  | "failed"
  | "disconnected"
  | "interrupted"
  | "restoring"
  | "orphaned";

export type TerminalInstanceActivityState =
  | "starting"
  | "working"
  | "running_tool"
  | "waiting_for_permission"
  | "waiting_for_user"
  | "idle"
  | "failed";

export type TerminalInstanceTelemetryState =
  | "connecting"
  | "connected"
  | "degraded"
  | "process_only";

export type TerminalLaunchProfile = {
  schemaVersion: 1
  provider: AgentProvider | null
  executable?: string
  args: string[]
  cwd: string
  projectId: string
  workspaceId: string | null
  restartPolicy: "never" | "manual" | "resume-on-daemon-start"
}

export type NativeAgentSessionRef = {
  provider: AgentProvider
  kind: string
  value: string
  capturedAt: string
  driverVersion: number
}

export type TerminalInstance = {
  id: string;
  generation: number;
  projectId: string;
  workspaceId: string | null;
  toolUseId: string | null;
  checkoutKey: string;
  checkoutPath: string;
  title: string;
  provider: AgentProvider | null;
  launchRequestId: string | null;
  ptyId: string | null;
  nativeSessionId: string | null;
  processIdentity: ProcessIdentity | null;
  terminalEpoch: string | null;
  launchProfile: TerminalLaunchProfile | null;
  nativeSessionRef: NativeAgentSessionRef | null;
  restartPolicy: "never" | "manual" | "resume-on-daemon-start";
  processState: TerminalInstanceState;
  activityState: TerminalInstanceActivityState;
  telemetryState: TerminalInstanceTelemetryState;
  createdAt: string;
  startedAt: string | null;
  lastActivityAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  endReason: string | null;
  telemetryError: string | null;
  revision: number;
};

export type TerminalInstanceEvent = {
  type: "terminal.instance";
  kind:
    | "instance.created"
    | "instance.updated"
    | "instance.ended"
    | "instance.removed";
  instance: TerminalInstance;
};

type TerminalInstanceRow = {
  id: string;
  generation: number;
  project_id: string;
  workspace_id: string | null;
  tool_use_id: string | null;
  checkout_key: string;
  checkout_path: string;
  title: string;
  provider: string | null;
  launch_request_id: string | null;
  pty_id: string | null;
  native_session_id: string | null;
  process_identity_json: string | null;
  terminal_epoch: string | null;
  launch_profile_json: string | null;
  native_session_ref_json: string | null;
  restart_policy: string;
  process_state: string;
  activity_state: string;
  telemetry_state: string;
  created_at: string;
  started_at: string | null;
  last_activity_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  end_reason: string | null;
  telemetry_error: string | null;
  revision: number;
};

const FINAL_TRANSCRIPT_BYTES = 256 * 1024;
const TELEMETRY_GRACE_MS = (() => {
  const raw = Number(process.env.JET_TELEMETRY_GRACE_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 10_000;
})();

function nowIso(): string {
  return new Date().toISOString();
}

function asProvider(value: string | null | undefined): AgentProvider | null {
  return isCliProvider(value) ? value : null;
}

function state(value: string): TerminalInstanceState {
  switch (value) {
    case "starting":
    case "running":
    case "exited":
    case "failed":
    case "disconnected":
    case "interrupted":
    case "restoring":
    case "orphaned":
      return value;
    default:
      return "interrupted";
  }
}

function processIdentity(value: string | null | undefined): ProcessIdentity | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.pid !== "number" ||
      typeof record.platform !== "string" ||
      typeof record.startToken !== "string"
    ) return null;
    if (
      record.platform !== "linux" &&
      record.platform !== "darwin" &&
      record.platform !== "windows"
    ) return null;
    return {
      pid: record.pid,
      platform: record.platform,
      startToken: record.startToken,
      ...(typeof record.bootId === "string" ? { bootId: record.bootId } : {}),
      ...(typeof record.executablePath === "string"
        ? { executablePath: record.executablePath }
        : {}),
    };
  } catch {
    return null;
  }
}

function launchProfile(value: string | null | undefined): TerminalLaunchProfile | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (
      record.schemaVersion !== 1 ||
      typeof record.cwd !== "string" ||
      typeof record.projectId !== "string" ||
      !Array.isArray(record.args)
    ) return null
    const policy = record.restartPolicy
    if (policy !== "never" && policy !== "manual" && policy !== "resume-on-daemon-start") return null
    const provider =
      record.provider === null
        ? null
        : typeof record.provider === "string"
          ? asProvider(record.provider)
          : undefined
    if (provider === undefined) return null
    return {
      schemaVersion: 1,
      provider,
      ...(typeof record.executable === "string" ? { executable: record.executable } : {}),
      args: record.args.filter((item): item is string => typeof item === "string"),
      cwd: record.cwd,
      projectId: record.projectId,
      workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : null,
      restartPolicy: policy,
    }
  } catch {
    return null
  }
}

function nativeSessionRef(value: string | null | undefined): NativeAgentSessionRef | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const provider =
      typeof record.provider === "string" ? asProvider(record.provider) : null
    if (
      !provider ||
      typeof record.kind !== "string" ||
      typeof record.value !== "string" ||
      typeof record.capturedAt !== "string" ||
      typeof record.driverVersion !== "number"
    ) return null
    return {
      provider,
      kind: record.kind,
      value: record.value,
      capturedAt: record.capturedAt,
      driverVersion: record.driverVersion,
    }
  } catch {
    return null
  }
}

function restartPolicy(value: string | null | undefined): TerminalInstance["restartPolicy"] {
  return value === "never" || value === "resume-on-daemon-start" ? value : "manual"
}

function asActivityState(
  value: string | null | undefined,
): TerminalInstanceActivityState {
  switch (value) {
    case "starting":
    case "working":
    case "running_tool":
    case "waiting_for_permission":
    case "waiting_for_user":
    case "idle":
    case "failed":
      return value;
    default:
      return "idle";
  }
}

function asTelemetryState(
  value: string | null | undefined,
): TerminalInstanceTelemetryState {
  switch (value) {
    case "connecting":
    case "connected":
    case "degraded":
    case "process_only":
      return value;
    default:
      return "degraded";
  }
}

function activityForEvent(
  event: AgentEvent,
): TerminalInstanceActivityState | null {
  switch (event.kind) {
    case "process.started":
    case "session.started":
    case "session.resumed":
    case "prompt.submitted":
    case "turn.started":
      return "working";
    case "tool.started":
      return "running_tool";
    case "permission.requested":
      return "waiting_for_permission";
    case "turn.completed":
    case "tool.completed":
    case "session.ended":
      return "idle";
    case "turn.failed":
    case "session.failed":
      return "failed";
    default:
      return null;
  }
}

function toInstance(row: TerminalInstanceRow): TerminalInstance {
  return {
    id: row.id,
    generation: row.generation,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    toolUseId: row.tool_use_id,
    checkoutKey: row.checkout_key,
    checkoutPath: row.checkout_path,
    title: row.title,
    provider: asProvider(row.provider),
    launchRequestId: row.launch_request_id,
    ptyId: row.pty_id,
    nativeSessionId: row.native_session_id,
    processIdentity: processIdentity(row.process_identity_json),
    terminalEpoch: row.terminal_epoch,
    launchProfile: launchProfile(row.launch_profile_json),
    nativeSessionRef: nativeSessionRef(row.native_session_ref_json),
    restartPolicy: restartPolicy(row.restart_policy),
    processState: state(row.process_state),
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
  };
}

function boundedTranscript(output: string): {
  output: string;
  truncated: number;
} {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.byteLength <= FINAL_TRANSCRIPT_BYTES)
    return { output, truncated: 0 };
  return {
    output: bytes
      .subarray(bytes.byteLength - FINAL_TRANSCRIPT_BYTES)
      .toString("utf8"),
    truncated: 1,
  };
}

function tableHasColumn(
  db: DatabaseSession,
  table: string,
  column: string,
): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === column);
}

export class TerminalInstanceService {
  private readonly telemetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly db: DatabaseSession,
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
    `);
    this.ensureProcessColumns();
    db.prepare(
      "INSERT OR IGNORE INTO schema_migrations(version) VALUES(12)",
    ).run();
    this.backfillLegacyProjectTerminals();
    this.migrateAgentRuns();
  }

  /**
   * Reconcile durable rows against the PTY supervisor's authoritative list.
   * A missing identity is never used to signal a numeric PID. Rows whose
   * process may still exist but no longer have an owner are explicitly marked
   * interrupted/orphaned instead of being reported as running.
   */
  reconcileHostStart(livePtyIds: ReadonlySet<string>): void {
    const rows = this.db
      .prepare(
        `SELECT id, pty_id, provider, native_session_ref_json, process_identity_json
           FROM terminal_instances
          WHERE removed_at IS NULL AND process_state IN ('starting','running')`,
      )
      .all() as Array<{
      id: string
      pty_id: string | null
      provider: string | null
      native_session_ref_json: string | null
      process_identity_json: string | null
    }>;
    const now = nowIso();
    for (const row of rows) {
      if (row.pty_id && livePtyIds.has(row.pty_id)) continue;
      const identity = processIdentity(row.process_identity_json);
      const canNativeResume = Boolean(row.provider && row.native_session_ref_json);
      const nextState = identity && matchesProcessIdentity(identity)
        ? "interrupted"
        : canNativeResume
          ? "interrupted"
          : identity
            ? "orphaned"
            : "disconnected";
      this.db
        .prepare(
          `UPDATE terminal_instances
              SET process_state=?, ended_at=COALESCE(ended_at, ?),
                  end_reason=COALESCE(end_reason, 'host_restart'), revision=revision+1
            WHERE id=?`,
        )
        .run(nextState, now, row.id);
      this.updated(row.id, "instance.updated");
    }
  }

  dispose(): void {
    for (const timer of this.telemetryTimers.values()) clearTimeout(timer);
    this.telemetryTimers.clear();
  }

  /** A supervisor connection can be temporarily unavailable while the PTY remains owned. */
  markSupervisorDisconnected(reason: string): void {
    const rows = this.db
      .prepare(
        `SELECT id FROM terminal_instances
           WHERE removed_at IS NULL AND process_state IN ('starting','running')`,
      )
      .all() as Array<{ id: string }>;
    for (const row of rows) {
      const changed = this.db
        .prepare(
          `UPDATE terminal_instances
              SET process_state='disconnected', end_reason=?, revision=revision+1
            WHERE id=? AND removed_at IS NULL
              AND process_state IN ('starting','running')`,
        )
        .run(reason.slice(0, 512), row.id);
      if (Number(changed.changes) > 0) this.updated(row.id, "instance.updated");
    }
  }

  markSupervisorRecovered(livePtyIds: ReadonlySet<string>): void {
    const rows = this.db
      .prepare(
        `SELECT id, pty_id FROM terminal_instances
           WHERE removed_at IS NULL AND process_state='disconnected'`,
      )
      .all() as Array<{ id: string; pty_id: string | null }>;
    for (const row of rows) {
      if (!row.pty_id || !livePtyIds.has(row.pty_id)) continue;
      const changed = this.db
        .prepare(
          `UPDATE terminal_instances
              SET process_state='running', ended_at=NULL, end_reason=NULL, revision=revision+1
            WHERE id=? AND process_state='disconnected'`,
        )
        .run(row.id);
      if (Number(changed.changes) > 0) this.updated(row.id, "instance.updated");
    }
  }

  markRestoreFailed(id: string, generation: number, reason: string): TerminalInstance | null {
    const changed = this.db
      .prepare(
        `UPDATE terminal_instances
            SET process_state='failed', ended_at=COALESCE(ended_at, ?),
                end_reason=?, telemetry_error=?, revision=revision+1
          WHERE id=? AND generation=? AND removed_at IS NULL
            AND process_state IN ('interrupted','restoring','starting')`,
      )
      .run(nowIso(), reason.slice(0, 512), reason.slice(0, 512), id, generation);
    return Number(changed.changes) === 0
      ? this.get(id)
      : this.updated(id, "instance.ended");
  }

  markSupervisorInterrupted(reason: string): void {
    const rows = this.db
      .prepare(
        `SELECT id FROM terminal_instances
           WHERE removed_at IS NULL AND process_state IN ('starting','running','disconnected')`,
      )
      .all() as Array<{ id: string }>;
    const message = reason.slice(0, 512);
    for (const row of rows) {
      const changed = this.db
        .prepare(
          `UPDATE terminal_instances
              SET process_state='interrupted', ended_at=COALESCE(ended_at, ?),
                  end_reason=COALESCE(end_reason, ?), revision=revision+1
            WHERE id=? AND removed_at IS NULL
              AND process_state IN ('starting','running','disconnected')`,
        )
        .run(nowIso(), message, row.id);
      if (Number(changed.changes) > 0) this.updated(row.id, "instance.updated");
    }
  }

  reserve(input: {
    projectId: string;
    checkoutKey: string;
    checkoutPath: string;
    title: string;
    id?: string;
    generation?: number;
    provider?: AgentProvider | null;
    workspaceId?: string | null;
    launchRequestId?: string | null;
    activityState?: TerminalInstanceActivityState;
    telemetryState?: TerminalInstanceTelemetryState;
    launchProfile?: TerminalLaunchProfile | null;
    nativeSessionRef?: NativeAgentSessionRef | null;
    restartPolicy?: TerminalInstance["restartPolicy"];
  }): TerminalInstance {
    if (input.launchRequestId) {
      const existing = this.byLaunchRequestId(input.launchRequestId);
      if (existing) return existing;
    }
    const id = input.id ?? `proc-${randomUUID()}`;
    const generation = input.generation ?? 1;
    const createdAt = nowIso();
    const provider = input.provider ?? null;
    try {
      this.db
        .prepare(
          `INSERT INTO terminal_instances(
          id,generation,project_id,workspace_id,checkout_key,checkout_path,title,
          provider,launch_request_id,process_state,activity_state,telemetry_state,created_at,revision
        ) VALUES(?,?,?,?,?,?,?,?,?,'starting',?,?,?,1)`,
        )
        .run(
          id,
          generation,
          input.projectId,
          input.workspaceId ?? null,
          input.checkoutKey,
          input.checkoutPath,
          input.title,
          provider,
          input.launchRequestId ?? null,
          input.activityState ?? (provider ? "starting" : "idle"),
          input.telemetryState ?? (provider ? "connecting" : "process_only"),
          createdAt,
        );
    } catch (error) {
      if (input.launchRequestId) {
        const raced = this.byLaunchRequestId(input.launchRequestId);
        if (raced) return raced;
      }
      throw error;
    }
    if (input.launchProfile || input.nativeSessionRef || input.restartPolicy) {
      this.db
        .prepare(
          `UPDATE terminal_instances
              SET launch_profile_json=?, native_session_ref_json=?, restart_policy=?, revision=revision+1
            WHERE id=?`,
        )
        .run(
          input.launchProfile ? JSON.stringify(input.launchProfile) : null,
          input.nativeSessionRef ? JSON.stringify(input.nativeSessionRef) : null,
          input.restartPolicy ?? input.launchProfile?.restartPolicy ?? "manual",
          id,
        );
    }
    const instance = this.get(id);
    if (!instance)
      throw new Error("terminal instance reservation was not persisted");
    this.emit({
      type: "terminal.instance",
      kind: "instance.created",
      instance,
    });
    return instance;
  }

  bindToolUse(id: string, toolUseId: string): boolean {
    const changed = this.db
      .prepare(
        "UPDATE terminal_instances SET tool_use_id=? WHERE id=? AND removed_at IS NULL AND tool_use_id IS NULL",
      )
      .run(toolUseId, id);
    return Number(changed.changes) > 0;
  }

  /** Associate an existing generic terminal with a discovered agent CLI. */
  promoteToAgent(
    id: string,
    generation: number,
    provider: AgentProvider,
    title: string,
    telemetryState: TerminalInstanceTelemetryState = "connecting",
  ): TerminalInstance | null {
    const current = this.get(id);
    if (
      !current ||
      current.generation !== generation ||
      current.processState !== "running"
    ) {
      return current;
    }
    const changed = this.db
      .prepare(
        `UPDATE terminal_instances SET provider=?, title=?, activity_state='starting',
          telemetry_state=?, telemetry_error=NULL, revision=revision+1
        WHERE id=? AND generation=? AND removed_at IS NULL AND provider IS NULL
          AND process_state='running'`,
      )
      .run(provider, title, telemetryState, id, generation);
    const promoted = Number(changed.changes) === 0
      ? this.get(id)
      : this.updated(id, "instance.updated");
    if (promoted?.telemetryState === "connecting") {
      this.scheduleTelemetryGrace(promoted);
    }
    return promoted;
  }

  unbindToolUse(toolUseId: string): void {
    this.db
      .prepare(
        "UPDATE terminal_instances SET tool_use_id=NULL WHERE tool_use_id=?",
      )
      .run(toolUseId);
  }

  /** Keep a terminal ToolUse alive after its foreground agent returns to the shell. */
  demoteToTerminal(id: string, generation: number): TerminalInstance | null {
    this.clearTelemetryGrace(id)
    const changed = this.db
      .prepare(
        `UPDATE terminal_instances SET provider=NULL, native_session_id=NULL,
          activity_state='idle', telemetry_state='process_only', telemetry_error=NULL,
          revision=revision+1
        WHERE id=? AND generation=? AND removed_at IS NULL AND process_state='running'`,
      )
      .run(id, generation);
    return Number(changed.changes) === 0
      ? this.get(id)
      : this.updated(id, "instance.updated");
  }

  bindPty(
    id: string,
    generation: number,
    ptyId: string,
    title?: string | null,
    telemetryState?: TerminalInstanceTelemetryState,
    identity?: ProcessIdentity | null,
    terminalEpoch?: string,
  ): TerminalInstance | null {
    const current = this.get(id);
    if (!current || current.generation !== generation) return null;
    const nextTelemetry =
      telemetryState ??
      (current.provider ? current.telemetryState : "process_only");
    const timestamp = nowIso();
    const changed = this.db
      .prepare(
        `UPDATE terminal_instances SET pty_id=?, title=COALESCE(NULLIF(?, ''), title),
          process_state='running',
          activity_state=CASE WHEN provider IS NOT NULL THEN 'starting' ELSE activity_state END,
          telemetry_state=?, started_at=?, last_activity_at=?, ended_at=NULL,
          exit_code=NULL, end_reason=NULL, transcript='', transcript_truncated=0,
          telemetry_error=NULL, os_pid=?, os_started_at_ms=?, process_identity_json=?, terminal_epoch=?, revision=revision+1
        WHERE id=? AND generation=? AND removed_at IS NULL
          AND process_state IN ('starting','disconnected')`,
      )
      .run(
        ptyId,
        title ?? null,
        nextTelemetry,
        timestamp,
        timestamp,
        identity?.pid ?? null,
        null,
        identity ? JSON.stringify(identity) : null,
        terminalEpoch ?? null,
        id,
        generation,
      );
    const bound =
      Number(changed.changes) === 0
        ? this.get(id)
        : this.updated(id, "instance.updated");
    if (bound?.provider && bound.telemetryState === "connecting") {
      this.scheduleTelemetryGrace(bound);
    }
    return bound;
  }

  fail(
    id: string,
    generation: number,
    reason: string,
  ): TerminalInstance | null {
    this.clearTelemetryGrace(id);
    const changed = this.db
      .prepare(
        `UPDATE terminal_instances SET process_state='failed',
          activity_state=CASE WHEN provider IS NOT NULL THEN 'failed' ELSE activity_state END,
          ended_at=?, end_reason=?, telemetry_error=?, revision=revision+1
        WHERE id=? AND generation=? AND removed_at IS NULL AND process_state='starting'`,
      )
      .run(
        nowIso(),
        reason.slice(0, 512),
        reason.slice(0, 512),
        id,
        generation,
      );
    return Number(changed.changes) === 0
      ? this.get(id)
      : this.updated(id, "instance.ended");
  }

  /**
   * A create retry after API/supervisor loss may find a reservation that never
   * bound a PTY. Reset it to `starting` so bindPty can complete idempotently.
   */
  reopenForLaunch(id: string, generation: number): TerminalInstance | null {
    const current = this.get(id);
    if (!current || current.generation !== generation) return null;
    if (current.ptyId && current.processState === "running") return current;
    const changed = this.db
      .prepare(
        `UPDATE terminal_instances
            SET process_state='starting', ended_at=NULL, end_reason=NULL,
                telemetry_error=NULL, revision=revision+1
          WHERE id=? AND generation=? AND removed_at IS NULL
            AND pty_id IS NULL
            AND process_state IN ('starting','disconnected','failed','interrupted','orphaned')`,
      )
      .run(id, generation);
    return Number(changed.changes) === 0 ? this.get(id) : this.updated(id, "instance.updated");
  }

  markTelemetryDegraded(
    id: string,
    generation: number,
    reason: string,
  ): TerminalInstance | null {
    const current = this.get(id);
    if (
      !current ||
      current.generation !== generation ||
      current.telemetryState === "process_only"
    ) {
      return current;
    }
    const changed = this.db
      .prepare(
        `UPDATE terminal_instances SET telemetry_state='degraded', telemetry_error=?, revision=revision+1
        WHERE id=? AND generation=? AND process_state IN ('starting','running')`,
      )
      .run(reason.slice(0, 512), id, generation);
    return Number(changed.changes) === 0
      ? this.get(id)
      : this.updated(id, "instance.updated");
  }

  onTelemetry(event: AgentEvent): TerminalInstance | null {
    const current = this.get(event.sessionId);
    if (!current || !current.provider) return null;
    if (event.processId && current.ptyId && event.processId !== current.ptyId)
      return current;
    if (event.kind === "process.started" || event.kind === "process.exited")
      return current;
    this.clearTelemetryGrace(current.id);
    const activity = activityForEvent(event);
    const changed = this.db
      .prepare(
        `UPDATE terminal_instances
          SET native_session_id=COALESCE(NULLIF(?, ''), native_session_id),
              native_session_ref_json=CASE WHEN NULLIF(?, '') IS NULL THEN native_session_ref_json ELSE ? END,
              telemetry_state=CASE WHEN telemetry_state='process_only' THEN telemetry_state ELSE 'connected' END,
              activity_state=CASE WHEN process_state IN ('exited','disconnected','failed') THEN activity_state ELSE COALESCE(?, activity_state) END,
              last_activity_at=?, revision=revision+1
        WHERE id=? AND generation=?`,
      )
      .run(
        event.nativeSessionId ?? null,
        event.nativeSessionId ?? null,
        event.nativeSessionId
          ? JSON.stringify({
              provider: current.provider,
              kind: "session",
              value: event.nativeSessionId,
              capturedAt: event.receivedAt || nowIso(),
              driverVersion: 1,
            })
          : null,
        activity,
        event.receivedAt || nowIso(),
        current.id,
        current.generation,
      );
    return Number(changed.changes) === 0
      ? this.get(current.id)
      : this.updated(current.id, "instance.updated");
  }

  onPtyExit(
    ptyId: string,
    exitCode: number | null,
    output: string,
    truncated = false,
  ): TerminalInstance | null {
    const current = this.byPtyId(ptyId);
    if (!current) return null;
    this.clearTelemetryGrace(current.id);
    const transcript = boundedTranscript(output);
    const activity = exitCode === 0 ? "idle" : "failed";
    const failedResume =
      (exitCode ?? 0) !== 0 &&
      current.provider != null &&
      current.activityState === "starting";
    const processState = failedResume ? "failed" : "exited";
    const changed = this.db
      .prepare(
        `UPDATE terminal_instances SET process_state=?,
          activity_state=CASE WHEN provider IS NOT NULL THEN ? ELSE activity_state END,
          ended_at=COALESCE(ended_at, ?),
          exit_code=COALESCE(?, exit_code), end_reason=COALESCE(end_reason, 'process_exit'),
          transcript=?, transcript_truncated=?, revision=revision+1
        WHERE id=? AND generation=? AND pty_id=? AND removed_at IS NULL
          AND process_state IN ('starting','running')`,
      )
      .run(
        processState,
        activity,
        nowIso(),
        exitCode,
        transcript.output,
        truncated || transcript.truncated === 1 ? 1 : 0,
        current.id,
        current.generation,
        ptyId,
      );
    return Number(changed.changes) === 0
      ? this.get(current.id)
      : this.updated(current.id, "instance.ended");
  }

  beginRestart(id: string, generation: number): TerminalInstance | null {
    this.clearTelemetryGrace(id);
    const changed = this.db
      .prepare(
        `UPDATE terminal_instances SET generation=generation+1, pty_id=NULL,
          terminal_epoch=NULL, process_state='starting',
          activity_state=CASE WHEN provider IS NOT NULL THEN 'starting' ELSE activity_state END,
          telemetry_state=CASE WHEN provider IS NOT NULL THEN 'connecting' ELSE telemetry_state END,
          started_at=NULL, last_activity_at=NULL, ended_at=NULL,
          exit_code=NULL, end_reason=NULL, transcript='', transcript_truncated=0,
          telemetry_error=NULL, revision=revision+1
        WHERE id=? AND generation=? AND removed_at IS NULL
          AND process_state IN ('starting','running','exited','failed','disconnected','interrupted','restoring','orphaned')`,
      )
      .run(id, generation);
    return Number(changed.changes) === 0
      ? this.get(id)
      : this.updated(id, "instance.updated");
  }

  close(
    id: string,
    generation: number,
    _output: string,
  ): TerminalInstance | null {
    this.clearTelemetryGrace(id);
    const changed = this.db
      .prepare(
        `UPDATE terminal_instances SET process_state=CASE
            WHEN process_state IN ('starting','running') THEN 'exited' ELSE process_state END,
          activity_state=CASE
            WHEN provider IS NOT NULL AND process_state IN ('starting','running') THEN 'idle'
            ELSE activity_state END,
          ended_at=COALESCE(ended_at, ?), end_reason=COALESCE(end_reason, 'closed'),
          transcript='', transcript_truncated=0, removed_at=?, revision=revision+1
        WHERE id=? AND generation=? AND removed_at IS NULL`,
      )
      .run(nowIso(), nowIso(), id, generation);
    if (Number(changed.changes) === 0) return this.get(id);
    const instance = this.get(id, true);
    if (instance)
      this.emit({
        type: "terminal.instance",
        kind: "instance.removed",
        instance,
      });
    return instance;
  }

  get(id: string, includeRemoved = false): TerminalInstance | null {
    const row = this.db
      .prepare(
        `SELECT * FROM terminal_instances WHERE id=?${includeRemoved ? "" : " AND removed_at IS NULL"}`,
      )
      .get(id) as TerminalInstanceRow | undefined;
    return row ? toInstance(row) : null;
  }

  byLaunchRequestId(launchRequestId: string): TerminalInstance | null {
    const row = this.db
      .prepare(
        `SELECT * FROM terminal_instances WHERE launch_request_id=? AND removed_at IS NULL LIMIT 1`,
      )
      .get(launchRequestId) as TerminalInstanceRow | undefined;
    return row ? toInstance(row) : null;
  }

  byPtyId(ptyId: string): TerminalInstance | null {
    const row = this.db
      .prepare(
        `SELECT * FROM terminal_instances WHERE pty_id=? AND removed_at IS NULL LIMIT 1`,
      )
      .get(ptyId) as TerminalInstanceRow | undefined;
    return row ? toInstance(row) : null;
  }

  listProject(projectId: string): TerminalInstance[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM terminal_instances WHERE project_id=? AND removed_at IS NULL
        ORDER BY created_at DESC, id DESC`,
      )
      .all(projectId) as TerminalInstanceRow[];
    return rows.map(toInstance);
  }

  listAll(): TerminalInstance[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM terminal_instances
           WHERE removed_at IS NULL
           ORDER BY created_at DESC, id DESC`,
      )
      .all() as TerminalInstanceRow[];
    return rows.map(toInstance);
  }

  listLive(projectId?: string): TerminalInstance[] {
    const rows = (
      projectId
        ? this.db
            .prepare(
              `SELECT * FROM terminal_instances
             WHERE project_id=? AND removed_at IS NULL AND process_state IN ('starting','running')
             ORDER BY started_at DESC, created_at DESC`,
            )
            .all(projectId)
        : this.db
            .prepare(
              `SELECT * FROM terminal_instances
             WHERE removed_at IS NULL AND process_state IN ('starting','running')
             ORDER BY started_at DESC, created_at DESC`,
            )
            .all()
    ) as TerminalInstanceRow[];
    return rows.map(toInstance);
  }

  listLiveForWorkspace(workspaceId: string): TerminalInstance[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM terminal_instances
         WHERE workspace_id=? AND removed_at IS NULL AND process_state IN ('starting','running')
         ORDER BY started_at DESC, created_at DESC`,
      )
      .all(workspaceId) as TerminalInstanceRow[];
    return rows.map(toInstance);
  }

  listLiveForCheckout(checkoutPath: string): TerminalInstance[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM terminal_instances WHERE checkout_path=? AND removed_at IS NULL
        AND process_state IN ('starting','running')`,
      )
      .all(checkoutPath) as TerminalInstanceRow[];
    return rows.map(toInstance);
  }

  transcript(id: string): { output: string; truncated: boolean } | null {
    const row = this.db
      .prepare(
        `SELECT transcript, transcript_truncated FROM terminal_instances
        WHERE id=? AND removed_at IS NULL`,
      )
      .get(id) as
      | { transcript: string; transcript_truncated: number }
      | undefined;
    return row
      ? { output: row.transcript, truncated: row.transcript_truncated === 1 }
      : null;
  }

  private updated(
    id: string,
    kind: TerminalInstanceEvent["kind"],
  ): TerminalInstance | null {
    const instance = this.get(id);
    if (instance) this.emit({ type: "terminal.instance", kind, instance });
    return instance;
  }

  private scheduleTelemetryGrace(instance: TerminalInstance): void {
    this.clearTelemetryGrace(instance.id);
    const timer = setTimeout(() => {
      const current = this.get(instance.id);
      if (!current || current.generation !== instance.generation) return;
      if (
        current.processState !== "running" ||
        current.telemetryState !== "connecting"
      )
        return;
      const changed = this.db
        .prepare(
          `UPDATE terminal_instances SET telemetry_state='degraded',
            telemetry_error='No provider telemetry received within 10 seconds', revision=revision+1
          WHERE id=? AND generation=? AND process_state='running' AND telemetry_state='connecting'`,
        )
        .run(instance.id, instance.generation);
      if (Number(changed.changes) > 0)
        this.updated(instance.id, "instance.updated");
    }, TELEMETRY_GRACE_MS);
    timer.unref?.();
    this.telemetryTimers.set(instance.id, timer);
  }

  private clearTelemetryGrace(id: string): void {
    const timer = this.telemetryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.telemetryTimers.delete(id);
  }

  private ensureProcessColumns(): void {
    const additions: Array<[string, string]> = [
      ["workspace_id", "TEXT"],
      ["tool_use_id", "TEXT"],
      ["provider", "TEXT"],
      ["launch_request_id", "TEXT"],
      ["native_session_id", "TEXT"],
      ["activity_state", "TEXT NOT NULL DEFAULT 'idle'"],
      ["telemetry_state", "TEXT NOT NULL DEFAULT 'process_only'"],
      ["telemetry_error", "TEXT"],
      ["os_pid", "INTEGER"],
      ["os_started_at_ms", "INTEGER"],
      ["process_identity_json", "TEXT"],
      ["terminal_epoch", "TEXT"],
      ["launch_profile_json", "TEXT"],
      ["native_session_ref_json", "TEXT"],
      ["restart_policy", "TEXT NOT NULL DEFAULT 'manual'"],
    ];
    for (const [column, decl] of additions) {
      if (!tableHasColumn(this.db, "terminal_instances", column)) {
        this.db.exec(
          `ALTER TABLE terminal_instances ADD COLUMN ${column} ${decl}`,
        );
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_terminal_instances_workspace
        ON terminal_instances(workspace_id, removed_at, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_instances_launch_request
        ON terminal_instances(launch_request_id) WHERE launch_request_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_instances_tool_use
        ON terminal_instances(tool_use_id) WHERE tool_use_id IS NOT NULL;
    `);
  }

  private migrateAgentRuns(): void {
    const migrated = this.db
      .prepare("SELECT version FROM schema_migrations WHERE version=14")
      .get();
    if (migrated) return;
    const agentTable = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_runs'",
      )
      .get();
    if (!agentTable) {
      this.db
        .prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES(14)")
        .run();
      return;
    }
    const rows = this.db
      .prepare(`SELECT * FROM agent_runs WHERE removed_at IS NULL`)
      .all() as Array<{
      run_id: string;
      launch_request_id: string;
      generation: number;
      provider: string;
      project_id: string;
      workspace_id: string;
      checkout_key: string;
      checkout_path: string;
      title: string;
      pty_id: string | null;
      native_session_id: string | null;
      process_state: string;
      activity_state: string;
      telemetry_state: string;
      created_at: string;
      started_at: string | null;
      last_activity_at: string | null;
      ended_at: string | null;
      exit_code: number | null;
      end_reason: string | null;
      telemetry_error: string | null;
      revision: number;
      transcript?: string;
      transcript_truncated?: number;
    }>;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO terminal_instances(
        id,generation,project_id,workspace_id,checkout_key,checkout_path,title,
        provider,launch_request_id,pty_id,native_session_id,process_state,
        activity_state,telemetry_state,created_at,started_at,last_activity_at,
        ended_at,exit_code,end_reason,telemetry_error,transcript,transcript_truncated,revision
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const processState =
          row.process_state === "reserved" ? "starting" : row.process_state;
        insert.run(
          row.run_id,
          row.generation,
          row.project_id,
          row.workspace_id,
          row.checkout_key,
          row.checkout_path,
          row.title,
          row.provider,
          row.launch_request_id,
          row.pty_id,
          row.native_session_id,
          processState,
          row.activity_state,
          row.telemetry_state,
          row.created_at,
          row.started_at,
          row.last_activity_at,
          row.ended_at,
          row.exit_code,
          row.end_reason,
          row.telemetry_error,
          row.transcript ?? "",
          row.transcript_truncated ?? 0,
          row.revision,
        );
      }
      this.db
        .prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES(14)")
        .run();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  private backfillLegacyProjectTerminals(): void {
    const migrated = this.db
      .prepare("SELECT version FROM schema_migrations WHERE version=13")
      .get();
    if (migrated) return;
    const projectSessionTable = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='project_sessions'",
      )
      .get();
    if (!projectSessionTable) {
      this.db
        .prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES(13)")
        .run();
      return;
    }
    const sessions = this.db
      .prepare(
        `SELECT ps.id, ps.project_path, ps.created_at, ps.payload_json, p.id AS project_id
         FROM project_sessions ps
         JOIN projects p ON p.root_path=ps.project_path
        WHERE ps.archived_at IS NULL`,
      )
      .all() as Array<{
      id: string;
      project_path: string;
      created_at: string;
      payload_json: string;
      project_id: string;
    }>;
    const insert = this.db.prepare(
      `INSERT INTO terminal_instances(
        id,generation,project_id,workspace_id,checkout_key,checkout_path,title,pty_id,
        provider,process_state,activity_state,telemetry_state,created_at,ended_at,end_reason,revision
      ) VALUES(?,1,?,?,?,?,?,NULL,NULL,'disconnected','idle','process_only',?,?,'host_restart',1)`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const session of sessions) {
        let payload;
        try {
          payload = tryDecodeProjectSessionPayload(
            JSON.parse(session.payload_json),
          );
        } catch {
          payload = null;
        }
        if (!payload) continue;
        for (const leaf of payload.sessions) {
          if (leaf.agentProvider) continue;
          let checkoutPath: string;
          try {
            checkoutPath = fileUriToPath(leaf.cwdRootUri);
          } catch {
            continue;
          }
          const checkoutKey =
            checkoutPath === session.project_path ? "main" : checkoutPath;
          insert.run(
            `terminal-${randomUUID()}`,
            session.project_id,
            session.id,
            checkoutKey,
            checkoutPath,
            leaf.label?.trim() || "Terminal",
            session.created_at,
            nowIso(),
          );
        }
      }
      this.db
        .prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES(13)")
        .run();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw error;
    }
  }
}
