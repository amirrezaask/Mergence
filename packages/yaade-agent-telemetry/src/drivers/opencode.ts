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
  yaadeEnv,
  pickString,
} from "./helpers.js"

const CAPABILITIES: AgentDriverCapabilities = {
  sessionLifecycle: true,
  promptLifecycle: false,
  turnLifecycle: "derived",
  toolLifecycle: true,
  permissions: true,
  subagents: true,
  compaction: true,
  fileEvents: "native",
}

function opencodeEvent(raw: Record<string, unknown>): {
  name: string
  props: Record<string, unknown>
} {
  const event = asRecord(raw.event)
  if (event) {
    return {
      name: pickString(event, ["type"]) ?? "",
      props: asRecord(event.properties) ?? event,
    }
  }
  return {
    name:
      pickString(raw, ["event_type", "type", "providerEvent"]) ?? "",
    props: raw,
  }
}

/**
 * OpenCode driver — project plugin posts events; handlers must stay fast.
 */
export const opencodeDriver: CliAgentDriver = {
  provider: "opencode",

  getCapabilities() {
    return CAPABILITIES
  },

  async detect(): Promise<AgentDriverDetection> {
    return detectBinary("opencode")
  },

  async installHooks(
    context: HookInstallationContext,
  ): Promise<HookInstallationResult> {
    return {
      launchArgs: [],
      env: yaadeEnv(context),
      driver: "plugin",
      writtenPaths: [], // host writes .opencode/plugin/yaade-telemetry.js
    }
  },

  classifyTool(nativeToolName: string): AgentToolCategory {
    return classifyGenericTool(nativeToolName)
  },

  normalizeHookEvent(input: NativeHookInput): AgentEvent[] {
    const raw = asRecord(input.payload)
    if (!raw) return []
    const { name, props } = opencodeEvent(raw)
    const nativeSessionId =
      pickString(props, ["sessionID", "sessionId", "id"]) ??
      pickString(raw, ["session_id", "sessionId"]) ??
      ""
    const events: AgentEvent[] = []
    const base = {
      input,
      nativeSessionId,
      nativeEventName: name || "opencode",
    }

    if (name === "session.created") {
      events.push(buildEvent({ ...base, kind: "session.started" }))
      // Child session → subagent
      const parentId = pickString(props, ["parentID", "parentId"])
      if (parentId) {
        events.push(
          buildEvent({
            ...base,
            kind: "subagent.started",
            salt: nativeSessionId || "child",
            subagent: {
              id: nativeSessionId || "child",
              nativeId: nativeSessionId,
              parentId,
              status: "running",
            },
          }),
        )
      }
      return events
    }

    if (name === "session.updated") {
      // Metadata-only — emit notification.requested without status change
      events.push(
        buildEvent({
          ...base,
          kind: "notification.requested",
          salt: "session.updated",
          metadata: { title: pickString(props, ["title"]) },
        }),
      )
      return events
    }

    if (name === "session.idle") {
      events.push(buildEvent({ ...base, kind: "turn.completed" }))
      return events
    }

    if (name === "session.error") {
      events.push(buildEvent({ ...base, kind: "turn.failed" }))
      return events
    }

    if (name === "session.compacted") {
      events.push(buildEvent({ ...base, kind: "compaction.completed" }))
      return events
    }

    if (name === "session.deleted") {
      events.push(buildEvent({ ...base, kind: "session.ended" }))
      return events
    }

    if (name === "tool.execute.before") {
      const tName = pickString(props, ["tool", "name"]) ?? "tool"
      const tId = pickString(props, ["callID", "callId", "id"]) ?? tName
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

    if (name === "tool.execute.after") {
      const tName = pickString(props, ["tool", "name"]) ?? "tool"
      const tId = pickString(props, ["callID", "callId", "id"]) ?? tName
      const failed =
        props.error != null ||
        pickString(props, ["status"])?.toLowerCase() === "error"
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

    if (name === "permission.asked" || name === "permission.v2.asked") {
      const pId = pickString(props, ["id", "permissionID"]) ?? "permission"
      events.push(
        buildEvent({
          ...base,
          kind: "permission.requested",
          nativePermissionId: pId,
          permission: {
            id: pId,
            toolName: pickString(props, ["tool", "permission"]) ?? undefined,
            status: "requested",
          },
        }),
      )
      return events
    }

    if (name === "permission.replied" || name === "permission.v2.replied") {
      const pId = pickString(props, ["id", "permissionID"]) ?? "permission"
      const reply = pickString(props, ["reply", "status"])?.toLowerCase()
      const status =
        reply === "deny" || reply === "denied"
          ? "denied"
          : reply === "cancel" || reply === "cancelled"
            ? "cancelled"
            : "allowed"
      events.push(
        buildEvent({
          ...base,
          kind: "permission.resolved",
          nativePermissionId: pId,
          permission: { id: pId, status },
        }),
      )
      return events
    }

    if (name === "file.edited") {
      const path = pickString(props, ["file", "path", "filePath"])
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

    return events
  },
}
