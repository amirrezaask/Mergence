import type { SupervisorOperation } from "./limits.js"

export type RuntimeCapabilities = {
  readonly semanticTerminalState: boolean
  readonly authoritativeLeases: boolean
  readonly structuredInput: boolean
  readonly historyPaging: boolean
  readonly subscriptions: boolean
  readonly draining: boolean
}

export type RuntimeHello = {
  readonly protocolMin: number
  readonly protocolMax: number
  readonly runtimeVersion: string
  readonly ownerId: string
  readonly ownerEpoch: string
  readonly capabilities: RuntimeCapabilities
}

type CommandPayload = Record<string, unknown>

export type SupervisorCommand = {
  readonly version: 2
  readonly kind: "command"
  readonly requestId: string
  readonly deadlineUnixMs: number
  readonly commandId?: string
  readonly operation: SupervisorOperation
  readonly payload: CommandPayload
}

export type SupervisorResponse = {
  readonly version: 2
  readonly kind: "response"
  readonly requestId: string
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: {
    readonly code: string
    readonly message: string
  }
}

export type SupervisorEvent = {
  readonly version: 2
  readonly kind: "event"
  readonly event:
    | "terminal.created"
    | "terminal.output"
    | "terminal.semantic"
    | "terminal.exited"
    | "terminal.state-changed"
    | "terminal.title-changed"
    | "terminal.cwd-changed"
    | "lease.changed"
    | "runtime.draining"
    | "runtime.empty"
  readonly ownerEpoch: string
  readonly terminalId?: string
  readonly terminalEpoch?: string
  readonly revision?: number
  readonly payload: Record<string, unknown>
}

export type SupervisorProtocolMessage =
  | SupervisorCommand
  | SupervisorResponse
  | SupervisorEvent

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function isRuntimeCapabilities(value: unknown): value is RuntimeCapabilities {
  if (!isRecord(value)) return false
  return (
    typeof value.semanticTerminalState === "boolean" &&
    typeof value.authoritativeLeases === "boolean" &&
    typeof value.structuredInput === "boolean" &&
    typeof value.historyPaging === "boolean" &&
    typeof value.subscriptions === "boolean" &&
    typeof value.draining === "boolean"
  )
}

export function isRuntimeHello(value: unknown): value is RuntimeHello {
  if (!isRecord(value)) return false
  return (
    typeof value.protocolMin === "number" &&
    Number.isSafeInteger(value.protocolMin) &&
    typeof value.protocolMax === "number" &&
    Number.isSafeInteger(value.protocolMax) &&
    typeof value.runtimeVersion === "string" &&
    typeof value.ownerId === "string" &&
    typeof value.ownerEpoch === "string" &&
    isRuntimeCapabilities(value.capabilities)
  )
}

const OPERATIONS: ReadonlySet<string> = new Set<SupervisorOperation>([
  "handshake",
  "create",
  "attach",
  "acquireLease",
  "renewLease",
  "releaseLease",
  "sendInput",
  "sendPaste",
  "sendFocus",
  "sendMouse",
  "resize",
  "readSnapshot",
  "readHistory",
  "inspect",
  "subscribe",
  "dispose",
  "markDraining",
  "shutdownWhenEmpty",
  "listRunning",
  "listLeases",
  "currentWriterLease",
  "forceTakeover",
  "transferLease",
  "releaseConnection",
  "ping",
  "getCwd",
  "waitForExit",
  "shutdown",
])

export function isSupervisorCommand(value: unknown): value is SupervisorCommand {
  if (!isRecord(value)) return false
  return (
    value.version === 2 &&
    value.kind === "command" &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    typeof value.deadlineUnixMs === "number" &&
    Number.isSafeInteger(value.deadlineUnixMs) &&
    (value.commandId === undefined || typeof value.commandId === "string") &&
    typeof value.operation === "string" &&
    OPERATIONS.has(value.operation) &&
    isRecord(value.payload)
  )
}

export function isSupervisorResponse(value: unknown): value is SupervisorResponse {
  if (!isRecord(value)) return false
  return (
    value.version === 2 &&
    value.kind === "response" &&
    typeof value.requestId === "string" &&
    typeof value.ok === "boolean" &&
    (value.error === undefined ||
      (isRecord(value.error) &&
        typeof value.error.code === "string" &&
        typeof value.error.message === "string"))
  )
}

const EVENTS: ReadonlySet<string> = new Set([
  "terminal.created",
  "terminal.output",
  "terminal.semantic",
  "terminal.exited",
  "terminal.state-changed",
  "terminal.title-changed",
  "terminal.cwd-changed",
  "lease.changed",
  "runtime.draining",
  "runtime.empty",
])

export function isSupervisorEvent(value: unknown): value is SupervisorEvent {
  if (!isRecord(value)) return false
  return (
    value.version === 2 &&
    value.kind === "event" &&
    typeof value.event === "string" &&
    EVENTS.has(value.event) &&
    typeof value.ownerEpoch === "string" &&
    (value.terminalId === undefined || typeof value.terminalId === "string") &&
    (value.terminalEpoch === undefined || typeof value.terminalEpoch === "string") &&
    (value.revision === undefined ||
      (typeof value.revision === "number" && Number.isSafeInteger(value.revision))) &&
    isRecord(value.payload)
  )
}
