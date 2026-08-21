import type { SupervisorMessage } from "../terminal-supervisor.js"
import type {
  SupervisorCommand,
  SupervisorEvent,
  SupervisorResponse,
} from "./schema.js"
import { SupervisorProtocolError } from "./errors.js"

export type LegacySupervisorRequest = Extract<SupervisorMessage, { kind: "req" }>
export type LegacySupervisorResponse = Extract<SupervisorMessage, { kind: "res" }>
export type LegacySupervisorEvent = Extract<SupervisorMessage, { kind: "event" }>

/** Normalize a legacy request without letting its untyped args become v2 data. */
export function legacyRequestToCommand(
  request: LegacySupervisorRequest,
  deadlineUnixMs: number,
): SupervisorCommand {
  return {
    version: 2,
    kind: "command",
    requestId: String(request.id),
    deadlineUnixMs,
    operation: legacyOperation(request.op),
    payload: { args: request.args },
  }
}

export function legacyResponseToV2(response: LegacySupervisorResponse): SupervisorResponse {
  const message =
    typeof response.error === "string"
      ? response.error
      : response.error
        ? response.error.message
        : "legacy supervisor error"
  return {
    version: 2,
    kind: "response",
    requestId: String(response.id),
    ok: response.ok,
    ...(response.ok ? { value: response.value } : {}),
    ...(!response.ok
      ? { error: { code: typeof response.error === "object" && response.error ? response.error.code : "LEGACY_ERROR", message } }
      : {}),
  }
}

export function legacyEventToV2(event: LegacySupervisorEvent, ownerEpoch: string): SupervisorEvent {
  const terminalId = typeof event.args[0] === "string" ? event.args[0] : undefined
  return {
    version: 2,
    kind: "event",
    event: event.channel === "terminal:exit" ? "terminal.exited" : "terminal.state-changed",
    ownerEpoch,
    ...(terminalId ? { terminalId } : {}),
    payload: { channel: event.channel, args: event.args },
  }
}

function legacyOperation(operation: string): SupervisorCommand["operation"] {
  switch (operation) {
    case "handshake":
    case "create":
    case "attach":
    case "acquireLease":
    case "renewLease":
    case "releaseLease":
    case "resize":
    case "inspect":
    case "dispose":
      return operation
    case "write":
    case "writeBinary":
      return "sendInput"
    case "markDraining":
      return "markDraining"
    case "shutdownWhenEmpty":
      return "shutdownWhenEmpty"
    default:
      throw new SupervisorProtocolError(
        "INVALID_MESSAGE",
        `unsupported legacy supervisor operation: ${operation}`,
      )
  }
}
