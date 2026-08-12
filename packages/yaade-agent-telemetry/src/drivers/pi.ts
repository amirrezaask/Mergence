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
  classifyGenericTool,
  detectBinary,
  emptyInstall,
  yaadeEnv,
} from "./helpers.js"

/** Pi coding agent: process lifecycle only until a native telemetry hook exists. */
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

export const piDriver: CliAgentDriver = {
  provider: "pi",

  getCapabilities() {
    return CAPABILITIES
  },

  async detect(): Promise<AgentDriverDetection> {
    return detectBinary("pi")
  },

  async installHooks(
    context: HookInstallationContext,
  ): Promise<HookInstallationResult> {
    return emptyInstall("osc", yaadeEnv(context))
  },

  classifyTool(nativeToolName: string): AgentToolCategory {
    return classifyGenericTool(nativeToolName)
  },

  normalizeHookEvent(_input: NativeHookInput) {
    return []
  },
}
