import type { DatabaseSync } from "node:sqlite"
import {
  getCliAgentDriver,
  makeProcessExitedEvent,
  makeProcessStartedEvent,
  projectAgentNotification,
  publicAgentSnapshot,
  reduceAgentEvent,
  type AgentEvent,
  type AgentNotification,
  type AgentProvider,
  type AgentSessionSnapshot,
  type NotificationProjectionContext,
} from "@yaade/agent-telemetry"
import type {
  IngestNotificationRequest,
  NotificationType,
} from "@yaade/shared"
import { ensureAgentTelemetrySchema } from "./schema.js"
import type { NotificationService, IngestResult } from "../notifications/service.js"

export type AgentSnapshotStreamEvent =
  | {
      type: "agents.snapshot"
      sessionId: string
      snapshot: Omit<AgentSessionSnapshot, "_internal">
      nativeSessionId?: string
    }
  | {
      type: "agents.event"
      sessionId: string
      event: AgentEvent
    }

export type AgentIngestContext = {
  provider: AgentProvider
  sessionId: string
  processId?: string
  projectId?: string
  cwd?: string
  focusedSessionId?: string | null
  appFocused?: boolean
  projectName?: string
  sessionTitle?: string
}

export type AgentIngestResult = {
  events: AgentEvent[]
  snapshot: Omit<AgentSessionSnapshot, "_internal"> | null
  notifications: AgentNotification[]
  notificationResults: IngestResult[]
}

type EmitFn = (event: AgentSnapshotStreamEvent) => void

/** Keep recent telemetry; prune older rows so SQLite cannot grow forever. */
const MAX_EVENTS_PER_SESSION = 2000
const EVENT_TTL_MS = 14 * 24 * 60 * 60 * 1000
const PRUNE_EVERY_N_PERSISTS = 32

function nowIso(): string {
  return new Date().toISOString()
}

function asAgentProvider(value: string | null | undefined): AgentProvider | null {
  if (
    value === "claude" ||
    value === "codex" ||
    value === "cursor" ||
    value === "opencode" ||
    value === "grok" ||
    value === "pi"
  ) {
    return value
  }
  return null
}

function mapNotifKindToType(
  kind: AgentNotification["kind"],
): NotificationType {
  switch (kind) {
    case "permission_required":
      return "permission-required"
    case "turn_completed":
      return "turn-completed"
    case "turn_failed":
    case "session_failed":
      return "failed"
    case "session_terminated":
      return "process-exited"
  }
}

function agentNotifToIngest(
  n: AgentNotification,
  ctx: AgentIngestContext & { nativeSessionId?: string },
): IngestNotificationRequest {
  return {
    source: "provider-hook",
    provider: n.provider,
    type: mapNotifKindToType(n.kind),
    severity:
      n.severity === "error"
        ? "error"
        : n.severity === "warning"
          ? "warning"
          : "info",
    title: n.title,
    message: n.message,
    sessionId: n.sessionId,
    projectId: n.projectId ?? ctx.projectId ?? null,
    projectName: ctx.projectName ?? null,
    sessionTitle: ctx.sessionTitle ?? null,
    eventId: n.sourceEventId,
    providerTurnId: n.providerTurnId ?? null,
    providerSessionId: ctx.nativeSessionId ?? null,
    providerEvent: n.kind,
    requiresAction: n.kind === "permission_required",
    metadata: {
      agentNotificationKind: n.kind,
      sourceEventId: n.sourceEventId,
      persistent: n.persistent,
    },
  }
}

export class AgentTelemetryService {
  private readonly snapshots = new Map<string, AgentSessionSnapshot>()
  private persistCount = 0

  constructor(
    private readonly db: DatabaseSync,
    private readonly notifications: NotificationService,
    private readonly emit: EmitFn,
    /** Run lifecycle owns process truth; telemetry only enriches it. */
    /** False keeps late history but suppresses actionable notification projection. */
    private readonly onAppliedEvent?: (event: AgentEvent) => boolean,
  ) {
    ensureAgentTelemetrySchema(db)
    this.pruneEvents()
  }

  private loadSnapshot(sessionId: string): AgentSessionSnapshot | undefined {
    const cached = this.snapshots.get(sessionId)
    if (cached) return cached
    try {
      const row = this.db
        .prepare(
          `SELECT snapshot_json FROM agent_session_snapshots WHERE session_id = ?`,
        )
        .get(sessionId) as { snapshot_json: string } | undefined
      if (!row) return undefined
      const snap = JSON.parse(row.snapshot_json) as AgentSessionSnapshot
      this.snapshots.set(sessionId, snap)
      return snap
    } catch {
      return undefined
    }
  }

  getSnapshot(
    sessionId: string,
  ): Omit<AgentSessionSnapshot, "_internal"> | null {
    const snap = this.loadSnapshot(sessionId)
    return snap ? publicAgentSnapshot(snap) : null
  }

  listEvents(
    sessionId: string,
    opts?: { limit?: number; before?: string },
  ): AgentEvent[] {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500)
    const rows = opts?.before
      ? (this.db
          .prepare(
            `SELECT payload_json FROM agent_events
             WHERE session_id = ? AND occurred_at < ?
             ORDER BY occurred_at DESC LIMIT ?`,
          )
          .all(sessionId, opts.before, limit) as Array<{
          payload_json: string
        }>)
      : (this.db
          .prepare(
            `SELECT payload_json FROM agent_events
             WHERE session_id = ?
             ORDER BY occurred_at DESC LIMIT ?`,
          )
          .all(sessionId, limit) as Array<{ payload_json: string }>)
    const events: AgentEvent[] = []
    for (const row of rows) {
      try {
        events.push(JSON.parse(row.payload_json) as AgentEvent)
      } catch {
        /* skip */
      }
    }
    return events.reverse()
  }

  /** Apply one already-normalized AgentEvent. */
  applyEvent(
    event: AgentEvent,
    projection?: NotificationProjectionContext,
  ): AgentIngestResult {
    const prev = this.loadSnapshot(event.sessionId)
    const driver = getCliAgentDriver(event.provider)
    const next = reduceAgentEvent(prev, event, {
      capabilities: driver.getCapabilities(),
    })
    this.snapshots.set(event.sessionId, next)
    this.persistEvent(event)
    this.persistSnapshot(next)
    let actionable = true
    try {
      actionable = this.onAppliedEvent?.(event) ?? true
    } catch {
      // Telemetry remains useful even if the durable run projection is briefly
      // unavailable (for example during a migration retry).
    }

    const pub = publicAgentSnapshot(next)
    this.emit({
      type: "agents.event",
      sessionId: event.sessionId,
      event,
    })
    this.emit({
      type: "agents.snapshot",
      sessionId: event.sessionId,
      snapshot: pub,
      nativeSessionId: next.nativeSessionId || undefined,
    })

    if (!actionable) {
      return {
        events: [event],
        snapshot: pub,
        notifications: [],
        notificationResults: [],
      }
    }

    const ctx: NotificationProjectionContext = projection ?? {}
    const projected = projectAgentNotification(event, ctx)
    const notifications: AgentNotification[] = projected ? [projected] : []
    const notificationResults: IngestResult[] = []

    // First user prompt → durable session title for sidebar / roster.
    if (event.kind === "prompt.submitted") {
      const promptRaw = event.metadata?.prompt
      if (typeof promptRaw === "string") {
        const title = promptRaw.replace(/\s+/g, " ").trim().slice(0, 72)
        const binding = this.notifications.bindingForSession(event.sessionId)
        const current = (binding?.sessionTitle ?? ctx.sessionTitle ?? "").trim()
        const generic =
          !current ||
          /^(cursor|claude|codex|opencode|grok|pi|agent|terminal|cursor agent)$/i.test(
            current,
          )
        if (title && generic) {
          this.notifications.bindSession({
            sessionId: event.sessionId,
            projectId: binding?.projectId ?? event.projectId ?? null,
            projectName: binding?.projectName ?? ctx.projectName ?? null,
            sessionTitle: title,
            provider: event.provider,
            ptyId: binding?.ptyId ?? null,
          })
          // App listens for notification.created.sessionTitle to refresh sidebar.
          notificationResults.push(
            this.notifications.ingest({
              source: "provider-hook",
              provider: event.provider,
              type: "provider-notification",
              title,
              message: null,
              sessionId: event.sessionId,
              projectId: binding?.projectId ?? event.projectId ?? null,
              projectName: binding?.projectName ?? ctx.projectName ?? null,
              sessionTitle: title,
              eventId: `session-title:${event.id}`,
              providerSessionId: event.nativeSessionId || null,
              providerEvent: "session-title",
              requiresAction: false,
              metadata: { sessionTitleFrom: "prompt" },
            }),
          )
        }
      }
    }

    // Resume path: surface native session id immediately on session start/resume
    // even when no attention notification is projected.
    if (
      (event.kind === "session.started" || event.kind === "session.resumed") &&
      event.nativeSessionId
    ) {
      notificationResults.push(
        this.notifications.ingest({
          source: "provider-hook",
          provider: event.provider,
          type: "session-started",
          title: `${event.provider} session started`,
          message: null,
          sessionId: event.sessionId,
          projectId: event.projectId ?? null,
          eventId: event.id,
          providerSessionId: event.nativeSessionId,
          providerEvent: event.kind,
          requiresAction: false,
          metadata: { agentEventKind: event.kind },
        }),
      )
    }

    // Resolve permission notifications when permission.resolved arrives.
    if (event.kind === "permission.resolved" && event.permission?.id) {
      this.notifications.ingest({
        source: "provider-hook",
        provider: event.provider,
        type: "permission-required",
        title: "Permission resolved",
        message: null,
        sessionId: event.sessionId,
        eventId: `resolve:${event.id}`,
        requiresAction: false,
        resolveOf: {
          type: "permission-required",
          eventId: null,
          providerSessionId: event.nativeSessionId || null,
          providerTurnId: null,
        },
        metadata: { resolvedPermissionId: event.permission.id },
      })
    }

    for (const n of notifications) {
      const result = this.notifications.ingest(
        agentNotifToIngest(n, {
          provider: event.provider,
          sessionId: event.sessionId,
          projectId: event.projectId,
          nativeSessionId: event.nativeSessionId || undefined,
        }),
      )
      notificationResults.push(result)
    }

    return {
      events: [event],
      snapshot: pub,
      notifications,
      notificationResults,
    }
  }

  /** Normalize a native provider hook body and apply resulting events. */
  ingestNative(
    payload: unknown,
    context: AgentIngestContext,
  ): AgentIngestResult {
    const driver = getCliAgentDriver(context.provider)
    const binding = this.notifications.bindingForSession(context.sessionId)
    const processId =
      context.processId ??
      binding?.ptyId ??
      `session:${context.sessionId}`
    const receivedAt = nowIso()
    const normalized = driver.normalizeHookEvent({
      payload,
      sessionId: context.sessionId,
      processId,
      provider: context.provider,
      receivedAt,
      projectId: context.projectId ?? binding?.projectId ?? undefined,
      cwd: context.cwd,
    })

    const allEvents: AgentEvent[] = []
    const allNotifs: AgentNotification[] = []
    const allNotifResults: IngestResult[] = []
    let lastSnap: Omit<AgentSessionSnapshot, "_internal"> | null = null

    const projection: NotificationProjectionContext = {
      focusedSessionId: context.focusedSessionId,
      appFocused: context.appFocused,
      projectName: context.projectName ?? binding?.projectName ?? undefined,
      sessionTitle: context.sessionTitle ?? binding?.sessionTitle ?? undefined,
    }

    for (const event of normalized) {
      const result = this.applyEvent(event, projection)
      allEvents.push(...result.events)
      allNotifs.push(...result.notifications)
      allNotifResults.push(...result.notificationResults)
      lastSnap = result.snapshot
    }

    return {
      events: allEvents,
      snapshot: lastSnap,
      notifications: allNotifs,
      notificationResults: allNotifResults,
    }
  }

  onProcessStarted(input: {
    provider: AgentProvider
    sessionId: string
    processId: string
    nativeSessionId?: string
    nativeProcessId?: number
    projectId?: string
    cwd?: string
  }): AgentIngestResult {
    return this.applyEvent(makeProcessStartedEvent(input))
  }

  onProcessExited(input: {
    provider: AgentProvider
    sessionId: string
    processId: string
    nativeSessionId?: string
    exitCode?: number
    expectedExit?: boolean
    projectId?: string
    cwd?: string
  }): AgentIngestResult {
    return this.applyEvent(makeProcessExitedEvent(input))
  }

  /**
   * Drop in-memory + DB snapshot for a session (events pruned by retention).
   * Call when the terminal/session is disposed from the roster.
   */
  disposeSession(sessionId: string): void {
    if (!sessionId) return
    this.snapshots.delete(sessionId)
    try {
      this.db
        .prepare(`DELETE FROM agent_session_snapshots WHERE session_id = ?`)
        .run(sessionId)
    } catch {
      /* ignore */
    }
    this.pruneEvents(sessionId)
  }

  private persistEvent(event: AgentEvent): void {
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO agent_events(
            id, session_id, provider, kind, occurred_at, received_at,
            native_session_id, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.sessionId,
          event.provider,
          event.kind,
          event.occurredAt,
          event.receivedAt,
          event.nativeSessionId || null,
          JSON.stringify(event),
        )
      this.persistCount += 1
      if (this.persistCount % PRUNE_EVERY_N_PERSISTS === 0) {
        this.pruneEvents(event.sessionId)
      }
    } catch {
      /* ignore persistence errors — in-memory still updated */
    }
  }

  /** Delete events older than TTL; when sessionId set, also cap that session. */
  pruneEvents(sessionId?: string): { deleted: number } {
    let deleted = 0
    try {
      const cutoff = new Date(Date.now() - EVENT_TTL_MS).toISOString()
      const ttlResult = this.db
        .prepare(`DELETE FROM agent_events WHERE occurred_at < ?`)
        .run(cutoff)
      deleted += Number(ttlResult.changes) || 0

      if (sessionId) {
        const result = this.db
          .prepare(
            `DELETE FROM agent_events
             WHERE session_id = ?
               AND id NOT IN (
                 SELECT id FROM agent_events
                 WHERE session_id = ?
                 ORDER BY occurred_at DESC
                 LIMIT ?
               )`,
          )
          .run(sessionId, sessionId, MAX_EVENTS_PER_SESSION)
        deleted += Number(result.changes) || 0
      }
    } catch {
      /* ignore prune errors */
    }
    return { deleted }
  }

  private persistSnapshot(snap: AgentSessionSnapshot): void {
    try {
      const pub = publicAgentSnapshot(snap)
      this.db
        .prepare(
          `INSERT INTO agent_session_snapshots(
            session_id, provider, native_session_id, snapshot_json, updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            provider=excluded.provider,
            native_session_id=excluded.native_session_id,
            snapshot_json=excluded.snapshot_json,
            updated_at=excluded.updated_at`,
        )
        .run(
          snap.id,
          snap.provider,
          snap.nativeSessionId || null,
          JSON.stringify(pub),
          nowIso(),
        )
    } catch {
      /* ignore */
    }
  }
}

export function parseAgentProviderParam(
  value: string | null,
): AgentProvider | null {
  return asAgentProvider(value)
}
