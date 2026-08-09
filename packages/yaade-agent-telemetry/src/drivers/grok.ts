import type {
  AgentDriverCapabilities,
  AgentDriverDetection,
  CliAgentDriver,
  HookInstallationContext,
  HookInstallationResult,
  NativeHookInput,
} from "../types/driver.js"
import type { AgentToolCategory } from "../types/events.js"
import {
  asRecord,
  buildEvent,
  classifyGenericTool,
  detectBinary,
  emptyInstall,
  extractNativeSessionId,
  yaadeEnv,
  pickString,
} from "./helpers.js"

/** Grok: OSC + process lifecycle only — no fake tool/permission telemetry. */
const CAPABILITIES: AgentDriverCapabilities = {
  sessionLifecycle: false,
  promptLifecycle: false,
  turnLifecycle: "unsupported",
  toolLifecycle: false,
  permissions: false,
  subagents: false,
  compaction: false,
  fileEvents: "unsupported",
}

export const grokDriver: CliAgentDriver = {
  provider: "grok",

  getCapabilities() {
    return CAPABILITIES
  },

  async detect(): Promise<AgentDriverDetection> {
    return detectBinary("grok")
  },

  async installHooks(
    context: HookInstallationContext,
  ): Promise<HookInstallationResult> {
    return {
      ...emptyInstall("osc", yaadeEnv(context)),
    }
  },

  classifyTool(nativeToolName: string): AgentToolCategory {
    return classifyGenericTool(nativeToolName)
  },

  normalizeHookEvent(input: NativeHookInput) {
    const raw = asRecord(input.payload)
    if (!raw) return []
    const type = pickString(raw, [
      "type",
      "providerEvent",
      "kind",
    ])?.toLowerCase()
    const nativeSessionId = extractNativeSessionId(raw)
    if (type === "process.started" || type === "process_started") {
      return [
        buildEvent({
          input,
          kind: "process.started",
          nativeEventName: type,
          nativeSessionId,
        }),
      ]
    }
    if (type === "process.exited" || type === "process_exited") {
      return [
        buildEvent({
          input,
          kind: "process.exited",
          nativeEventName: type,
          nativeSessionId,
          metadata: {
            exitCode:
              typeof raw.exitCode === "number" ? raw.exitCode : null,
            expectedExit: raw.expectedExit === true,
          },
        }),
      ]
    }
    if (type === "turn-completed" || type === "turn.completed") {
      return [
        buildEvent({
          input,
          kind: "turn.completed",
          nativeEventName: type,
          nativeSessionId,
        }),
      ]
    }
    return []
  },
}
