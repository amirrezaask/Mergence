import type { DatabaseSync } from "node:sqlite"

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all()
  return rows.some(row =>
    typeof row === "object" && row !== null && Reflect.get(row, "name") === column,
  )
}

function addColumn(db: DatabaseSync, table: string, definition: string, column: string): void {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
}

function hasGlobalEventIdUniqueConstraint(db: DatabaseSync): boolean {
  const indexes = db.prepare("PRAGMA index_list(agent_thread_events)").all()
  return indexes.some(index => {
    if (!index || typeof index !== "object" || Reflect.get(index, "unique") !== 1) return false
    const name = Reflect.get(index, "name")
    if (typeof name !== "string") return false
    const columns = db.prepare(`PRAGMA index_info(${JSON.stringify(name)})`).all()
    return columns.length === 1 && Reflect.get(columns[0], "name") === "event_id"
  })
}

function migrateEventIdScope(db: DatabaseSync): void {
  if (!hasGlobalEventIdUniqueConstraint(db)) return
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE agent_thread_events_v11 (
      thread_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      PRIMARY KEY (thread_id, sequence),
      UNIQUE (thread_id, event_id),
      FOREIGN KEY (thread_id) REFERENCES agent_threads(thread_id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    INSERT INTO agent_thread_events_v11(thread_id, sequence, event_id, envelope_json)
      SELECT thread_id, sequence, event_id, envelope_json FROM agent_thread_events;
    DROP TABLE agent_thread_events;
    ALTER TABLE agent_thread_events_v11 RENAME TO agent_thread_events;
    COMMIT;
  `)
}

/** Migration 10 — durable interactive-agent threads, separate from CLI telemetry. */
export function ensureAgentThreadSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_threads (
      thread_id TEXT PRIMARY KEY,
      snapshot_json TEXT NOT NULL,
      snapshot_sequence INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_thread_events (
      thread_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      PRIMARY KEY (thread_id, sequence),
      UNIQUE (thread_id, event_id),
      FOREIGN KEY (thread_id) REFERENCES agent_threads(thread_id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS agent_thread_commands (
      thread_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'completed',
      command_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, command_id),
      FOREIGN KEY (thread_id) REFERENCES agent_threads(thread_id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS agent_thread_events_by_thread
      ON agent_thread_events(thread_id, sequence);
    CREATE TABLE IF NOT EXISTS agent_attachments (
      attachment_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES agent_threads(thread_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS agent_attachments_by_thread
      ON agent_attachments(thread_id, created_at);
  `)
  addColumn(db, "agent_threads", "snapshot_sequence INTEGER NOT NULL DEFAULT 0", "snapshot_sequence")
  addColumn(db, "agent_thread_commands", "state TEXT NOT NULL DEFAULT 'completed'", "state")
  addColumn(db, "agent_thread_commands", "command_json TEXT", "command_json")
  migrateEventIdScope(db)
  db.exec(`
    UPDATE agent_threads
       SET snapshot_sequence = COALESCE(json_extract(snapshot_json, '$.state.lastSequence'), 0)
     WHERE snapshot_sequence = 0
  `)
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES(11)").run()
}
