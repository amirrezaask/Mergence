import type { DatabaseSync } from "node:sqlite"
import type {
  AgentProvider,
  AppNotification,
  IngestNotificationRequest,
  ListNotificationsRequest,
  ListNotificationsResponse,
  MarkAllNotificationsReadRequest,
  NotificationCounts,
  NotificationFilter,
  NotificationPreferences,
  NotificationSource,
  NotificationStreamEvent,
  NotificationType,
} from "@yaade/shared"
import {
  NOTIFICATION_SOURCE_RANK,
  severityForNotificationType,
  typeRequiresAction,
} from "@yaade/shared"
import {
  mergeNotificationPreferences,
  shouldCreateInAppNotification,
} from "./policy.js"
import {
  contentHashFor,
  ensureNotificationSchema,
  newNotificationId,
  rowToNotification,
  type NotificationRow,
} from "./schema.js"

const DEDUPE_WINDOW_MS = 90_000
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export type SessionBinding = {
  sessionId: string
  runId?: string | null
  projectId: string | null
  projectName: string | null
  sessionTitle: string | null
  provider: AgentProvider | null
  ptyId: string | null
}

export type IngestResult = {
  notification: AppNotification | null
  created: boolean
  updated: boolean
  deduped: boolean
  skipped: boolean
  skipReason?: string
}

type EmitFn = (event: NotificationStreamEvent) => void

function nowIso(): string {
  return new Date().toISOString()
}

function asFilter(value: unknown): NotificationFilter {
  if (
    value === "unread" ||
    value === "action-needed" ||
    value === "completed" ||
    value === "errors"
  ) {
    return value
  }
  return "all"
}

function matchesFilter(n: AppNotification, filter: NotificationFilter): boolean {
  switch (filter) {
    case "all":
      return n.status !== "dismissed"
    case "unread":
      return n.status === "unread"
    case "action-needed":
      return n.requiresAction && n.actionResolvedAt == null && n.status !== "dismissed"
    case "completed":
      return n.type === "turn-completed" && n.status !== "dismissed"
    case "errors":
      return (
        n.status !== "dismissed" &&
        (n.severity === "error" || n.type === "failed")
      )
  }
}

function searchHaystack(n: AppNotification): string {
  return [
    n.title,
    n.message ?? "",
    n.projectName ?? "",
    n.sessionTitle ?? "",
    n.provider ?? "",
  ]
    .join(" ")
    .toLowerCase()
}

export class NotificationService {
  private readonly emit: EmitFn
  private prefsCache: NotificationPreferences | null = null
  private retentionScheduled = false

  constructor(
    private readonly db: DatabaseSync,
    emit?: EmitFn,
  ) {
    ensureNotificationSchema(db)
    this.emit = emit ?? (() => {})
  }

  getPreferences(): NotificationPreferences {
    if (this.prefsCache) return this.prefsCache
    const row = this.db
      .prepare("SELECT prefs_json FROM notification_preferences WHERE id=1")
      .get() as { prefs_json: string } | undefined
    if (!row) {
      this.prefsCache = mergeNotificationPreferences()
      return this.prefsCache
    }
    try {
      this.prefsCache = mergeNotificationPreferences(
        JSON.parse(row.prefs_json) as Partial<NotificationPreferences>,
      )
    } catch {
      this.prefsCache = mergeNotificationPreferences()
    }
    return this.prefsCache
  }

  setPreferences(partial: Partial<NotificationPreferences>): NotificationPreferences {
    const next = mergeNotificationPreferences({
      ...this.getPreferences(),
      ...partial,
    })
    this.db
      .prepare(
        `INSERT INTO notification_preferences(id, prefs_json) VALUES(1, ?)
         ON CONFLICT(id) DO UPDATE SET prefs_json=excluded.prefs_json`,
      )
      .run(JSON.stringify(next))
    this.prefsCache = next
    return next
  }

  bindSession(binding: SessionBinding): void {
    this.db
      .prepare(
        `INSERT INTO notification_session_bindings(
           session_id, run_id, project_id, project_name, session_title, provider, pty_id, updated_at
         ) VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET
           run_id=COALESCE(excluded.run_id, notification_session_bindings.run_id),
           project_id=COALESCE(excluded.project_id, notification_session_bindings.project_id),
           project_name=COALESCE(excluded.project_name, notification_session_bindings.project_name),
           session_title=COALESCE(excluded.session_title, notification_session_bindings.session_title),
           provider=COALESCE(excluded.provider, notification_session_bindings.provider),
           pty_id=COALESCE(excluded.pty_id, notification_session_bindings.pty_id),
           updated_at=excluded.updated_at`,
      )
      .run(
        binding.sessionId,
        binding.runId ?? (binding.sessionId.startsWith("run-") ? binding.sessionId : null),
        binding.projectId,
        binding.projectName,
        binding.sessionTitle,
        binding.provider,
        binding.ptyId,
        nowIso(),
      )

    this.db
      .prepare(
        `UPDATE app_notifications
            SET run_id=COALESCE(run_id, ?),
                project_id=COALESCE(project_id, ?),
                project_name=COALESCE(project_name, ?),
                session_title=COALESCE(session_title, ?),
                provider=COALESCE(provider, ?),
                updated_at=?
          WHERE session_id=?
            AND (project_id IS NULL OR project_name IS NULL
              OR session_title IS NULL OR provider IS NULL)`,
      )
      .run(
        binding.runId ?? (binding.sessionId.startsWith("run-") ? binding.sessionId : null),
        binding.projectId,
        binding.projectName,
        binding.sessionTitle,
        binding.provider,
        nowIso(),
        binding.sessionId,
      )
  }

  bindingForSession(sessionId: string): SessionBinding | null {
    const row = this.db
      .prepare(
        `SELECT session_id, run_id, project_id, project_name, session_title, provider, pty_id
         FROM notification_session_bindings WHERE session_id=?`,
      )
      .get(sessionId) as
      | {
          session_id: string
          run_id: string | null
          project_id: string | null
          project_name: string | null
          session_title: string | null
          provider: string | null
          pty_id: string | null
        }
      | undefined
    if (!row) return null
    return {
      sessionId: row.session_id,
      runId: row.run_id,
      projectId: row.project_id,
      projectName: row.project_name,
      sessionTitle: row.session_title,
      provider: (row.provider as AgentProvider | null) ?? null,
      ptyId: row.pty_id,
    }
  }

  bindingForPty(ptyId: string): SessionBinding | null {
    const row = this.db
      .prepare(
        `SELECT session_id, run_id, project_id, project_name, session_title, provider, pty_id
         FROM notification_session_bindings WHERE pty_id=?`,
      )
      .get(ptyId) as
      | {
          session_id: string
          run_id: string | null
          project_id: string | null
          project_name: string | null
          session_title: string | null
          provider: string | null
          pty_id: string | null
        }
      | undefined
    if (!row) return null
    return {
      sessionId: row.session_id,
      runId: row.run_id,
      projectId: row.project_id,
      projectName: row.project_name,
      sessionTitle: row.session_title,
      provider: (row.provider as AgentProvider | null) ?? null,
      ptyId: row.pty_id,
    }
  }

  counts(): NotificationCounts {
    const unread = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM app_notifications WHERE status='unread'`,
      )
      .get() as { n: number }
    const action = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM app_notifications
         WHERE requires_action=1 AND action_resolved_at IS NULL AND status != 'dismissed'`,
      )
      .get() as { n: number }
    const errors = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM app_notifications
         WHERE status='unread' AND (severity='error' OR type='failed')`,
      )
      .get() as { n: number }
    return {
      totalUnread: Number(unread.n) || 0,
      actionRequired: Number(action.n) || 0,
      errors: Number(errors.n) || 0,
    }
  }

  /** Per-session unread counts for sidebar badges. */
  unreadBySession(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT session_id AS sessionId, COUNT(*) AS n
         FROM app_notifications
         WHERE status='unread' AND session_id IS NOT NULL
         GROUP BY session_id`,
      )
      .all() as Array<{ sessionId: string; n: number }>
    const out: Record<string, number> = {}
    for (const row of rows) {
      if (!row.sessionId) continue
      out[row.sessionId] = Number(row.n) || 0
    }
    return out
  }

  unreadByProject(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT project_id AS projectId, COUNT(*) AS n
         FROM app_notifications
         WHERE status='unread' AND project_id IS NOT NULL
         GROUP BY project_id`,
      )
      .all() as Array<{ projectId: string; n: number }>
    const out: Record<string, number> = {}
    for (const row of rows) {
      if (!row.projectId) continue
      out[row.projectId] = Number(row.n) || 0
    }
    return out
  }

  attentionBySession(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT session_id AS sessionId, COUNT(*) AS n
         FROM app_notifications
         WHERE session_id IS NOT NULL AND status != 'dismissed'
           AND ((requires_action=1 AND action_resolved_at IS NULL)
             OR (status='unread' AND (severity='error' OR type='failed')))
         GROUP BY session_id`,
      )
      .all() as Array<{ sessionId: string; n: number }>
    const out: Record<string, number> = {}
    for (const row of rows) {
      if (!row.sessionId) continue
      out[row.sessionId] = Number(row.n) || 0
    }
    return out
  }

  attentionByProject(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT project_id AS projectId, COUNT(*) AS n
         FROM app_notifications
         WHERE project_id IS NOT NULL AND status != 'dismissed'
           AND ((requires_action=1 AND action_resolved_at IS NULL)
             OR (status='unread' AND (severity='error' OR type='failed')))
         GROUP BY project_id`,
      )
      .all() as Array<{ projectId: string; n: number }>
    const out: Record<string, number> = {}
    for (const row of rows) {
      if (!row.projectId) continue
      out[row.projectId] = Number(row.n) || 0
    }
    return out
  }

  /** Mark the most recent non-dismissed notification for a session as unread. */
  markSessionUnread(sessionId: string): AppNotification | null {
    const row = this.db
      .prepare(
        `SELECT id FROM app_notifications
         WHERE session_id=? AND status != 'dismissed'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(sessionId) as { id: string } | undefined
    if (!row?.id) return null
    return this.markUnread(row.id)
  }

  get(id: string): AppNotification | null {
    const row = this.db
      .prepare("SELECT * FROM app_notifications WHERE id=?")
      .get(id) as NotificationRow | undefined
    return row ? rowToNotification(row) : null
  }

  list(req: ListNotificationsRequest = {}): ListNotificationsResponse {
    const filter = asFilter(req.filter)
    const limit = Math.min(Math.max(req.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const offset = req.cursor ? Number.parseInt(req.cursor, 10) || 0 : 0
    const rows = this.db
      .prepare(
        `SELECT * FROM app_notifications ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(Math.min(limit * 8, 2000), offset) as unknown as NotificationRow[]

    const query = req.query?.trim().toLowerCase() ?? ""
    const items: AppNotification[] = []
    let scanned = 0
    for (const row of rows) {
      scanned += 1
      const n = rowToNotification(row)
      if (!matchesFilter(n, filter)) continue
      if (req.projectId && n.projectId !== req.projectId) continue
      if (req.sessionId && n.sessionId !== req.sessionId) continue
      if (req.provider && n.provider !== req.provider) continue
      if (query && !searchHaystack(n).includes(query)) continue
      items.push(n)
      if (items.length >= limit) break
    }

    const nextOffset = offset + scanned
    const more =
      items.length >= limit ||
      (rows.length > 0 && scanned === rows.length && rows.length >= limit * 8)
    // Probe one more page cheaply when we filled the page from the fetch window.
    let nextCursor: string | null = null
    if (items.length >= limit) {
      nextCursor = String(nextOffset)
    } else if (more && scanned > 0) {
      nextCursor = String(nextOffset)
    }

    return { items, nextCursor, counts: this.counts() }
  }

  ingest(raw: IngestNotificationRequest): IngestResult {
    const prefs = this.getPreferences()
    if (!shouldCreateInAppNotification(prefs, raw.type) && !raw.resolveOf) {
      return {
        notification: null,
        created: false,
        updated: false,
        deduped: false,
        skipped: true,
        skipReason: "category-disabled",
      }
    }

    const binding = raw.sessionId ? this.bindingForSession(raw.sessionId) : null
    const projectId = raw.projectId ?? binding?.projectId ?? null
    const sessionId = raw.sessionId ?? null
    const projectName = raw.projectName ?? binding?.projectName ?? null
    const sessionTitle = raw.sessionTitle ?? binding?.sessionTitle ?? null
    const provider = raw.provider ?? binding?.provider ?? null

    if (raw.resolveOf) {
      const resolved = this.resolveActionable({
        sessionId,
        type: raw.resolveOf.type,
        eventId: raw.resolveOf.eventId,
        providerTurnId: raw.resolveOf.providerTurnId,
        providerSessionId: raw.resolveOf.providerSessionId,
      })
      if (resolved) {
        return {
          notification: resolved,
          created: false,
          updated: true,
          deduped: false,
          skipped: false,
        }
      }
    }

    const severity = raw.severity ?? severityForNotificationType(raw.type)
    const requiresAction =
      raw.requiresAction ?? typeRequiresAction(raw.type)
    const hash = contentHashFor({
      type: raw.type,
      title: raw.title,
      message: raw.message,
      providerTurnId: raw.providerTurnId,
      eventId: raw.eventId,
    })

    const duplicate = this.findDuplicate({
      sessionId,
      type: raw.type,
      eventId: raw.eventId ?? null,
      providerTurnId: raw.providerTurnId ?? null,
      providerSessionId: raw.providerSessionId ?? null,
      contentHash: hash,
    })

    if (duplicate) {
      const enriched = this.enrichIfStronger(duplicate, raw, {
        projectId,
        projectName,
        sessionTitle,
        provider,
        severity,
        requiresAction,
        hash,
      })
      return {
        notification: enriched.notification,
        created: false,
        updated: enriched.updated,
        deduped: true,
        skipped: false,
      }
    }

    const id = newNotificationId()
    const createdAt = nowIso()
    const status = "unread"
    this.db
      .prepare(
        `INSERT INTO app_notifications(
          id, project_id, session_id, project_name, session_title, provider,
          type, severity, status, title, message, source,
          event_id, event_sequence, provider_session_id, provider_event, provider_turn_id,
          requires_action, action_resolved_at, read_at, dismissed_at,
          created_at, updated_at, metadata_json, delivery_json, content_hash
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,?,?)`,
      )
      .run(
        id,
        projectId,
        sessionId,
        projectName,
        sessionTitle,
        provider,
        raw.type,
        severity,
        status,
        raw.title,
        raw.message ?? null,
        raw.source,
        raw.eventId ?? null,
        raw.eventSequence ?? null,
        raw.providerSessionId ?? null,
        raw.providerEvent ?? null,
        raw.providerTurnId ?? null,
        requiresAction ? 1 : 0,
        createdAt,
        createdAt,
        JSON.stringify(raw.metadata ?? {}),
        null,
        hash,
      )

    const notification = this.get(id)!
    this.emit({ type: "notification.created", notification })
    this.emitCounts()
    void this.runRetentionAsync()
    return {
      notification,
      created: true,
      updated: false,
      deduped: false,
      skipped: false,
    }
  }

  markRead(id: string): AppNotification | null {
    const existing = this.get(id)
    if (!existing || existing.status === "dismissed") return existing
    if (existing.status === "read" || existing.status === "resolved") {
      if (existing.readAt) return existing
    }
    const ts = nowIso()
    const nextStatus =
      existing.status === "resolved" ? "resolved" : ("read" as const)
    this.db
      .prepare(
        `UPDATE app_notifications SET status=?, read_at=COALESCE(read_at, ?), updated_at=? WHERE id=?`,
      )
      .run(nextStatus, ts, ts, id)
    const notification = this.get(id)
    if (notification) {
      this.emit({ type: "notification.updated", notification })
      this.emitCounts()
    }
    return notification
  }

  markUnread(id: string): AppNotification | null {
    const existing = this.get(id)
    if (!existing || existing.status === "dismissed") return existing
    const ts = nowIso()
    // Read/unread independent of resolved; keep actionResolvedAt.
    this.db
      .prepare(
        `UPDATE app_notifications SET status='unread', read_at=NULL, updated_at=? WHERE id=?`,
      )
      .run(ts, id)
    const notification = this.get(id)
    if (notification) {
      this.emit({ type: "notification.updated", notification })
      this.emitCounts()
    }
    return notification
  }

  dismiss(id: string): AppNotification | null {
    const existing = this.get(id)
    if (!existing) return null
    const ts = nowIso()
    this.db
      .prepare(
        `UPDATE app_notifications SET status='dismissed', dismissed_at=?, updated_at=? WHERE id=?`,
      )
      .run(ts, ts, id)
    const notification = this.get(id)
    if (notification) {
      this.emit({ type: "notification.dismissed", notificationId: id })
      this.emit({ type: "notification.updated", notification })
      this.emitCounts()
    }
    return notification
  }

  restore(id: string): AppNotification | null {
    const existing = this.get(id)
    if (!existing || existing.status !== "dismissed") return existing
    const ts = nowIso()
    const status = existing.readAt
      ? existing.actionResolvedAt
        ? "resolved"
        : "read"
      : "unread"
    this.db
      .prepare(
        `UPDATE app_notifications SET status=?, dismissed_at=NULL, updated_at=? WHERE id=?`,
      )
      .run(status, ts, id)
    const notification = this.get(id)
    if (notification) {
      this.emit({ type: "notification.updated", notification })
      this.emitCounts()
    }
    return notification
  }

  acknowledge(id: string): AppNotification | null {
    const existing = this.get(id)
    if (!existing) return null
    const ts = nowIso()
    this.db
      .prepare(
        `UPDATE app_notifications
         SET status='resolved',
             action_resolved_at=COALESCE(action_resolved_at, ?),
             read_at=COALESCE(read_at, ?),
             updated_at=?
         WHERE id=?`,
      )
      .run(ts, ts, ts, id)
    const notification = this.get(id)
    if (notification) {
      this.emit({ type: "notification.updated", notification })
      this.emitCounts()
    }
    return notification
  }

  markAllRead(req: MarkAllNotificationsReadRequest = {}): NotificationCounts {
    const before = req.before ?? nowIso()
    if (req.onlyVisible) {
      const listed = this.list({
        filter: req.filter,
        projectId: req.projectId,
        sessionId: req.sessionId,
        provider: req.provider,
        query: req.query,
        limit: MAX_LIMIT,
      })
      const ts = nowIso()
      for (const item of listed.items) {
        if (item.status === "dismissed" || item.status === "read") continue
        if (item.createdAt > before) continue
        const status = item.actionResolvedAt ? "resolved" : "read"
        this.db
          .prepare(
            `UPDATE app_notifications
             SET status=?, read_at=COALESCE(read_at, ?), updated_at=?
             WHERE id=? AND status != 'dismissed'`,
          )
          .run(status, ts, ts, item.id)
      }
    } else {
      const ts = nowIso()
      if (req.sessionId) {
        this.db
          .prepare(
            `UPDATE app_notifications
             SET status=CASE WHEN action_resolved_at IS NOT NULL THEN 'resolved' ELSE 'read' END,
                 read_at=COALESCE(read_at, ?),
                 updated_at=?
             WHERE status='unread' AND created_at <= ? AND session_id=?`,
          )
          .run(ts, ts, before, req.sessionId)
      } else if (req.projectId) {
        this.db
          .prepare(
            `UPDATE app_notifications
             SET status=CASE WHEN action_resolved_at IS NOT NULL THEN 'resolved' ELSE 'read' END,
                 read_at=COALESCE(read_at, ?),
                 updated_at=?
             WHERE status='unread' AND created_at <= ? AND project_id=?`,
          )
          .run(ts, ts, before, req.projectId)
      } else {
        this.db
          .prepare(
            `UPDATE app_notifications
             SET status=CASE WHEN action_resolved_at IS NOT NULL THEN 'resolved' ELSE 'read' END,
                 read_at=COALESCE(read_at, ?),
                 updated_at=?
             WHERE status='unread' AND created_at <= ?`,
          )
          .run(ts, ts, before)
      }
    }
    this.emitCounts()
    return this.counts()
  }

  resolveActionable(input: {
    sessionId: string | null
    type?: NotificationType
    eventId?: string | null
    providerTurnId?: string | null
    providerSessionId?: string | null
  }): AppNotification | null {
    if (!input.sessionId && !input.providerSessionId) return null
    // Native provider identity is stable across the interactive runtime and
    // hook/OSC telemetry, while their app session ids may legitimately differ.
    const scope =
      input.providerSessionId != null
        ? { sql: "provider_session_id=?", value: input.providerSessionId }
        : { sql: "session_id=?", value: input.sessionId as string }
    const candidates = this.db
      .prepare(
        `SELECT * FROM app_notifications
         WHERE ${scope.sql} ${input.type ? "AND type=?" : ""}
           AND requires_action=1 AND action_resolved_at IS NULL
           AND status != 'dismissed'
         ORDER BY created_at DESC LIMIT 20`,
      )
      .all(...(input.type ? [scope.value, input.type] : [scope.value])) as unknown as NotificationRow[]

    let match: NotificationRow | undefined
    for (const row of candidates) {
      if (input.eventId && row.event_id && row.event_id === input.eventId) {
        match = row
        break
      }
      if (
        input.providerTurnId &&
        row.provider_turn_id &&
        row.provider_turn_id === input.providerTurnId
      ) {
        match = row
        break
      }
    }
    if (!match && candidates.length === 1) match = candidates[0]
    if (!match && !input.eventId && !input.providerTurnId) {
      match = candidates[0]
    }
    if (!match) return null

    const ts = nowIso()
    this.db
      .prepare(
        `UPDATE app_notifications
         SET status=CASE WHEN read_at IS NULL THEN 'unread' ELSE 'resolved' END,
             action_resolved_at=?,
             updated_at=?,
             requires_action=1
         WHERE id=?`,
      )
      .run(ts, ts, match.id)
    // Keep requiresAction true historically but mark resolved; list filter uses actionResolvedAt.
    const notification = this.get(match.id)
    if (notification) {
      this.emit({ type: "notification.updated", notification })
      this.emitCounts()
    }
    return notification
  }

  updateDelivery(
    id: string,
    delivery: NonNullable<AppNotification["delivery"]>,
  ): AppNotification | null {
    const existing = this.get(id)
    if (!existing) return null
    const merged = { ...(existing.delivery ?? {}), ...delivery }
    this.db
      .prepare(
        `UPDATE app_notifications SET delivery_json=?, updated_at=? WHERE id=?`,
      )
      .run(JSON.stringify(merged), nowIso(), id)
    return this.get(id)
  }

  runRetention(now = new Date()): { deleted: number } {
    const prefs = this.getPreferences()
    const cutoff = new Date(
      now.getTime() - prefs.retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString()

    // Bound SELECT — never load the full deletable set into memory.
    const deletable = this.db
      .prepare(
        `SELECT id, created_at FROM app_notifications
         WHERE
           NOT (requires_action=1 AND action_resolved_at IS NULL)
           AND NOT (status='unread' AND (severity='error' OR type='failed'))
           AND (
             status='dismissed'
             OR (status IN ('read','resolved') AND created_at < ?)
           )
         ORDER BY
           CASE status WHEN 'dismissed' THEN 0 WHEN 'read' THEN 1 ELSE 2 END,
           created_at ASC
         LIMIT 500`,
      )
      .all(cutoff) as unknown as Array<{ id: string; created_at: string }>

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM app_notifications`).get() as {
        n: number
      }
    ).n

    let toDeleteIds = deletable
      .filter(row => row.created_at < cutoff)
      .map(row => row.id)

    const over = Math.max(0, Number(total) - prefs.maxRetained)
    if (over > 0) {
      const extras = deletable.slice(0, Math.max(over, toDeleteIds.length))
      const ids = new Set(toDeleteIds)
      for (const row of extras) ids.add(row.id)
      toDeleteIds = [...ids]
    }

    let deleted = 0
    if (toDeleteIds.length > 0) {
      const del = this.db.prepare(`DELETE FROM app_notifications WHERE id=?`)
      this.db.exec("BEGIN")
      try {
        for (const id of toDeleteIds) {
          // Bound each retention pass so notification ingestion cannot monopolize
          // the host event loop even when upgrading an old, very large database.
          if (deleted >= 500) break
          const result = del.run(id)
          deleted += Number(result.changes) || 0
        }
        this.db.exec("COMMIT")
      } catch (error) {
        try {
          this.db.exec("ROLLBACK")
        } catch {
          /* preserve the original failure */
        }
        throw error
      }
    }
    if (deleted > 0) this.emitCounts()
    return { deleted }
  }

  private runRetentionAsync(): void {
    if (this.retentionScheduled) return
    this.retentionScheduled = true
    queueMicrotask(() => {
      try {
        this.runRetention()
      } catch {
        /* ignore retention errors */
      } finally {
        this.retentionScheduled = false
      }
    })
  }

  private emitCounts(): void {
    this.emit({ type: "notification.counts-updated", counts: this.counts() })
  }

  private findDuplicate(input: {
    sessionId: string | null
    type: NotificationType
    eventId: string | null
    providerTurnId: string | null
    providerSessionId: string | null
    contentHash: string
  }): AppNotification | null {
    if (!input.sessionId && !input.providerSessionId) return null
    const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString()
    // A provider session joins interactive events to telemetry even when the
    // two producers use different YAADE session ids. Exact event/turn keys
    // below still keep distinct native turns separate.
    const scope =
      input.providerSessionId != null
        ? { sql: "provider_session_id=?", value: input.providerSessionId }
        : { sql: "session_id=?", value: input.sessionId as string }

    if (input.eventId) {
      const row = this.db
        .prepare(
          `SELECT * FROM app_notifications
           WHERE ${scope.sql} AND type=? AND event_id=?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(scope.value, input.type, input.eventId) as
        | NotificationRow
        | undefined
      if (row) return rowToNotification(row)
    }

    if (input.providerTurnId) {
      const row = this.db
        .prepare(
          `SELECT * FROM app_notifications
           WHERE ${scope.sql} AND type=? AND provider_turn_id=?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(scope.value, input.type, input.providerTurnId) as
        | NotificationRow
        | undefined
      if (row) return rowToNotification(row)
    }

    const row = this.db
      .prepare(
        `SELECT * FROM app_notifications
         WHERE ${scope.sql} AND type=? AND content_hash=? AND created_at >= ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(scope.value, input.type, input.contentHash, since) as
      | NotificationRow
      | undefined
    return row ? rowToNotification(row) : null
  }

  private enrichIfStronger(
    existing: AppNotification,
    raw: IngestNotificationRequest,
    ctx: {
      projectId: string | null
      projectName: string | null
      sessionTitle: string | null
      provider: AgentProvider | null
      severity: AppNotification["severity"]
      requiresAction: boolean
      hash: string
    },
  ): { notification: AppNotification; updated: boolean } {
    const existingRank =
      NOTIFICATION_SOURCE_RANK[existing.source] ?? 0
    const incomingRank = NOTIFICATION_SOURCE_RANK[raw.source] ?? 0
    if (incomingRank <= existingRank) {
      return { notification: existing, updated: false }
    }

    const ts = nowIso()
    const metadata = {
      ...existing.metadata,
      ...(raw.metadata ?? {}),
      enrichedFrom: raw.source,
    }
    this.db
      .prepare(
        `UPDATE app_notifications SET
           source=?,
           title=?,
           message=COALESCE(?, message),
           severity=?,
           project_id=COALESCE(?, project_id),
           project_name=COALESCE(?, project_name),
           session_title=COALESCE(?, session_title),
           provider=COALESCE(?, provider),
           event_id=COALESCE(?, event_id),
           event_sequence=COALESCE(?, event_sequence),
           provider_session_id=COALESCE(?, provider_session_id),
           provider_event=COALESCE(?, provider_event),
           provider_turn_id=COALESCE(?, provider_turn_id),
           requires_action=?,
           metadata_json=?,
           content_hash=?,
           updated_at=?
         WHERE id=?`,
      )
      .run(
        raw.source,
        raw.title,
        raw.message ?? null,
        ctx.severity,
        ctx.projectId,
        ctx.projectName,
        ctx.sessionTitle,
        ctx.provider,
        raw.eventId ?? null,
        raw.eventSequence ?? null,
        raw.providerSessionId ?? null,
        raw.providerEvent ?? null,
        raw.providerTurnId ?? null,
        ctx.requiresAction ? 1 : 0,
        JSON.stringify(metadata),
        ctx.hash,
        ts,
        existing.id,
      )
    const notification = this.get(existing.id)!
    this.emit({ type: "notification.updated", notification })
    this.emitCounts()
    return { notification, updated: true }
  }
}

export function sourceLabel(source: NotificationSource): string {
  return source
}
