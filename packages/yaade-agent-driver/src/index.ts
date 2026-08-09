import type {
  AgentAttachment,
  AgentCapabilities,
  AgentCommandEnvelope,
  AgentCommandResult,
  AgentConnectionId,
  AgentDriverDescriptor,
  ProviderSessionId,
  UnsequencedAgentEvent,
} from "@yaade/agent-protocol"

export interface AgentDriverDetectionContext {
  readonly cwdUri: string
  readonly signal: AbortSignal
  readonly commands: AgentCommandResolver
}

export interface AgentCommandResolver {
  resolveExecutable(candidates: ReadonlyArray<string>): Promise<string | undefined>
  probe(
    command: string,
    args: ReadonlyArray<string>,
  ): Promise<{ readonly exitCode: number | null; readonly output: string }>
}

export interface AgentDriverDetection {
  readonly available: boolean
  readonly version?: string
  readonly reason?: string
}

export type OpenAgentThreadMode =
  | { readonly type: "new" }
  | {
      readonly type: "resume"
      readonly providerSessionId: ProviderSessionId
    }
  | {
      readonly type: "load"
      readonly providerSessionId: ProviderSessionId
    }

export interface OpenAgentThreadRequest {
  readonly mode: OpenAgentThreadMode
  readonly cwdUri: string
  readonly initialConfiguration?: Readonly<Record<string, unknown>>
}

export interface AgentWorkspaceAccess {
  readonly rootUri: string
  readonly additionalRoots: ReadonlyArray<string>
  assertAllowed(uri: string): Promise<void>
}

export interface AgentFilesystem {
  readFile(uri: string): Promise<Uint8Array>
  writeFile(uri: string, content: Uint8Array): Promise<void>
  stat(uri: string): Promise<{ readonly size: number; readonly mediaType?: string }>
}

export interface AgentTerminalHandle {
  readonly id: string
  write(data: string): Promise<void>
  readOutput(): Promise<{ readonly output: string; readonly truncated: boolean }>
  waitForExit(): Promise<{ readonly exitCode: number | null; readonly signal?: string }>
  close(): Promise<void>
}

export interface AgentTerminalService {
  open(options: {
    readonly cwdUri: string
    readonly command: string
    readonly args: ReadonlyArray<string>
  }): Promise<AgentTerminalHandle>
}

export interface AgentSpawnedProcess {
  readonly id: string
  readonly stdout: AsyncIterable<Uint8Array>
  readonly stderr: AsyncIterable<Uint8Array>
  writeStdin(data: Uint8Array): Promise<void>
  wait(): Promise<{ readonly exitCode: number | null; readonly signal?: string }>
  stop(graceMs: number): Promise<void>
}

export interface AgentProcessSpawner {
  spawn(options: {
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwdUri: string
    readonly env: Readonly<Record<string, string>>
  }): Promise<AgentSpawnedProcess>
}

export interface AgentAttachmentResolver {
  resolve(attachmentId: string): Promise<AgentAttachment>
  /** Read validated, thread-scoped upload bytes without exposing host paths. */
  read(attachmentId: string): Promise<Uint8Array>
}

export interface AgentCredentialBroker {
  get(name: string): Promise<string | undefined>
}

export type AgentMcpServer =
  | {
      readonly type: "stdio"
      readonly id: string
      readonly name: string
      readonly command: string
      readonly args: ReadonlyArray<string>
      readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>
    }
  | {
      readonly type: "http" | "sse"
      readonly id: string
      readonly name: string
      readonly url: string
      readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>
    }

export interface AgentMcpRegistry {
  listServers(): Promise<ReadonlyArray<AgentMcpServer>>
}

export interface AgentClock {
  now(): Date
  sleep(ms: number): Promise<void>
}

export interface AgentLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void
  info(message: string, fields?: Readonly<Record<string, unknown>>): void
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void
  error(message: string, fields?: Readonly<Record<string, unknown>>): void
}

export interface AgentDriverContext {
  readonly workspace: AgentWorkspaceAccess
  readonly filesystem: AgentFilesystem
  readonly terminal: AgentTerminalService
  readonly processSpawner: AgentProcessSpawner
  readonly commands: AgentCommandResolver
  readonly attachments: AgentAttachmentResolver
  readonly credentials: AgentCredentialBroker
  readonly mcp: AgentMcpRegistry
  readonly clock: AgentClock
  readonly logger: AgentLogger
  readonly signal: AbortSignal
}

export interface AgentThreadConnection {
  readonly binding: {
    readonly providerSessionId?: ProviderSessionId
    readonly connectionId: AgentConnectionId
  }
  readonly capabilities: AgentCapabilities
  /** Options negotiated during thread creation, before any streamed updates. */
  readonly configuration?: ReadonlyArray<import("@yaade/agent-protocol").AgentConfigurationOption>
  send(command: AgentCommandEnvelope): Promise<AgentCommandResult>
  events(signal?: AbortSignal): AsyncIterable<UnsequencedAgentEvent>
  close(reason: "user" | "runtime-shutdown" | "driver-restart"): Promise<void>
}

export interface AgentDriver {
  readonly descriptor: AgentDriverDescriptor
  detect(context: AgentDriverDetectionContext): Promise<AgentDriverDetection>
  openThread(
    context: AgentDriverContext,
    request: OpenAgentThreadRequest,
  ): Promise<AgentThreadConnection>
}
