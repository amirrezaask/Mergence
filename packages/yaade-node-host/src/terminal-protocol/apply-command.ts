import type { GhosttyMouseInput } from "@yaade/ghostty-core"
import {
  assertSupervisorDeadline,
  decodeSupervisorProtocolMessage,
} from "./codec.js"
import { SupervisorProtocolError } from "./errors.js"
import {
  isRecord,
  isRuntimeHello,
  type RuntimeHello,
  type SupervisorCommand,
  type SupervisorProtocolMessage,
  type SupervisorResponse,
} from "./schema.js"
import { SUPERVISOR_PROTOCOL_MAX, SUPERVISOR_PROTOCOL_MIN } from "./limits.js"
import type { TerminalHost } from "../terminal.js"
import type { SupervisorManifest } from "../terminal-supervisor.js"
import {
  TerminalControlError,
  type TerminalMutationFence,
} from "../terminal-control.js"

export type SupervisorHelloIdentity = Pick<
  SupervisorManifest,
  "supervisorId" | "supervisorEpoch"
> & {
  readonly ownerId?: string
  readonly capabilities: RuntimeHello["capabilities"]
  readonly protocolMin?: number
  readonly protocolMax?: number
}

function fenceFrom(value: unknown, terminalId: string): TerminalMutationFence {
  if (!isRecord(value)) {
    throw new TerminalControlError(
      "WRITER_LEASE_REQUIRED",
      terminalId,
      "terminal mutation fence is required",
    )
  }
  if (
    typeof value.terminalId !== "string" ||
    typeof value.terminalEpoch !== "string" ||
    typeof value.leaseId !== "string" ||
    typeof value.leaseGeneration !== "number" ||
    typeof value.principalId !== "string" ||
    typeof value.connectionId !== "string" ||
    typeof value.commandId !== "string"
  ) {
    throw new TerminalControlError(
      "WRITER_LEASE_REQUIRED",
      terminalId,
      "terminal mutation fence is required",
    )
  }
  return {
    terminalId: value.terminalId,
    terminalEpoch: value.terminalEpoch,
    leaseId: value.leaseId,
    leaseGeneration: value.leaseGeneration,
    principalId: value.principalId,
    connectionId: value.connectionId,
    commandId: value.commandId,
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function mouseInputFrom(value: unknown, terminalId: string): GhosttyMouseInput {
  if (!isRecord(value)) {
    throw new TerminalControlError(
      "WRITER_LEASE_REQUIRED",
      terminalId,
      "structured mouse input is required",
    )
  }
  const action = value.action
  if (action !== "press" && action !== "release" && action !== "motion") {
    throw new TerminalControlError(
      "WRITER_LEASE_REQUIRED",
      terminalId,
      "structured mouse action is invalid",
    )
  }
  const numberField = (field: string): number => {
    const result = value[field]
    if (typeof result !== "number" || !Number.isFinite(result)) {
      throw new TerminalControlError(
        "WRITER_LEASE_REQUIRED",
        terminalId,
        `structured mouse field ${field} is invalid`,
      )
    }
    return result
  }
  const button = value.button === null
    ? null
    : typeof value.button === "number" && Number.isSafeInteger(value.button)
      ? value.button
      : undefined
  if (button === undefined || typeof value.anyButtonPressed !== "boolean") {
    throw new TerminalControlError(
      "WRITER_LEASE_REQUIRED",
      terminalId,
      "structured mouse button state is invalid",
    )
  }
  return {
    action,
    button,
    mods: numberField("mods"),
    x: numberField("x"),
    y: numberField("y"),
    screenWidth: numberField("screenWidth"),
    screenHeight: numberField("screenHeight"),
    cellWidth: numberField("cellWidth"),
    cellHeight: numberField("cellHeight"),
    paddingLeft: numberField("paddingLeft"),
    paddingRight: numberField("paddingRight"),
    paddingTop: numberField("paddingTop"),
    paddingBottom: numberField("paddingBottom"),
    anyButtonPressed: value.anyButtonPressed,
  }
}

export function runtimeHello(identity: SupervisorHelloIdentity): RuntimeHello {
  return {
    protocolMin: identity.protocolMin ?? SUPERVISOR_PROTOCOL_MIN,
    protocolMax: identity.protocolMax ?? SUPERVISOR_PROTOCOL_MAX,
    runtimeVersion: "generation-v1",
    ownerId: identity.ownerId ?? identity.supervisorId,
    ownerEpoch: identity.supervisorEpoch,
    capabilities: identity.capabilities,
  }
}

export function applySupervisorCommand(
  host: TerminalHost,
  command: SupervisorCommand,
  identity: SupervisorHelloIdentity,
): unknown {
  assertSupervisorDeadline(command)
  const payload = command.payload
  switch (command.operation) {
    case "handshake": {
      const hello = runtimeHello(identity)
      if (isRuntimeHello(payload)) {
        if (payload.protocolMin > hello.protocolMax || payload.protocolMax < hello.protocolMin) {
          throw new SupervisorProtocolError(
            "UNSUPPORTED_PROTOCOL",
            "supervisor protocol range is incompatible",
          )
        }
      }
      return hello
    }
    case "create":
      return host.create(
        text(payload.cwdUri),
        payload.launch && isRecord(payload.launch)
          ? {
              command: text(payload.launch.command),
              args: Array.isArray(payload.launch.args)
                ? payload.launch.args.map(String)
                : [],
            }
          : null,
        text(payload.clientId) || "supervisor",
        typeof payload.requestId === "string" ? payload.requestId : undefined,
      )
    case "attach":
      return host.attach(
        text(payload.terminalId),
        text(payload.clientId),
        optionalNumber(payload.afterSequence),
      )
    case "acquireLease":
      return host.acquireLease(
        text(payload.terminalId),
        text(payload.terminalEpoch),
        text(payload.principalId),
        text(payload.connectionId),
        payload.mode === "observer" ? "observer" : "writer",
      )
    case "renewLease":
      return host.renewLease(
        text(payload.terminalId),
        text(payload.terminalEpoch),
        text(payload.leaseId),
        text(payload.principalId),
        text(payload.connectionId),
      )
    case "releaseLease":
      return host.releaseLease(
        text(payload.terminalId),
        text(payload.terminalEpoch),
        text(payload.leaseId),
        text(payload.principalId),
        text(payload.connectionId),
      )
    case "sendInput":
      return host.writeFenced(
        text(payload.terminalId),
        text(payload.data),
        fenceFrom(payload.fence, text(payload.terminalId)),
      )
    case "sendPaste":
      return host.pasteFenced(
        text(payload.terminalId),
        text(payload.data),
        fenceFrom(payload.fence, text(payload.terminalId)),
      )
    case "sendFocus":
      return host.focusFenced(
        text(payload.terminalId),
        payload.focused === true,
        fenceFrom(payload.fence, text(payload.terminalId)),
      )
    case "sendMouse":
      return host.mouseFenced(
        text(payload.terminalId),
        mouseInputFrom(payload.input, text(payload.terminalId)),
        fenceFrom(payload.fence, text(payload.terminalId)),
      )
    case "resize":
      return host.resizeFenced(
        text(payload.terminalId),
        optionalNumber(payload.cols),
        optionalNumber(payload.rows),
        fenceFrom(payload.fence, text(payload.terminalId)),
      )
    case "readSnapshot":
      return host.readSemanticSnapshot(text(payload.terminalId))
    case "readHistory":
      return host.readSemanticHistory(
        text(payload.terminalId),
        optionalNumber(payload.offset) ?? 0,
        optionalNumber(payload.limit) ?? 24,
      )
    case "inspect":
      return host.inspect(text(payload.terminalId))
    case "subscribe":
      host.armLiveViewer(text(payload.terminalId), text(payload.clientId))
      return null
    case "dispose":
      return host.disposeFenced(
        text(payload.terminalId),
        fenceFrom(payload.fence, text(payload.terminalId)),
      )
    case "markDraining":
      return { ok: true }
    case "shutdownWhenEmpty":
      if (host.listRunning().length === 0) host.stopAll()
      return null
    case "listRunning":
      return host.listRunning()
    case "listLeases":
      return host.listLeases(text(payload.terminalId))
    case "currentWriterLease":
      return host.currentWriterLease(text(payload.terminalId))
    case "forceTakeover":
      return host.forceTakeover(
        text(payload.terminalId),
        text(payload.terminalEpoch),
        text(payload.principalId),
        text(payload.connectionId),
      )
    case "transferLease":
      return host.transferLease(
        text(payload.terminalId),
        text(payload.terminalEpoch),
        text(payload.leaseId),
        text(payload.principalId),
        text(payload.connectionId),
        text(payload.targetPrincipalId),
        text(payload.targetConnectionId),
      )
    case "releaseConnection":
      return host.releaseConnection(text(payload.connectionId))
    case "ping":
      return { ok: true, pid: process.pid, persistenceDegraded: host.persistenceDegraded }
    case "getCwd":
      return host.getCwd(text(payload.terminalId))
    case "waitForExit":
      return host.waitForExit(text(payload.terminalId))
    case "shutdown":
      host.stopAll()
      return null
    default:
      throw new SupervisorProtocolError(
        "INVALID_MESSAGE",
        `unsupported supervisor operation: ${command.operation}`,
      )
  }
}

export function supervisorResponse(
  requestId: string,
  value: unknown,
): SupervisorResponse {
  return { version: 2, kind: "response", requestId, ok: true, value }
}

export function supervisorErrorResponse(
  requestId: string,
  error: unknown,
): SupervisorResponse {
  if (error instanceof TerminalControlError) {
    return {
      version: 2,
      kind: "response",
      requestId,
      ok: false,
      error: { code: error.code, message: error.message },
    }
  }
  if (error instanceof SupervisorProtocolError) {
    return {
      version: 2,
      kind: "response",
      requestId,
      ok: false,
      error: { code: error.code, message: error.message },
    }
  }
  return {
    version: 2,
    kind: "response",
    requestId,
    ok: false,
    error: {
      code: "OPERATION_FAILED",
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

export function parseSupervisorFrame(payload: Uint8Array): SupervisorProtocolMessage | null {
  try {
    return decodeSupervisorProtocolMessage(payload)
  } catch {
    return null
  }
}
