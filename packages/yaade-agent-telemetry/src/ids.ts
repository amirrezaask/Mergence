import type { AgentEventKind, AgentProvider } from "./types/events.js"

/** Stable event id from provider + native ids + kind. */
export function makeAgentEventId(parts: {
  provider: AgentProvider
  nativeSessionId: string
  kind: AgentEventKind
  nativeTurnId?: string
  nativeToolId?: string
  nativePermissionId?: string
  nativeEventName?: string
  /** Extra salt when native ids collide across deliveries. */
  salt?: string
}): string {
  const chunks = [
    parts.provider,
    parts.nativeSessionId || "_",
    parts.kind,
    parts.nativeTurnId,
    parts.nativeToolId,
    parts.nativePermissionId,
    parts.nativeEventName,
    parts.salt,
  ].filter((x): x is string => typeof x === "string" && x.length > 0)
  return chunks.join(":").slice(0, 512)
}

/** Deterministic derived turn id when provider lacks native turn hooks. */
export function derivedTurnId(sessionId: string, turnIndex: number): string {
  return `${sessionId}:turn:${turnIndex}`
}

/** Simple non-crypto hash for fallback ids from stable non-sensitive fields. */
export function stableHash(input: string): string {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}
