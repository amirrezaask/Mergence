export type AgentNotificationKind =
  | "permission_required"
  | "turn_completed"
  | "turn_failed"
  | "session_failed"
  | "session_terminated"

export interface AgentNotification {
  id: string
  kind: AgentNotificationKind

  sessionId: string
  projectId?: string
  provider: import("../types/events.js").AgentProvider

  title: string
  message: string

  createdAt: string
  readAt?: string
  resolvedAt?: string

  severity: "info" | "warning" | "error"
  persistent: boolean

  action: {
    type: "open_session"
    sessionId: string
  }

  sourceEventId: string
  /** Native turn id when present — used for OSC/hook notification dedupe. */
  providerTurnId?: string
}

export interface NotificationProjectionContext {
  /** Session currently focused in the UI. */
  focusedSessionId?: string | null
  /** Application / window focused. */
  appFocused?: boolean
  /** User has viewed this session since the active turn started. */
  sessionViewedSinceTurnStart?: boolean
  projectName?: string
  sessionTitle?: string
}

import type { AgentEvent } from "../types/events.js"

function providerLabel(provider: AgentEvent["provider"]): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

function projectName(ctx: NotificationProjectionContext): string {
  return ctx.projectName?.trim() || ctx.sessionTitle?.trim() || "the project"
}

function turnId(event: AgentEvent): string | undefined {
  const id = event.turn?.id || event.turn?.nativeId
  return id?.trim() || undefined
}

/** Prefer native turn id for notification eventId so OSC + hook dedupe. */
function notificationEventId(event: AgentEvent): string {
  return turnId(event) ?? event.permission?.id ?? event.id
}

/**
 * Project a single AgentEvent into an in-app notification, or null when none.
 * Drivers must never create notifications themselves.
 */
export function projectAgentNotification(
  event: AgentEvent,
  context: NotificationProjectionContext,
): AgentNotification | null {
  const label = providerLabel(event.provider)
  const project = projectName(context)
  const sessionFocused = context.focusedSessionId === event.sessionId
  const appFocused = context.appFocused !== false
  const viewed = context.sessionViewedSinceTurnStart === true

  switch (event.kind) {
    case "permission.requested": {
      const tool = event.permission?.toolName ?? event.tool?.name
      return {
        id: `notif:${event.id}`,
        kind: "permission_required",
        sessionId: event.sessionId,
        projectId: event.projectId,
        provider: event.provider,
        title: `${label} needs permission`,
        message: tool
          ? `The agent wants to run ${tool} in ${project}.`
          : `The agent needs permission in ${project}.`,
        createdAt: event.receivedAt,
        severity: "warning",
        persistent: true,
        action: { type: "open_session", sessionId: event.sessionId },
        sourceEventId: notificationEventId(event),
        providerTurnId: turnId(event),
      }
    }
    case "turn.completed": {
      // In-app unread when not focused / not viewed; OS rules applied by host.
      if (sessionFocused && appFocused && viewed) return null
      if (sessionFocused && appFocused) return null
      return {
        id: `notif:${event.id}`,
        kind: "turn_completed",
        sessionId: event.sessionId,
        projectId: event.projectId,
        provider: event.provider,
        title: `${label} completed the turn`,
        message: `The latest turn in ${project} is ready for review.`,
        createdAt: event.receivedAt,
        severity: "info",
        persistent: false,
        action: { type: "open_session", sessionId: event.sessionId },
        sourceEventId: notificationEventId(event),
        providerTurnId: turnId(event),
      }
    }
    case "turn.failed":
      return {
        id: `notif:${event.id}`,
        kind: "turn_failed",
        sessionId: event.sessionId,
        projectId: event.projectId,
        provider: event.provider,
        title: `${label} turn failed`,
        message: `The agent encountered an error before completing the task.`,
        createdAt: event.receivedAt,
        severity: "error",
        persistent: true,
        action: { type: "open_session", sessionId: event.sessionId },
        sourceEventId: notificationEventId(event),
        providerTurnId: turnId(event),
      }
    case "session.failed":
      return {
        id: `notif:${event.id}`,
        kind: "session_failed",
        sessionId: event.sessionId,
        projectId: event.projectId,
        provider: event.provider,
        title: `${label} session failed`,
        message: `The session ended with an error.`,
        createdAt: event.receivedAt,
        severity: "error",
        persistent: true,
        action: { type: "open_session", sessionId: event.sessionId },
        sourceEventId: event.id,
      }
    case "process.exited": {
      const expected = event.metadata?.expectedExit === true
      const code =
        typeof event.metadata?.exitCode === "number"
          ? event.metadata.exitCode
          : null
      if (expected || code === 0) return null
      return {
        id: `notif:${event.id}`,
        kind: "session_terminated",
        sessionId: event.sessionId,
        projectId: event.projectId,
        provider: event.provider,
        title: `${label} session terminated`,
        message:
          code != null
            ? `The CLI process exited unexpectedly with code ${code}.`
            : `The CLI process exited unexpectedly.`,
        createdAt: event.receivedAt,
        severity: "error",
        persistent: true,
        action: { type: "open_session", sessionId: event.sessionId },
        sourceEventId: event.id,
      }
    }
    default:
      return null
  }
}

/** Whether a turn-complete should raise a desktop OS notification. */
export function shouldDeliverDesktopNotification(
  event: AgentEvent,
  context: NotificationProjectionContext,
): boolean {
  if (event.kind === "permission.requested") return true
  if (
    event.kind === "turn.failed" ||
    event.kind === "session.failed" ||
    event.kind === "process.exited"
  ) {
    return true
  }
  if (event.kind !== "turn.completed") return false
  const sessionFocused = context.focusedSessionId === event.sessionId
  const appFocused = context.appFocused !== false
  if (sessionFocused && appFocused) return false
  return true
}
