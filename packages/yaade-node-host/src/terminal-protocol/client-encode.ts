import type { SupervisorCommand } from "./schema.js"
import { isRecord } from "./schema.js"
import type { SupervisorOperation } from "./limits.js"

type EncodedCommand = {
  readonly operation: SupervisorOperation
  readonly payload: Record<string, unknown>
  readonly commandId?: string
}

function fenceCommandId(value: unknown): string | undefined {
  return isRecord(value) && typeof value.commandId === "string" ? value.commandId : undefined
}

function payloadFor(op: string, args: unknown[]): EncodedCommand | null {
  switch (op) {
    case "handshake":
      return { operation: "handshake", payload: {} }
    case "create":
      return {
        operation: "create",
        payload: {
          cwdUri: args[0],
          launch: args[1],
          clientId: args[2],
          requestId: args[3],
        },
      }
    case "attach":
      return {
        operation: "attach",
        payload: { terminalId: args[0], clientId: args[1], afterSequence: args[2] },
      }
    case "acquireLease":
      return {
        operation: "acquireLease",
        payload: {
          terminalId: args[0],
          terminalEpoch: args[1],
          principalId: args[2],
          connectionId: args[3],
          mode: args[4],
        },
      }
    case "renewLease":
      return {
        operation: "renewLease",
        payload: {
          terminalId: args[0],
          terminalEpoch: args[1],
          leaseId: args[2],
          principalId: args[3],
          connectionId: args[4],
        },
      }
    case "releaseLease":
      return {
        operation: "releaseLease",
        payload: {
          terminalId: args[0],
          terminalEpoch: args[1],
          leaseId: args[2],
          principalId: args[3],
          connectionId: args[4],
        },
      }
    case "releaseConnection":
      return { operation: "releaseConnection", payload: { connectionId: args[0] } }
    case "forceTakeover":
      return {
        operation: "forceTakeover",
        payload: {
          terminalId: args[0],
          terminalEpoch: args[1],
          principalId: args[2],
          connectionId: args[3],
        },
      }
    case "transferLease":
      return {
        operation: "transferLease",
        payload: {
          terminalId: args[0],
          terminalEpoch: args[1],
          leaseId: args[2],
          principalId: args[3],
          connectionId: args[4],
          targetPrincipalId: args[5],
          targetConnectionId: args[6],
        },
      }
    case "writeFenced":
      return {
        operation: "sendInput",
        payload: { terminalId: args[0], data: args[1], fence: args[2] },
        commandId: fenceCommandId(args[2]),
      }
    case "resizeFenced":
      return {
        operation: "resize",
        payload: { terminalId: args[0], cols: args[1], rows: args[2], fence: args[3] },
        commandId: fenceCommandId(args[3]),
      }
    case "pasteFenced":
      return {
        operation: "sendPaste",
        payload: { terminalId: args[0], data: args[1], fence: args[2] },
        commandId: fenceCommandId(args[2]),
      }
    case "focusFenced":
      return {
        operation: "sendFocus",
        payload: { terminalId: args[0], focused: args[1], fence: args[2] },
        commandId: fenceCommandId(args[2]),
      }
    case "mouseFenced":
      return {
        operation: "sendMouse",
        payload: { terminalId: args[0], input: args[1], fence: args[2] },
        commandId: fenceCommandId(args[2]),
      }
    case "disposeFenced":
      return {
        operation: "dispose",
        payload: { terminalId: args[0], fence: args[1] },
        commandId: fenceCommandId(args[1]),
      }
    case "inspect":
      return { operation: "inspect", payload: { terminalId: args[0] } }
    case "listRunning":
      return { operation: "listRunning", payload: {} }
    case "listLeases":
      return { operation: "listLeases", payload: { terminalId: args[0] } }
    case "currentWriterLease":
      return { operation: "currentWriterLease", payload: { terminalId: args[0] } }
    case "getCwd":
      return { operation: "getCwd", payload: { terminalId: args[0] } }
    case "waitForExit":
      return { operation: "waitForExit", payload: { terminalId: args[0] } }
    case "armLiveViewer":
      return {
        operation: "subscribe",
        payload: { terminalId: args[0], clientId: args[1] },
      }
    case "readSemanticSnapshot":
      return { operation: "readSnapshot", payload: { terminalId: args[0] } }
    case "readSemanticHistory":
      return {
        operation: "readHistory",
        payload: { terminalId: args[0], offset: args[1], limit: args[2] },
      }
    case "ping":
      return { operation: "ping", payload: {} }
    case "shutdown":
      return { operation: "shutdown", payload: {} }
    default:
      return null
  }
}

/** Encode a host RPC as a v2 command, or null to keep the legacy v1 frame. */
export function encodeClientCommand(
  op: string,
  args: unknown[],
  requestId: string,
  deadlineUnixMs: number,
): SupervisorCommand | null {
  const encoded = payloadFor(op, args)
  if (!encoded) return null
  return {
    version: 2,
    kind: "command",
    requestId,
    deadlineUnixMs,
    ...(encoded.commandId ? { commandId: encoded.commandId } : {}),
    operation: encoded.operation,
    payload: encoded.payload,
  }
}
