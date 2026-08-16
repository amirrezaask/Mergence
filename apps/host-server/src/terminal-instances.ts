import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentEvent, AgentProvider } from "@yaade/agents";
import { tryDecodeProjectSessionPayload } from "@yaade/rpc";
import { fileUriToPath } from "@yaade/shared";

export type TerminalInstanceState =
  | "starting"
  | "running"
  | "exited"
  | "failed"
  | "disconnected";

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
const TELEMETRY_GRACE_MS = 10_000;

function nowIso(): string {
  return new Date().toISOString();
}

function asProvider(value: string | null | undefined): AgentProvider | null {
  switch (value) {
    case "claude":
    case "codex":
    case "cursor":
    case "opencode":
    case "grok":
    case "pi":
      return value;
    default:
      return null;
  }
}

function state(value: string): TerminalInstanceState {
  switch (value) {
    case "starting":
    case "running":
    case "exited":
    case "failed":
    case "disconnected":
      return value;
    default:
      return "disconnected";
  }
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
  db: DatabaseSync,
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
    `);
    this.ensureProcessColumns();
    db.prepare(
      "INSERT OR IGNORE INTO schema_migrations(version) VALUES(12)",
    ).run();
    this.backfillLegacyProjectTerminals();
    this.migrateAgentRuns();
    // Host restart invalidates live PTYs after all migrations have loaded rows.
    db.prepare(
      `UPDATE terminal_instances
          SET process_state='disconnected', ended_at=COALESCE(ended_at, ?),
              end_reason=COALESCE(end_reason, 'host_restart'), revision=revision+1
        WHERE process_state IN ('starting','running')`,
    ).run(nowIso());
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

  unbindToolUse(toolUseId: string): void {
    this.db
      .prepare(
        "UPDATE terminal_instances SET tool_use_id=NULL WHERE tool_use_id=?",
      )
      .run(toolUseId);
  }

  bindPty(
    id: string,
    generation: number,
    ptyId: string,
    title?: string | null,
    telemetryState?: TerminalInstanceTelemetryState,
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
          telemetry_error=NULL, revision=revision+1
        WHERE id=? AND generation=? AND removed_at IS NULL AND process_state='starting'`,
      )
      .run(
        ptyId,
        title ?? null,
        nextTelemetry,
        timestamp,
        timestamp,
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
              telemetry_state=CASE WHEN telemetry_state='process_only' THEN telemetry_state ELSE 'connected' END,
              activity_state=CASE WHEN process_state IN ('exited','disconnected','failed') THEN activity_state ELSE COALESCE(?, activity_state) END,
              last_activity_at=?, revision=revision+1
        WHERE id=? AND generation=?`,
      )
      .run(
        event.nativeSessionId ?? null,
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
    const changed = this.db
      .prepare(
        `UPDATE terminal_instances SET process_state='exited',
          activity_state=CASE WHEN provider IS NOT NULL THEN ? ELSE activity_state END,
          ended_at=COALESCE(ended_at, ?),
          exit_code=COALESCE(?, exit_code), end_reason=COALESCE(end_reason, 'process_exit'),
          transcript=?, transcript_truncated=?, revision=revision+1
        WHERE id=? AND generation=? AND pty_id=? AND removed_at IS NULL
          AND process_state IN ('starting','running')`,
      )
      .run(
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
          process_state='starting',
          activity_state=CASE WHEN provider IS NOT NULL THEN 'starting' ELSE activity_state END,
          telemetry_state=CASE WHEN provider IS NOT NULL THEN 'connecting' ELSE telemetry_state END,
          started_at=NULL, last_activity_at=NULL, ended_at=NULL,
          exit_code=NULL, end_reason=NULL, transcript='', transcript_truncated=0,
          telemetry_error=NULL, revision=revision+1
        WHERE id=? AND generation=? AND removed_at IS NULL
          AND process_state IN ('starting','running','exited','failed','disconnected')`,
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
    this.telemetryTimers.set(
      instance.id,
      setTimeout(() => {
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
      }, TELEMETRY_GRACE_MS),
    );
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
