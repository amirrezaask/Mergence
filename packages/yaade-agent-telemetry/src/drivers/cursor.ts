import type {
  AgentDriverCapabilities,
  AgentDriverDetection,
  CliAgentDriver,
  HookInstallationContext,
  HookInstallationResult,
  NativeHookInput,
} from "../types/driver.js"
import type { AgentEvent, AgentToolCategory } from "../types/events.js"
import {
  asRecord,
  buildEvent,
  classifyGenericTool,
  detectBinary,
  extractNativeSessionId,
  extractPromptMetadata,
  yaadeEnv,
  pickString,
} from "./helpers.js"

/** Cursor CLI hook support is version-dependent; be honest about gaps. */
const CAPABILITIES: AgentDriverCapabilities = {
  sessionLifecycle: true,
  promptLifecycle: true,
  turnLifecycle: "derived",
  toolLifecycle: true,
  permissions: false,
  subagents: false,
  compaction: true,
  fileEvents: "native",
}

function eventName(raw: Record<string, unknown>): string {
  return (
    pickString(raw, [
      "hook_event_name",
      "hookEventName",
      "event",
      "type",
      "providerEvent",
    ]) ?? ""
  )
    .toLowerCase()
    .replace(/_/g, "")
}

/**
 * Cursor CLI driver — project `.cursor/hooks.json` merge + `--trust`.
 * No fake permission/subagent events. App opens interactive PTY immediately;
 * roster waits for hook-native session id (pendingCliMint).
 */
export const cursorDriver: CliAgentDriver = {
  provider: "cursor",

  getCapabilities() {
    return CAPABILITIES
  },

  async detect(): Promise<AgentDriverDetection> {
    return detectBinary("cursor-agent")
  },

  async installHooks(
    context: HookInstallationContext,
  ): Promise<HookInstallationResult> {
    return {
      launchArgs: ["--trust"],
      env: yaadeEnv(context),
      driver: "hook",
      writtenPaths: [], // host merges .cursor/hooks.json
    }
  },

  classifyTool(nativeToolName: string): AgentToolCategory {
    return classifyGenericTool(nativeToolName)
  },

  normalizeHookEvent(input: NativeHookInput): AgentEvent[] {
    const raw = asRecord(input.payload)
    if (!raw) return []
    const name = eventName(raw)
    const nativeSessionId = extractNativeSessionId(raw)
    const events: AgentEvent[] = []
    const base = { input, nativeSessionId, nativeEventName: name || "cursor" }

    if (name === "sessionstart") {
      events.push(buildEvent({ ...base, kind: "session.started" }))
      return events
    }
    if (name === "sessionend") {
      events.push(buildEvent({ ...base, kind: "session.ended" }))
      return events
    }
    if (name === "beforesubmitprompt" || name === "userpromptsubmit") {
      const salt = pickString(raw, ["generation_id", "request_id"]) ?? "prompt"
      const turnId = `${input.sessionId}:turn:${salt}`
      const promptMeta = extractPromptMetadata(raw)
      events.push(
        buildEvent({
          ...base,
          kind: "prompt.submitted",
          salt,
          ...(promptMeta ? { metadata: promptMeta } : {}),
        }),
      )
      events.push(
        buildEvent({
          ...base,
          kind: "turn.started",
          nativeTurnId: turnId,
          turn: { id: turnId },
          salt: `turn:${salt}`,
        }),
      )
      return events
    }
    if (
      name === "pretooluse" ||
      name === "beforeshellexecution" ||
      name === "beforereadfile"
    ) {
      const tName =
        pickString(raw, ["tool_name", "toolName", "command"]) ?? "tool"
      const tId = pickString(raw, ["tool_call_id", "id"]) ?? tName
      events.push(
        buildEvent({
          ...base,
          kind: "tool.started",
          nativeToolId: tId,
          tool: {
            id: tId,
            nativeId: tId,
            name: tName,
            category: classifyGenericTool(tName),
            status: "running",
            startedAt: input.receivedAt,
          },
        }),
      )
      return events
    }
    if (
      name === "posttooluse" ||
      name === "aftershellexecution" ||
      name === "posttoolusefailure"
    ) {
      const tName = pickString(raw, ["tool_name", "toolName"]) ?? "tool"
      const tId = pickString(raw, ["tool_call_id", "id"]) ?? tName
      const failed = name.includes("failure") || raw.error != null
      events.push(
        buildEvent({
          ...base,
          kind: failed ? "tool.failed" : "tool.completed",
          nativeToolId: tId,
          tool: {
            id: tId,
            nativeId: tId,
            name: tName,
            category: classifyGenericTool(tName),
            status: failed ? "failed" : "completed",
            completedAt: input.receivedAt,
          },
        }),
      )
      return events
    }
    if (name === "afterfileedit" || name === "fileedit") {
      const path =
        pickString(raw, ["file_path", "filePath", "path"]) ??
        pickString(asRecord(raw.file) ?? {}, ["path"])
      if (path) {
        events.push(
          buildEvent({
            ...base,
            kind: "file.touched",
            salt: path,
            file: { path, operation: "modify" },
          }),
        )
      }
      return events
    }
    if (name === "precompact") {
      events.push(buildEvent({ ...base, kind: "compaction.started" }))
      return events
    }
    if (name === "stop") {
      events.push(buildEvent({ ...base, kind: "turn.completed" }))
      return events
    }
    return events
  },
}
