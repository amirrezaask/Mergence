import type {
  AgentProvider,
  IngestNotificationRequest,
  NotificationSeverity,
  NotificationType,
} from "@yaade/shared"
import {
  severityForNotificationType,
  typeRequiresAction,
} from "@yaade/shared"
import { normalizeHookEventName } from "./osc.js"

const MAX_ID_LENGTH = 512
const MAX_TITLE_LENGTH = 240
const MAX_MESSAGE_LENGTH = 8_000
const MAX_METADATA_BYTES = 16 * 1024

const PROVIDERS = new Set<AgentProvider>([
  "claude",
  "cursor",
  "codex",
  "opencode",
  "grok",
  "pi",
  "shell",
  "system",
])
const TYPES = new Set<NotificationType>([
  "turn-completed",
  "input-required",
  "permission-required",
  "failed",
  "process-exited",
  "session-started",
  "provider-notification",
  "background-output",
  "system",
])
const SEVERITIES = new Set<NotificationSeverity>([
  "info",
  "success",
  "warning",
  "error",
])

export type ProviderHookContext = {
  provider?: string | null
  sessionId?: string | null
  projectId?: string | null
  projectName?: string | null
  sessionTitle?: string | null
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function cleanText(
  value: unknown,
  maxLength: number,
  preserveLines = false,
): string | null {
  if (typeof value !== "string") return null
  const withoutControls = value.replace(
    preserveLines ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g,
    "",
  )
  const trimmed = withoutControls.trim()
  if (!trimmed) return null
  return trimmed.slice(0, maxLength)
}

function cleanId(value: unknown): string | null {
  return cleanText(value, MAX_ID_LENGTH)
}

function asProvider(value: unknown): AgentProvider | null {
  return typeof value === "string" && PROVIDERS.has(value as AgentProvider)
    ? (value as AgentProvider)
    : null
}

function asType(value: unknown): NotificationType | null {
  return typeof value === "string" && TYPES.has(value as NotificationType)
    ? (value as NotificationType)
    : null
}

function asSeverity(value: unknown): NotificationSeverity | null {
  return typeof value === "string" &&
    SEVERITIES.has(value as NotificationSeverity)
    ? (value as NotificationSeverity)
    : null
}

function boundedMetadata(value: unknown): Record<string, unknown> {
  const input = record(value)
  if (!input) return {}
  try {
    const json = JSON.stringify(input)
    if (Buffer.byteLength(json, "utf8") > MAX_METADATA_BYTES) {
      return { truncated: true }
    }
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return {}
  }
}

function claudeType(raw: Record<string, unknown>): NotificationType {
  const hookEvent = cleanText(raw.hook_event_name, 80)?.toLowerCase()
  const notificationType = cleanText(raw.notification_type, 80)?.toLowerCase()
  if (hookEvent === "stop") return "turn-completed"
  if (hookEvent === "stopfailure") return "failed"
  if (hookEvent === "sessionstart") return "session-started"
  if (hookEvent === "sessionend") return "process-exited"
  if (hookEvent === "permissionrequest") return "permission-required"
  if (hookEvent === "notification") {
    if (notificationType?.includes("permission")) return "permission-required"
    if (
      notificationType === "idle_prompt" ||
      notificationType?.includes("elicitation")
    ) {
      return "input-required"
    }
  }
  return normalizeHookEventName(hookEvent) ?? "provider-notification"
}

function opencodeEvent(raw: Record<string, unknown>): {
  name: string | null
  payload: Record<string, unknown>
} {
  const event = record(raw.event)
  if (!event) {
    return {
      name: cleanText(raw.event_type ?? raw.providerEvent, 120),
      payload: raw,
    }
  }
  return {
    name: cleanText(event.type, 120),
    payload: record(event.properties) ?? event,
  }
}

function isOpenCodePermissionAsked(name: string | null): boolean {
  return name === "permission.asked" || name === "permission.v2.asked"
}

function isOpenCodePermissionReplied(name: string | null): boolean {
  return name === "permission.replied" || name === "permission.v2.replied"
}

function hookType(
  raw: Record<string, unknown>,
  provider: AgentProvider | null,
): NotificationType {
  const explicit = asType(raw.type)
  if (explicit) return explicit
  if (provider === "claude" || typeof raw.hook_event_name === "string") {
    return claudeType(raw)
  }
  if (provider === "opencode" || raw.event != null) {
    const { name } = opencodeEvent(raw)
    if (name === "session.idle") return "turn-completed"
    if (name === "session.error") return "failed"
    if (isOpenCodePermissionAsked(name)) return "permission-required"
    if (isOpenCodePermissionReplied(name)) return "permission-required"
    if (name === "session.created") return "session-started"
    return normalizeHookEventName(name) ?? "provider-notification"
  }
  return (
    normalizeHookEventName(
      cleanText(raw.providerEvent ?? raw.event_type ?? raw.type, 120),
    ) ?? "provider-notification"
  )
}

function defaultTitle(
  provider: AgentProvider | null,
  type: NotificationType,
): string {
  const label = provider
    ? `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`
    : "Agent"
  switch (type) {
    case "turn-completed":
      return `${label} completed the turn`
    case "permission-required":
      return `${label} needs permission`
    case "input-required":
      return `${label} needs input`
    case "failed":
      return `${label} failed`
    case "process-exited":
      return `${label} session ended`
    case "session-started":
      return `${label} session started`
    default:
      return `${label} notification`
  }
}

/**
 * Normalize provider-native hook payloads and the public v1 ingest payload into
 * one bounded request. URL context is authoritative so a provider cannot forge
 * another Yaade session/project.
 */
export function normalizeProviderHookRequest(
  value: unknown,
  context: ProviderHookContext = {},
): IngestNotificationRequest {
  const raw = record(value)
  if (!raw) throw new Error("notification hook body must be an object")

  const provider =
    asProvider(context.provider) ??
    asProvider(raw.provider) ??
    (typeof raw.hook_event_name === "string" ? "claude" : null)
  const type = hookType(raw, provider)
  const openCode = opencodeEvent(raw)
  const providerEvent =
    cleanText(
      raw.providerEvent ??
        raw.hook_event_name ??
        openCode.name ??
        raw.event_type ??
        raw.type,
      120,
    ) ?? null
  const providerSessionId =
    cleanId(
      raw.providerSessionId ??
        raw.session_id ??
        raw.sessionId ??
        // Codex notify uses kebab-case `thread-id` (serde rename_all).
        raw["thread-id"] ??
        raw.thread_id ??
        raw.threadId ??
        openCode.payload.sessionID ??
        openCode.payload.sessionId,
    ) ?? null
  const providerTurnId =
    cleanId(
      raw.providerTurnId ??
        raw.prompt_id ??
        raw["turn-id"] ??
        raw.turn_id ??
        raw.turnId ??
        openCode.payload.messageID ??
        openCode.payload.turnId,
    ) ?? null
  // A provider session and lifecycle name identify a stream, not one event.
  // Only synthesize an exact identity when the provider supplied a true
  // per-turn identifier. Otherwise service-level content/window dedupe applies.
  const derivedEventId = providerTurnId
    ? [provider, providerSessionId, providerTurnId, providerEvent]
        .filter(Boolean)
        .join(":")
        .slice(0, MAX_ID_LENGTH) || null
    : null
  const eventId = cleanId(raw.eventId ?? raw.event_id) ?? derivedEventId
  const message =
    cleanText(
      raw.message ??
        raw.last_assistant_message ??
        raw["last-assistant-message"] ??
        raw.error_details ??
        openCode.payload.message ??
        openCode.payload.error,
      MAX_MESSAGE_LENGTH,
      true,
    ) ?? null
  const title =
    cleanText(raw.title, MAX_TITLE_LENGTH) ?? defaultTitle(provider, type)
  const openCodePermissionReply =
    provider === "opencode" && isOpenCodePermissionReplied(openCode.name)
  const requiresAction =
    openCodePermissionReply
      ? false
      : typeof raw.requiresAction === "boolean"
      ? raw.requiresAction
      : typeRequiresAction(type)
  const sequence =
    typeof raw.eventSequence === "number" &&
    Number.isSafeInteger(raw.eventSequence) &&
    raw.eventSequence >= 0
      ? raw.eventSequence
      : null
  const resolveOf =
    openCodePermissionReply
      ? {
          type: "permission-required" as const,
          eventId,
          providerSessionId,
          providerTurnId,
        }
      : undefined

  return {
    source: "provider-hook",
    provider,
    type,
    severity: asSeverity(raw.severity) ?? severityForNotificationType(type),
    title,
    message,
    sessionId: cleanId(context.sessionId) ?? cleanId(raw.sessionId),
    projectId: cleanId(context.projectId) ?? cleanId(raw.projectId),
    projectName:
      cleanText(context.projectName, MAX_TITLE_LENGTH) ??
      cleanText(raw.projectName, MAX_TITLE_LENGTH),
    sessionTitle:
      cleanText(context.sessionTitle, MAX_TITLE_LENGTH) ??
      cleanText(raw.sessionTitle, MAX_TITLE_LENGTH),
    eventId,
    eventSequence: sequence,
    providerSessionId,
    providerEvent,
    providerTurnId,
    requiresAction,
    resolveOf,
    metadata: {
      ...boundedMetadata(raw.metadata),
      hook: true,
      hookEvent: providerEvent,
    },
  }
}
