import type {
  AgentEvent,
  AgentEventKind,
  AgentProvider,
  AgentToolCategory,
} from "../types/events.js"
import { makeAgentEventId } from "../ids.js"
import type { NativeHookInput } from "../types/driver.js"

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function asString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const t = value.trim()
  return t ? t : null
}

export function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const v = asString(obj[key])
    if (v) return v
  }
  return null
}

export function classifyGenericTool(name: string): AgentToolCategory {
  const n = name.toLowerCase()
  if (
    /read|cat|view|get_file|read_file|readfile/.test(n)
  ) {
    return "file_read"
  }
  if (
    /write|edit|apply_patch|str_replace|create_file|delete_file|write_file/.test(
      n,
    )
  ) {
    return "file_write"
  }
  if (/bash|shell|terminal|exec|command|run/.test(n)) return "shell"
  if (/grep|search|glob|find|rg|semantic/.test(n)) return "search"
  if (/web|fetch|browser|http|crawl/.test(n)) return "web"
  if (/mcp|server/.test(n)) return "mcp"
  if (/task|todo|plan/.test(n)) return "task"
  if (/agent|subagent|task_tool/.test(n)) return "subagent"
  return "other"
}

export type EventBuildInput = {
  input: NativeHookInput
  kind: AgentEventKind
  nativeEventName: string
  nativeSessionId: string
  nativeTurnId?: string
  nativeToolId?: string
  nativePermissionId?: string
  salt?: string
  tool?: AgentEvent["tool"]
  permission?: AgentEvent["permission"]
  subagent?: AgentEvent["subagent"]
  file?: AgentEvent["file"]
  turn?: AgentEvent["turn"]
  metadata?: AgentEvent["metadata"]
  occurredAt?: string
}

export function buildEvent(b: EventBuildInput): AgentEvent {
  const occurredAt = b.occurredAt ?? b.input.receivedAt
  return {
    schemaVersion: 1,
    id: makeAgentEventId({
      provider: b.input.provider,
      nativeSessionId: b.nativeSessionId,
      kind: b.kind,
      nativeTurnId: b.nativeTurnId,
      nativeToolId: b.nativeToolId,
      nativePermissionId: b.nativePermissionId,
      nativeEventName: b.nativeEventName,
      salt: b.salt,
    }),
    kind: b.kind,
    provider: b.input.provider,
    occurredAt,
    receivedAt: b.input.receivedAt,
    processId: b.input.processId,
    nativeProcessId: b.input.nativeProcessId,
    sessionId: b.input.sessionId,
    nativeSessionId: b.nativeSessionId,
    projectId: b.input.projectId,
    cwd: b.input.cwd,
    turn: b.turn,
    tool: b.tool,
    permission: b.permission,
    subagent: b.subagent,
    file: b.file,
    metadata: b.metadata,
    source: {
      nativeEventName: b.nativeEventName,
      providerVersion: b.input.providerVersion,
    },
  }
}

/** Bound user prompt text for session-title derivation in the app. */
export function extractPromptMetadata(
  raw: Record<string, unknown>,
): Record<string, string> | undefined {
  const prompt = pickString(raw, [
    "prompt",
    "user_prompt",
    "userPrompt",
    "text",
    "message",
  ])
  if (!prompt) return undefined
  return { prompt: prompt.slice(0, 500) }
}

export function extractNativeSessionId(
  raw: Record<string, unknown>,
  extras: Array<string | null | undefined> = [],
): string {
  for (const e of extras) {
    if (e?.trim()) return e.trim()
  }
  return (
    pickString(raw, [
      "session_id",
      "sessionId",
      "thread-id",
      "thread_id",
      "threadId",
      "conversation_id",
      "chat_id",
      "id",
    ]) ?? ""
  )
}

/** Soft detect — host may enrich with real `which`/`--version` later. */
export async function detectBinary(
  binary: string,
): Promise<{ available: boolean; binary: string; version?: string; error?: string }> {
  return { available: true, binary }
}

export function emptyInstall(
  driver: "hook" | "osc" | "plugin",
  env: Record<string, string> = {},
): { launchArgs: string[]; env: Record<string, string>; driver: "hook" | "osc" | "plugin" } {
  return { launchArgs: [], env, driver }
}

export function yaadeEnv(
  context: { sessionId: string; ingestUrl: string; provider: AgentProvider },
): Record<string, string> {
  return {
    YAADE_SESSION_ID: context.sessionId,
    YAADE_INGEST_URL: context.ingestUrl,
    YAADE_PROVIDER: context.provider,
  }
}
