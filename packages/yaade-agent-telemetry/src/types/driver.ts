import type { AgentEvent, AgentProvider, AgentToolCategory } from "./events.js"

export interface AgentDriverCapabilities {
  sessionLifecycle: boolean
  promptLifecycle: boolean
  turnLifecycle: "native" | "derived" | "unsupported"
  toolLifecycle: boolean
  permissions: boolean
  subagents: boolean
  compaction: boolean
  fileEvents: "native" | "derived" | "unsupported"
  /** Provider exposes a tested native conversation resume command. */
  nativeResume?: boolean
}

export interface AgentDriverDetection {
  available: boolean
  binary?: string
  version?: string
  error?: string
}

export interface HookInstallationContext {
  sessionId: string
  projectRoot: string
  ingestUrl: string
  provider: AgentProvider
  origin: string
  /** Env vars to inject into the PTY process. */
  env?: Record<string, string>
}

export interface HookInstallationResult {
  /** Extra launch argv (e.g. Claude --settings). */
  launchArgs: string[]
  /** Env vars the PTY must carry for forwarder scripts. */
  env: Record<string, string>
  driver: "hook" | "osc" | "plugin"
  /** Paths written (project-local hooks/plugin). */
  writtenPaths?: string[]
}

export type NativeAgentSessionRef = {
  provider: AgentProvider
  kind: string
  value: string
  capturedAt: string
  driverVersion: number
}

export type NativeResumeContext = {
  projectRoot: string
  cwd: string
  executable?: string
  args?: readonly string[]
}

export type NativeResumeLaunch = {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface NativeHookInput {
  /** Raw provider JSON body (private to driver). */
  payload: unknown
  /** Authoritative Yaade session id from ingest URL. */
  sessionId: string
  processId: string
  provider: AgentProvider
  receivedAt: string
  projectId?: string
  cwd?: string
  nativeProcessId?: number
  providerVersion?: string
}

export interface CliAgentDriver {
  readonly provider: AgentProvider

  detect(): Promise<AgentDriverDetection>

  installHooks(context: HookInstallationContext): Promise<HookInstallationResult>

  normalizeHookEvent(input: NativeHookInput): AgentEvent[]

  classifyTool(nativeToolName: string, nativeInput?: unknown): AgentToolCategory

  getCapabilities(): AgentDriverCapabilities

  detectNativeSessionRef?(context: {
    nativeSessionId?: string | null
    payload?: unknown
  }): Promise<NativeAgentSessionRef | null>

  validateNativeSessionRef?(
    ref: NativeAgentSessionRef,
    context: NativeResumeContext,
  ): Promise<boolean>

  buildResumeLaunch?(
    ref: NativeAgentSessionRef,
    context: NativeResumeContext,
  ): Promise<NativeResumeLaunch>
}
