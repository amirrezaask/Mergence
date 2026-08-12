import type {
  AgentProvider,
  IngestNotificationRequest,
  NotificationType,
} from "@yaade/shared"

const MAX_OSC_BYTES = 64 * 1024
const MAX_TITLE_LENGTH = 240
const MAX_MESSAGE_LENGTH = 8_000
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

/**
 * Parse provider/system notify OSC sequences from a PTY chunk.
 *
 * Supported:
 * - OSC 9 ; message ST/BEL  (iTerm2 notify)
 * - OSC 777 ; notify ; title ; body ST/BEL
 * - OSC 1337 ; Yaade=notify;<json> ST/BEL
 * - OSC 1337 ; YaadeNotify=<type>|<title>|<message> ST/BEL
 */
export type ParsedOscNotification = Omit<
  IngestNotificationRequest,
  "source"
> & { source: "osc" }

const OSC_RE =
  /\x1b\](?:9;([^\x07\x1b]*)|777;notify;([^\x07\x1b]*);([^\x07\x1b]*)|1337;((?:Yaade=notify;|YaadeNotify=)[^\x07\x1b]*))(?:\x07|\x1b\\)/g

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null
  const text = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
  return text ? text.slice(0, maxLength) : null
}

function cleanId(value: unknown): string | null {
  return cleanText(value, 512)
}

function asType(value: unknown): NotificationType {
  return typeof value === "string" && TYPES.has(value as NotificationType)
    ? (value as NotificationType)
    : "provider-notification"
}

function asProvider(value: unknown): AgentProvider | null {
  return typeof value === "string" && PROVIDERS.has(value as AgentProvider)
    ? (value as AgentProvider)
    : null
}

function parseYaadePayload(payload: string): ParsedOscNotification | null {
  // Yaade=notify;{json} or YaadeNotify=type|title|message
  if (payload.startsWith("Yaade=notify;")) {
    const json = payload.slice("Yaade=notify;".length)
    try {
      const data = JSON.parse(json) as Record<string, unknown>
      const type = asType(data.type)
      const title =
        cleanText(data.title, MAX_TITLE_LENGTH) ?? "Provider notification"
      return {
        source: "osc",
        type,
        title,
        message: cleanText(data.message, MAX_MESSAGE_LENGTH),
        provider: asProvider(data.provider),
        eventId: cleanId(data.eventId),
        providerTurnId: cleanId(data.providerTurnId),
        providerSessionId: cleanId(data.providerSessionId),
        providerEvent: cleanText(data.providerEvent, 120),
        requiresAction:
          typeof data.requiresAction === "boolean" ? data.requiresAction : undefined,
        // OSC is untrusted terminal output. Resolving existing actionable
        // notifications is reserved for the higher-confidence hook path.
        metadata: { osc: 1337 },
      }
    } catch {
      return null
    }
  }
  if (payload.startsWith("YaadeNotify=")) {
    const rest = payload.slice("YaadeNotify=".length)
    const [typeRaw, titleRaw, ...messageParts] = rest.split("|")
    const type = asType(typeRaw)
    const title =
      cleanText(titleRaw, MAX_TITLE_LENGTH) ?? "Provider notification"
    const message = cleanText(messageParts.join("|"), MAX_MESSAGE_LENGTH)
    return {
      source: "osc",
      type,
      title,
      message,
      metadata: { osc: true },
    }
  }
  return null
}

export function parseOscNotifications(chunk: string): ParsedOscNotification[] {
  const out: ParsedOscNotification[] = []
  OSC_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = OSC_RE.exec(chunk)) !== null) {
    if (match[1] != null) {
      const message = cleanText(match[1], MAX_MESSAGE_LENGTH)
      if (!message) continue
      out.push({
        source: "osc",
        type: "provider-notification",
        title: message.slice(0, MAX_TITLE_LENGTH),
        message: message.length > 120 ? message : null,
        metadata: { osc: 9 },
      })
      continue
    }
    if (match[2] != null) {
      const title = cleanText(match[2], MAX_TITLE_LENGTH) ?? "Notification"
      const body = cleanText(match[3], MAX_MESSAGE_LENGTH)
      out.push({
        source: "osc",
        type: "provider-notification",
        title,
        message: body,
        metadata: { osc: 777 },
      })
      continue
    }
    if (match[4]) {
      const parsed = parseYaadePayload(match[4])
      if (parsed) out.push(parsed)
    }
  }
  return out
}

export function parseOscStreamChunk(
  buffered: string,
  chunk: string,
): { notifications: ParsedOscNotification[]; buffered: string } {
  const combined = buffered.length > 0 ? `${buffered}${chunk}` : chunk
  const start = combined.lastIndexOf("\x1b]")
  // Nearly all PTY chunks are ordinary screen output. lastIndexOf above is the
  // one required scan; do not run the notification regex across the same log
  // data again when there cannot be an OSC payload.
  if (start < 0) return { notifications: [], buffered: "" }
  let nextBuffer = ""
  if (start >= 0) {
    const bel = combined.indexOf("\x07", start + 2)
    const stringTerminator = combined.indexOf("\x1b\\", start + 2)
    if (bel < 0 && stringTerminator < 0) {
      const tail = combined.slice(start)
      // Never let an unterminated control sequence retain unbounded PTY
      // output. Once over the cap, discard it and wait for a fresh OSC opener.
      nextBuffer =
        Buffer.byteLength(tail, "utf8") <= MAX_OSC_BYTES ? tail : ""
    }
  }
  return {
    notifications: parseOscNotifications(combined),
    buffered: nextBuffer,
  }
}

/** Map common hook event names → notification types. */
export function normalizeHookEventName(
  event: string | null | undefined,
): NotificationType | null {
  if (!event) return null
  const e = event.toLowerCase().replace(/[_\s]+/g, "-")
  if (
    e.includes("turn-complete") ||
    e.includes("stop") ||
    e === "agent-turn-complete" ||
    e === "completed"
  ) {
    return "turn-completed"
  }
  if (e.includes("permission") || e.includes("approval")) {
    return "permission-required"
  }
  if (e.includes("input") || e.includes("ask-user") || e.includes("question")) {
    return "input-required"
  }
  if (e.includes("fail") || e.includes("error")) {
    return "failed"
  }
  if (e.includes("exit")) return "process-exited"
  if (e.includes("start")) return "session-started"
  return "provider-notification"
}
