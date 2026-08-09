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
  turnLifecycle: "derived",
  toolLifecycle: true,
  permissions: true,
  subagents: true,
  compaction: true,
  fileEvents: "derived",
}

function hookName(raw: Record<string, unknown>): string {
  return (
    pickString(raw, ["hook_event_name", "hookEventName", "event"]) ?? ""
  ).toLowerCase()
}

function toolName(raw: Record<string, unknown>): string {
  return (
    pickString(raw, ["tool_name", "toolName", "name"]) ??
    asString(asRecord(raw.tool)?.name) ??
    "tool"
  )
}

function toolId(raw: Record<string, unknown>, name: string): string {
  return (
    pickString(raw, [
      "tool_use_id",
      "toolUseId",
      "tool_call_id",
      "id",
    ]) ?? name
  )
}

function permissionId(raw: Record<string, unknown>): string {
  return (
    pickString(raw, ["permission_id", "permissionId", "request_id", "id"]) ??
    "permission"
  )
}

function fileFromTool(
  name: string,
  raw: Record<string, unknown>,
): AgentEvent["file"] | undefined {
  const input = asRecord(raw.tool_input) ?? asRecord(raw.input) ?? {}
  const path =
    pickString(input, [
      "file_path",
      "filePath",
      "path",
      "filename",
      "target_file",
    ]) ?? null
  if (!path) return undefined
  const cat = classifyGenericTool(name)
  const operation =
    cat === "file_read"
      ? "read"
      : cat === "file_write"
        ? "modify"
        : undefined
  return { path, operation }
}

/**
 * Claude Code driver — session-scoped HTTP hooks via `--settings`.
 * Turns are derived from UserPromptSubmit → Stop / StopFailure.
 */
export const claudeDriver: CliAgentDriver = {
  provider: "claude",

  getCapabilities() {
    return CAPABILITIES
  },

  async detect(): Promise<AgentDriverDetection> {
    return detectBinary("claude")
  },

  async installHooks(
    context: HookInstallationContext,
  ): Promise<HookInstallationResult> {
    const env = yaadeEnv(context)
    const handler = { type: "http", url: context.ingestUrl, timeout: 5 }
    const entry = { hooks: [handler] }
    const matcherEntry = { matcher: "", ...entry }
    const settings = JSON.stringify({
      hooks: {
        SessionStart: [entry],
        SessionEnd: [entry],
        UserPromptSubmit: [entry],
        PreToolUse: [matcherEntry],
        PostToolUse: [matcherEntry],
        PostToolUseFailure: [matcherEntry],
        PermissionRequest: [matcherEntry],
        Notification: [matcherEntry],
        SubagentStart: [entry],
        SubagentStop: [entry],
        PreCompact: [entry],
        PostCompact: [entry],
        Stop: [entry],
        StopFailure: [entry],
      },
    })
    return {
      launchArgs: ["--settings", settings],
      env,
      driver: "hook",
    }
  },

  classifyTool(nativeToolName: string): AgentToolCategory {
    return classifyGenericTool(nativeToolName)
  },

  normalizeHookEvent(input: NativeHookInput): AgentEvent[] {
    const raw = asRecord(input.payload)
    if (!raw) return []
    const name = hookName(raw)
    const nativeSessionId = extractNativeSessionId(raw)
    const events: AgentEvent[] = []
    const base = { input, nativeSessionId, nativeEventName: name || "unknown" }

    const notificationType = pickString(raw, [
      "notification_type",
      "notificationType",
    ])?.toLowerCase()

    if (name === "sessionstart") {
      const source = pickString(raw, ["source", "reason"])?.toLowerCase()
      const kind =
        source === "resume" || source === "compact"
          ? ("session.resumed" as const)
          : ("session.started" as const)
      events.push(buildEvent({ ...base, kind, nativeEventName: name }))
      return events
    }

    if (name === "sessionend") {
      events.push(
        buildEvent({ ...base, kind: "session.ended", nativeEventName: name }),
      )
      return events
    }

    if (name === "userpromptsubmit") {
      // Deterministic within normalize: use prompt hash salt from session+event
      const promptSalt = pickString(raw, ["prompt_id", "uuid"]) ?? "prompt"
      const derivedId = `${input.sessionId}:turn:${promptSalt}`
      const promptMeta = extractPromptMetadata(raw)
      events.push(
        buildEvent({
          ...base,
          kind: "prompt.submitted",
          nativeEventName: name,
          salt: promptSalt,
          ...(promptMeta ? { metadata: promptMeta } : {}),
        }),
      )
      events.push(
        buildEvent({
          ...base,
          kind: "turn.started",
          nativeEventName: name,
          nativeTurnId: derivedId,
          turn: { id: derivedId },
          salt: `turn-start:${promptSalt}`,
        }),
      )
      return events
    }

    if (name === "pretooluse") {
      const tName = toolName(raw)
      const tId = toolId(raw, tName)
      const category = classifyGenericTool(tName)
      const file = fileFromTool(tName, raw)
      events.push(
        buildEvent({
          ...base,
          kind: "tool.started",
          nativeToolId: tId,
          tool: {
            id: tId,
            nativeId: tId,
            name: tName,
            category,
            status: "running",
            startedAt: input.receivedAt,
          },
          file,
        }),
      )
      if (file) {
        events.push(
          buildEvent({
            ...base,
            kind: "file.touched",
            nativeToolId: tId,
            salt: `file:${file.path}`,
            file,
          }),
        )
      }
      return events
    }

    if (name === "posttooluse") {
      const tName = toolName(raw)
      const tId = toolId(raw, tName)
      events.push(
        buildEvent({
          ...base,
          kind: "tool.completed",
          nativeToolId: tId,
          tool: {
            id: tId,
            nativeId: tId,
            name: tName,
            category: classifyGenericTool(tName),
            status: "completed",
            completedAt: input.receivedAt,
          },
        }),
      )
      return events
    }

    if (name === "posttoolusefailure") {
      const tName = toolName(raw)
      const tId = toolId(raw, tName)
      events.push(
        buildEvent({
          ...base,
          kind: "tool.failed",
          nativeToolId: tId,
          tool: {
            id: tId,
            nativeId: tId,
            name: tName,
            category: classifyGenericTool(tName),
            status: "failed",
            completedAt: input.receivedAt,
          },
        }),
      )
      return events
    }

    if (
      name === "permissionrequest" ||
      (name === "notification" && notificationType?.includes("permission"))
    ) {
      const pId = permissionId(raw)
      const tName = toolName(raw)
      events.push(
        buildEvent({
          ...base,
          kind: "permission.requested",
          nativePermissionId: pId,
          permission: {
            id: pId,
            toolName: tName !== "tool" ? tName : undefined,
            status: "requested",
          },
        }),
      )
      return events
    }

    if (name === "permissiondenied") {
      const pId = permissionId(raw)
      events.push(
        buildEvent({
          ...base,
          kind: "permission.resolved",
          nativePermissionId: pId,
          permission: { id: pId, status: "denied" },
        }),
      )
      return events
    }

    if (name === "subagentstart") {
      const sId =
        pickString(raw, ["agent_id", "agentId", "subagent_id"]) ?? "subagent"
      events.push(
        buildEvent({
          ...base,
          kind: "subagent.started",
          salt: sId,
          subagent: {
            id: sId,
            nativeId: sId,
            status: "running",
            type: pickString(raw, ["agent_type", "type"]) ?? undefined,
          },
        }),
      )
      return events
    }

    if (name === "subagentstop") {
      const sId =
        pickString(raw, ["agent_id", "agentId", "subagent_id"]) ?? "subagent"
      const failed =
        pickString(raw, ["status", "error"])?.toLowerCase() === "failed" ||
        raw.error != null
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
      events.push(
        buildEvent({
          ...base,
          kind: "compaction.started",
          nativeEventName: name,
        }),
      )
      return events
    }

    if (name === "postcompact") {
      events.push(
        buildEvent({
          ...base,
          kind: "compaction.completed",
          nativeEventName: name,
        }),
      )
      return events
    }

    if (name === "stop") {
      events.push(
        buildEvent({
          ...base,
          kind: "turn.completed",
          nativeEventName: name,
          nativeTurnId: pickString(raw, ["prompt_id", "turn_id"]) ?? undefined,
        }),
      )
      return events
    }

    if (name === "stopfailure") {
      events.push(
        buildEvent({
          ...base,
          kind: "turn.failed",
          nativeEventName: name,
        }),
      )
      return events
    }

    // Generic notification → notification.requested (does not drive status)
    if (name === "notification") {
      events.push(
        buildEvent({
          ...base,
          kind: "notification.requested",
          salt: notificationType ?? "notify",
          metadata: {
            notificationType: notificationType ?? null,
          },
        }),
      )
    }

    return events
  },
}
