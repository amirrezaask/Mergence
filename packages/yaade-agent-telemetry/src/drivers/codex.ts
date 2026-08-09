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
  asString,
  buildEvent,
  classifyGenericTool,
  detectBinary,
  extractNativeSessionId,
  extractPromptMetadata,
  yaadeEnv,
  pickString,
} from "./helpers.js"

const CAPABILITIES: AgentDriverCapabilities = {
  sessionLifecycle: true,
  promptLifecycle: true,
  turnLifecycle: "native",
  toolLifecycle: true,
  permissions: true,
  subagents: true,
  compaction: true,
  // Codex PreToolUse is Bash-primary; file edits often lack hooks.
  fileEvents: "unsupported",
}

function eventName(raw: Record<string, unknown>): string {
  return (
    pickString(raw, [
      "hook_event_name",
      "hookEventName",
      "type",
      "event",
      "providerEvent",
    ]) ?? ""
  ).toLowerCase()
}

/**
 * Codex CLI driver — project hooks forwarder + legacy notify= Stop fallback.
 * PreToolUse is Bash-oriented; do not invent file tool events.
 */
export const codexDriver: CliAgentDriver = {
  provider: "codex",

  getCapabilities() {
    return CAPABILITIES
  },

  async detect(): Promise<AgentDriverDetection> {
    return detectBinary("codex")
  },

  async installHooks(
    context: HookInstallationContext,
  ): Promise<HookInstallationResult> {
    const env = yaadeEnv(context)
    // Legacy notify fires on agent stop with JSON argv payload.
    const script =
      'curl --silent --show-error --max-time 5 --request POST --header "content-type: application/json" --data-binary "$1" "$0" >/dev/null'
    const notifyOverride = `notify=${JSON.stringify(["sh", "-c", script, context.ingestUrl])}`
    // Enable experimental hooks when supported; project hooks.json merged by host.
    const featureOverride = "features.codex_hooks=true"
    return {
      launchArgs: ["-c", featureOverride, "-c", notifyOverride],
      env,
      driver: "hook",
      writtenPaths: [], // host merges .codex/hooks.json
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
    const turnId =
      pickString(raw, ["turn_id", "turn-id", "turnId", "prompt_id"]) ??
      undefined
    const events: AgentEvent[] = []
    const base = {
      input,
      nativeSessionId,
      nativeEventName: name || "codex",
      nativeTurnId: turnId,
    }

    // Legacy notify payloads often lack hook_event_name — treat as Stop.
    const isLegacyNotify =
      !name &&
      (raw["thread-id"] != null ||
        raw.thread_id != null ||
        raw["last-assistant-message"] != null)

    if (name === "sessionstart" || name === "session.started") {
      const source = pickString(raw, ["source", "reason"])?.toLowerCase()
      events.push(
        buildEvent({
          ...base,
          kind:
            source === "resume" ? "session.resumed" : "session.started",
        }),
      )
      return events
    }

    if (name === "sessionend" || name === "session.ended") {
      events.push(buildEvent({ ...base, kind: "session.ended" }))
      return events
    }

    if (name === "userpromptsubmit") {
      const promptMeta = extractPromptMetadata(raw)
      events.push(
        buildEvent({
          ...base,
          kind: "prompt.submitted",
          ...(promptMeta ? { metadata: promptMeta } : {}),
        }),
      )
      if (turnId) {
        events.push(
          buildEvent({
            ...base,
            kind: "turn.started",
            turn: { id: turnId, nativeId: turnId },
            salt: "turn-start",
          }),
        )
      }
      return events
    }

    if (name === "pretooluse") {
      const tName =
        pickString(raw, ["tool_name", "toolName"]) ??
        asString(asRecord(raw.tool_input)?.command) ??
        "Bash"
      const tId =
        pickString(raw, ["tool_call_id", "toolCallId", "id"]) ?? tName
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

    if (name === "posttooluse") {
      const tName = pickString(raw, ["tool_name", "toolName"]) ?? "Bash"
      const tId =
        pickString(raw, ["tool_call_id", "toolCallId", "id"]) ?? tName
      const failed =
        raw.error != null ||
        pickString(raw, ["status"])?.toLowerCase() === "failed"
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

    if (name === "permissionrequest") {
      const pId =
        pickString(raw, ["permission_id", "request_id", "id"]) ?? "permission"
      events.push(
        buildEvent({
          ...base,
          kind: "permission.requested",
          nativePermissionId: pId,
          permission: {
            id: pId,
            toolName: pickString(raw, ["tool_name"]) ?? undefined,
            status: "requested",
          },
        }),
      )
      return events
    }

    if (name === "subagentstart") {
      const sId = pickString(raw, ["agent_id", "id"]) ?? "subagent"
      events.push(
        buildEvent({
          ...base,
          kind: "subagent.started",
          salt: sId,
          subagent: { id: sId, nativeId: sId, status: "running" },
        }),
      )
      return events
    }

    if (name === "subagentstop") {
      const sId = pickString(raw, ["agent_id", "id"]) ?? "subagent"
      const failed = raw.error != null
      events.push(
        buildEvent({
          ...base,
          kind: failed ? "subagent.failed" : "subagent.completed",
          salt: sId,
          subagent: {
            id: sId,
            nativeId: sId,
            status: failed ? "failed" : "completed",
          },
        }),
      )
      return events
    }

    if (name === "precompact") {
      events.push(buildEvent({ ...base, kind: "compaction.started" }))
      return events
    }

    if (name === "postcompact") {
      events.push(buildEvent({ ...base, kind: "compaction.completed" }))
      return events
    }

    if (
      name === "stop" ||
      name === "agent-turn-complete" ||
      name === "turn-completed" ||
      name === "turn.completed" ||
      isLegacyNotify
    ) {
      events.push(
        buildEvent({
          ...base,
          kind: "turn.completed",
          turn: turnId ? { id: turnId, nativeId: turnId } : undefined,
        }),
      )
      return events
    }

    return events
  },
}
