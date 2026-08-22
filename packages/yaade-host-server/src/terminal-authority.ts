import { randomUUID } from "node:crypto"
import {
  TerminalControlError,
  type RuntimeTerminalLease,
  type TerminalMutationFence,
} from "@yaade/node-host"
import { NotFoundError, TerminalLeaseError, type TerminalLease } from "@yaade/rpc"
import type { TerminalHost } from "@yaade/node-host"
import type { RequestPrincipal } from "./principal.js"

export function toRuntimeLease(
  lease: RuntimeTerminalLease,
  terminalId: string,
): TerminalLease {
  return {
    terminalId,
    terminalEpoch: lease.terminalEpoch,
    leaseId: lease.leaseId,
    clientId: lease.connectionId,
    mode: lease.mode,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
    revision: lease.leaseGeneration,
    leaseGeneration: lease.leaseGeneration,
    principalId: lease.principalId,
    connectionId: lease.connectionId,
  }
}

export function mapControlError(error: unknown): NotFoundError | TerminalLeaseError | null {
  if (!(error instanceof TerminalControlError)) return null
  if (error.code === "TERMINAL_NOT_FOUND") {
    return new NotFoundError({
      message: error.message,
      resource: error.terminalId,
    })
  }
  return new TerminalLeaseError({
    terminalId: error.terminalId,
    leaseId: error.leaseId,
    message: error.message,
    code:
      error.code === "LEASE_NOT_HELD"
        ? "LEASE_NOT_HELD"
        : error.code === "WRITER_LEASE_REQUIRED"
          ? "WRITER_LEASE_REQUIRED"
          : "WRITER_LEASE_STALE",
  })
}

export function controlErrorToHostError(error: unknown): never {
  throw mapControlError(error) ?? error
}

export function bindOwnerFence(
  terminalId: string,
  decoded: TerminalMutationFence | null,
  principal: RequestPrincipal,
  writer: RuntimeTerminalLease | null,
): TerminalMutationFence {
  if (decoded) {
    return {
      terminalId,
      terminalEpoch: decoded.terminalEpoch,
      leaseId: decoded.leaseId,
      leaseGeneration: decoded.leaseGeneration,
      // The server owns principal and connection identity. Do not trust the
      // identity fields supplied by a client fence.
      principalId: principal.principalId,
      connectionId: principal.connectionId,
      commandId: decoded.commandId,
    }
  }
  if (
    !writer ||
    writer.principalId !== principal.principalId ||
    writer.connectionId !== principal.connectionId
  ) {
    throw new TerminalLeaseError({
      code: "WRITER_LEASE_REQUIRED",
      terminalId,
      message: "an owner-validated writer lease is required",
    })
  }
  return {
    terminalId,
    terminalEpoch: writer.terminalEpoch,
    leaseId: writer.leaseId,
    leaseGeneration: writer.leaseGeneration,
    principalId: writer.principalId,
    connectionId: writer.connectionId,
    commandId: randomUUID(),
  }
}

export async function currentOwnerWriter(
  terminal: TerminalHost,
  id: string,
  principal?: Pick<RequestPrincipal, "principalId" | "connectionId">,
): Promise<RuntimeTerminalLease | null> {
  if (principal && typeof terminal.listLeases === "function") {
    const leases = await Promise.resolve(terminal.listLeases(id))
    return (
      leases.find(
        lease =>
          lease.mode === "writer" &&
          lease.principalId === principal.principalId &&
          lease.connectionId === principal.connectionId,
      ) ?? null
    )
  }
  if (typeof terminal.currentWriterLease !== "function") return null
  return Promise.resolve(terminal.currentWriterLease(id))
}
