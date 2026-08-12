/** Stable, versioned notification-center API types (protocol v1). */

export const NOTIFICATION_PROTOCOL_VERSION = 1 as const

export type AgentProvider =
  | "claude"
  | "cursor"
  | "codex"
  | "opencode"
  | "grok"
  | "pi"
  | "shell"
  | "system"

export type NotificationType =
  | "turn-completed"
  | "input-required"
  | "permission-required"
  | "failed"
  | "process-exited"
  | "session-started"
  | "provider-notification"
  | "background-output"
  | "system"

export type NotificationSeverity = "info" | "success" | "warning" | "error"

export type NotificationStatus = "unread" | "read" | "resolved" | "dismissed"

export type NotificationSource =
  | "interactive-runtime"
  | "provider-hook"
  | "provider-plugin"
  | "osc"
  | "process"
  | "system"
  | "aggregated-pty"

export type NotificationFilter =
  | "all"
  | "unread"
  | "action-needed"
  | "completed"
  | "errors"

export interface NotificationDeliveryMetadata {
  desktopAttemptedAt?: string
  desktopDeliveredAt?: string
  desktopSuppressedReason?: string
}

export interface AppNotification {
  id: string

  projectId: string | null
  sessionId: string | null
  /** Durable YAADE agent-run identity when this notification belongs to a run. */
  runId?: string | null

  /** Denormalized for search / UI without joins. */
  projectName: string | null
  sessionTitle: string | null

  provider: AgentProvider | null

  type: NotificationType
  severity: NotificationSeverity
  status: NotificationStatus

  title: string
  message: string | null

  source: NotificationSource

  eventId: string | null
  eventSequence: number | null

  providerSessionId: string | null
  providerEvent: string | null
  providerTurnId: string | null

  requiresAction: boolean
  actionResolvedAt: string | null

  readAt: string | null
  dismissedAt: string | null

  createdAt: string
  updatedAt: string

  metadata: Record<string, unknown>
  delivery?: NotificationDeliveryMetadata
}

export interface NotificationCounts {
  totalUnread: number
  actionRequired: number
  errors: number
}

export interface NotificationPreferences {
  desktopEnabled: boolean
  soundEnabled: boolean

  notifyOnCompleted: boolean
  notifyOnInputRequired: boolean
  notifyOnPermissionRequired: boolean
  notifyOnFailure: boolean

  includeBackgroundOutput: boolean
  backgroundOutputSettleMs: number

  retentionDays: number
  maxRetained: number
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  desktopEnabled: true,
  soundEnabled: false,
  notifyOnCompleted: true,
  notifyOnInputRequired: true,
  notifyOnPermissionRequired: true,
  notifyOnFailure: true,
  includeBackgroundOutput: false,
  backgroundOutputSettleMs: 2_500,
  retentionDays: 30,
  maxRetained: 5_000,
}

export interface ListNotificationsRequest {
  cursor?: string
  limit?: number
  filter?: NotificationFilter
  projectId?: string
  sessionId?: string
  provider?: AgentProvider
  query?: string
}

export interface ListNotificationsResponse {
  items: AppNotification[]
  nextCursor: string | null
  counts: NotificationCounts
}

export interface MarkAllNotificationsReadRequest {
  before?: string
  projectId?: string
  /** When true, only mark items matching the active list filter/query. */
  onlyVisible?: boolean
  filter?: NotificationFilter
  sessionId?: string
  provider?: AgentProvider
  query?: string
}

export interface IngestNotificationRequest {
  projectId?: string | null
  sessionId?: string | null
  projectName?: string | null
  sessionTitle?: string | null
  provider?: AgentProvider | null
  type: NotificationType
  severity?: NotificationSeverity
  title: string
  message?: string | null
  source: NotificationSource
  eventId?: string | null
  eventSequence?: number | null
  providerSessionId?: string | null
  providerEvent?: string | null
  providerTurnId?: string | null
  requiresAction?: boolean
  metadata?: Record<string, unknown>
  /** When set, resolve an existing actionable notification instead of inserting. */
  resolveOf?: {
    type?: NotificationType
    eventId?: string | null
    providerTurnId?: string | null
    providerSessionId?: string | null
  }
}

export type NotificationStreamEvent =
  | {
      type: "notification.created"
      notification: AppNotification
    }
  | {
      type: "notification.updated"
      notification: AppNotification
    }
  | {
      type: "notification.dismissed"
      notificationId: string
    }
  | {
      type: "notification.counts-updated"
      counts: NotificationCounts
    }

export interface BindNotificationSessionRequest {
  sessionId: string
  runId?: string | null
  projectId: string | null
  projectName?: string | null
  sessionTitle?: string | null
  provider?: AgentProvider | null
  ptyId?: string | null
}

/** Source strength for dedupe enrichment (higher wins). */
export const NOTIFICATION_SOURCE_RANK: Record<NotificationSource, number> = {
  "interactive-runtime": 60,
  "provider-hook": 50,
  "provider-plugin": 40,
  osc: 30,
  process: 20,
  system: 15,
  "aggregated-pty": 10,
}

export function severityForNotificationType(
  type: NotificationType,
): NotificationSeverity {
  switch (type) {
    case "turn-completed":
      return "success"
    case "input-required":
    case "permission-required":
      return "warning"
    case "failed":
      return "error"
    case "process-exited":
      return "warning"
    case "session-started":
    case "provider-notification":
    case "background-output":
    case "system":
      return "info"
  }
}

export function typeRequiresAction(type: NotificationType): boolean {
  return type === "input-required" || type === "permission-required"
}
