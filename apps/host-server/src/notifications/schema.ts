import { createHash, randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type {
  AgentProvider,
  AppNotification,
  NotificationSeverity,
  NotificationSource,
  NotificationStatus,
  NotificationType,
} from "@yaade/shared"

export type NotificationRow = {
  id: string
  project_id: string | null
  session_id: string | null
  run_id: string | null
  project_name: string | null
  session_title: string | null
  provider: string | null
  type: string
  severity: string
  status: string
  title: string
  message: string | null
  source: string
  event_id: string | null
  event_sequence: number | null
  provider_session_id: string | null
  provider_event: string | null
  provider_turn_id: string | null
  requires_action: number
  action_resolved_at: string | null
  read_at: string | null
  dismissed_at: string | null
  created_at: string
  updated_at: string
  metadata_json: string
  delivery_json: string | null
  content_hash: string | null
}

export function ensureNotificationSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_notifications (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      session_id TEXT,
      run_id TEXT,
      project_name TEXT,
      session_title TEXT,
      provider TEXT,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      source TEXT NOT NULL,
      event_id TEXT,
      event_sequence INTEGER,
      provider_session_id TEXT,
      provider_event TEXT,
      provider_turn_id TEXT,
      requires_action INTEGER NOT NULL DEFAULT 0,
      action_resolved_at TEXT,
      read_at TEXT,
      dismissed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      delivery_json TEXT,
      content_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_app_notifications_created
      ON app_notifications(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_app_notifications_status
      ON app_notifications(status);
    CREATE INDEX IF NOT EXISTS idx_app_notifications_session
      ON app_notifications(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_app_notifications_project
      ON app_notifications(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_app_notifications_event
      ON app_notifications(session_id, type, event_id);
    CREATE INDEX IF NOT EXISTS idx_app_notifications_turn
      ON app_notifications(session_id, type, provider_turn_id);
    CREATE INDEX IF NOT EXISTS idx_app_notifications_hash
      ON app_notifications(session_id, type, content_hash, created_at);

    CREATE TABLE IF NOT EXISTS notification_session_bindings (
      session_id TEXT PRIMARY KEY,
      run_id TEXT,
      project_id TEXT,
      project_name TEXT,
      session_title TEXT,
      provider TEXT,
      pty_id TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notification_bindings_pty
      ON notification_session_bindings(pty_id);

    CREATE TABLE IF NOT EXISTS notification_preferences (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      prefs_json TEXT NOT NULL
    );
  `)
  for (const statement of [
    "ALTER TABLE app_notifications ADD COLUMN run_id TEXT",
    "ALTER TABLE notification_session_bindings ADD COLUMN run_id TEXT",
  ]) {
    try { db.exec(statement) } catch { /* column already exists */ }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_app_notifications_run
      ON app_notifications(run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notification_bindings_run
      ON notification_session_bindings(run_id);
    UPDATE notification_session_bindings
       SET run_id=session_id
     WHERE run_id IS NULL AND session_id LIKE 'run-%';
    UPDATE app_notifications
       SET run_id=session_id
     WHERE run_id IS NULL AND session_id LIKE 'run-%';
  `)
  try {
    db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES(2)").run()
  } catch {
    /* migrations table may not exist in unit tests that use a bare DB */
  }
}

export function rowToNotification(row: NotificationRow): AppNotification {
  let metadata: Record<string, unknown> = {}
  try {
    metadata = JSON.parse(row.metadata_json || "{}") as Record<string, unknown>
  } catch {
    metadata = {}
  }
  let delivery: AppNotification["delivery"]
  if (row.delivery_json) {
    try {
      delivery = JSON.parse(row.delivery_json) as AppNotification["delivery"]
    } catch {
      delivery = undefined
    }
  }
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    runId: row.run_id,
    projectName: row.project_name,
    sessionTitle: row.session_title,
    provider: (row.provider as AgentProvider | null) ?? null,
    type: row.type as NotificationType,
    severity: row.severity as NotificationSeverity,
    status: row.status as NotificationStatus,
    title: row.title,
    message: row.message,
    source: row.source as NotificationSource,
    eventId: row.event_id,
    eventSequence: row.event_sequence,
    providerSessionId: row.provider_session_id,
    providerEvent: row.provider_event,
    providerTurnId: row.provider_turn_id,
    requiresAction: row.requires_action === 1,
    actionResolvedAt: row.action_resolved_at,
    readAt: row.read_at,
    dismissedAt: row.dismissed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata,
    delivery,
  }
}

export function contentHashFor(input: {
  type: string
  title: string
  message: string | null | undefined
  providerTurnId?: string | null
  eventId?: string | null
}): string {
  const raw = [
    input.type,
    input.title.trim().toLowerCase(),
    (input.message ?? "").trim().toLowerCase(),
    input.providerTurnId ?? "",
    input.eventId ?? "",
  ].join("\0")
  return createHash("sha256").update(raw).digest("hex").slice(0, 24)
}

export function newNotificationId(): string {
  return randomUUID()
}
