import type { DatabaseSession } from "../database.js"

/** Migration version 5 — ADE agent events + session snapshots. */
export function ensureAgentTelemetrySchema(db: DatabaseSession): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      native_session_id TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_events_session_occurred
      ON agent_events(session_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_agent_events_session_kind
      ON agent_events(session_id, kind);

    CREATE TABLE IF NOT EXISTS agent_session_snapshots (
      session_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      native_session_id TEXT,
      snapshot_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    /*
     * An agent run is deliberately not a terminal tab.  A tab can be restored,
     * renamed, or even removed while the process it launched is still useful
     * history.  Keep the process lifetime in its own durable row and use the
     * generation to reject delayed terminal/hook events from a prior process.
     */
    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY,
      launch_request_id TEXT NOT NULL UNIQUE,
      generation INTEGER NOT NULL DEFAULT 1,
      provider TEXT NOT NULL,
      project_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      checkout_key TEXT NOT NULL,
      checkout_path TEXT NOT NULL,
      title TEXT NOT NULL,
      pty_id TEXT,
      native_session_id TEXT,
      process_state TEXT NOT NULL,
      activity_state TEXT NOT NULL,
      telemetry_state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      last_activity_at TEXT,
      ended_at TEXT,
      exit_code INTEGER,
      end_reason TEXT,
      telemetry_error TEXT,
      transcript TEXT NOT NULL DEFAULT '',
      transcript_truncated INTEGER NOT NULL DEFAULT 0,
      removed_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_live
      ON agent_runs(process_state, project_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace
      ON agent_runs(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_pty
      ON agent_runs(pty_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_activity
      ON agent_runs(ended_at DESC, created_at DESC);
  `)
  const columns = new Set(
    (db.prepare("PRAGMA table_info(agent_runs)").all() as Array<{ name: string }>).map(row => row.name),
  )
  if (!columns.has("transcript")) {
    db.exec("ALTER TABLE agent_runs ADD COLUMN transcript TEXT NOT NULL DEFAULT ''")
  }
  if (!columns.has("transcript_truncated")) {
    db.exec("ALTER TABLE agent_runs ADD COLUMN transcript_truncated INTEGER NOT NULL DEFAULT 0")
  }
  if (!columns.has("removed_at")) {
    db.exec("ALTER TABLE agent_runs ADD COLUMN removed_at TEXT")
  }
  // PTYs live only in host memory. A new host can retain history, but never
  // claim an old process is actionable after restart.
  db.prepare(
    `UPDATE agent_runs
        SET process_state='disconnected',
            activity_state='idle',
            ended_at=COALESCE(ended_at, ?),
            end_reason=COALESCE(end_reason, 'host_restart'),
            revision=revision+1
      WHERE process_state IN ('reserved','starting','running')`,
  ).run(new Date().toISOString())
}
