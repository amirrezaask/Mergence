import { randomUUID } from "node:crypto"
import { TerminalLeaseError, type TerminalLease } from "@yaade/rpc"

const LEASE_TTL_MS = 15_000
const DISCONNECT_GRACE_MS = (() => {
  const raw = Number(process.env.JET_LEASE_DISCONNECT_GRACE_MS)
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 2_000
})()

type LeaseEntry = {
  lease: TerminalLease
  terminalId: string
}

function now(): number {
  return Date.now()
}

function iso(time: number): string {
  return new Date(time).toISOString()
}

function expired(lease: TerminalLease, time = now()): boolean {
  return Date.parse(lease.expiresAt) <= time
}

/** In-memory writer/observer ownership. Leases intentionally do not survive a daemon restart. */
export class TerminalLeaseService {
  private readonly terminalEpochs = new Map<string, string>()
  private readonly leases = new Map<string, Map<string, LeaseEntry>>()
  private readonly acceptedCommands = new Map<string, Set<string>>()
  private revision = 0

  bindTerminalEpoch(terminalId: string, terminalEpoch: string): void {
    if (!terminalId || !terminalEpoch) return
    const existing = this.terminalEpochs.get(terminalId)
    if (existing === terminalEpoch) return
    if (existing) this.leases.delete(terminalId)
    this.terminalEpochs.set(terminalId, terminalEpoch)
  }

  invalidateTerminal(terminalId: string, terminalEpoch?: string): void {
    const existing = this.terminalEpochs.get(terminalId)
    if (terminalEpoch && existing && existing !== terminalEpoch) return
    this.terminalEpochs.delete(terminalId)
    this.leases.delete(terminalId)
    this.acceptedCommands.delete(terminalId)
  }

  private epochFor(terminalId: string): string {
    const existing = this.terminalEpochs.get(terminalId)
    if (existing) return existing
    const epoch = randomUUID()
    this.terminalEpochs.set(terminalId, epoch)
    return epoch
  }

  private entriesFor(terminalId: string): Map<string, LeaseEntry> {
    const entries = this.leases.get(terminalId) ?? new Map<string, LeaseEntry>()
    this.leases.set(terminalId, entries)
    return entries
  }

  private purge(terminalId: string): void {
    const entries = this.entriesFor(terminalId)
    for (const [leaseId, entry] of entries) {
      if (expired(entry.lease)) entries.delete(leaseId)
    }
  }

  private writerFor(terminalId: string): LeaseEntry | undefined {
    this.purge(terminalId)
    for (const entry of this.entriesFor(terminalId).values()) {
      if (entry.lease.mode === "writer") return entry
    }
    return undefined
  }

  private makeLease(
    terminalId: string,
    clientId: string,
    mode: "writer" | "observer",
  ): TerminalLease {
    const acquired = now()
    this.revision += 1
    return {
      terminalId,
      terminalEpoch: this.epochFor(terminalId),
      leaseId: `lease-${randomUUID()}`,
      clientId,
      mode,
      acquiredAt: iso(acquired),
      expiresAt: iso(acquired + LEASE_TTL_MS),
      revision: this.revision,
      leaseGeneration: this.revision,
    }
  }

  acquire(
    terminalId: string,
    clientId: string,
    mode: "writer" | "observer" = "writer",
  ): TerminalLease {
    if (!terminalId || !clientId) throw new Error("terminal and client are required")
    this.purge(terminalId)
    if (mode === "writer") {
      const writer = this.writerFor(terminalId)
      if (writer && writer.lease.clientId !== clientId) {
        throw new TerminalLeaseError({
          code: "WRITER_LEASE_REQUIRED",
          terminalId,
          message: "terminal is controlled by another client",
        })
      }
      if (writer) return this.renew(terminalId, writer.lease.leaseId, clientId)
    }
    const lease = this.makeLease(terminalId, clientId, mode)
    this.entriesFor(terminalId).set(lease.leaseId, { terminalId, lease })
    return lease
  }

  renew(terminalId: string, leaseId: string, clientId: string): TerminalLease {
    const entry = this.entriesFor(terminalId).get(leaseId)
    if (!entry || entry.lease.clientId !== clientId || expired(entry.lease)) {
      throw new TerminalLeaseError({
        code: "WRITER_LEASE_STALE",
        terminalId,
        leaseId,
        message: "terminal lease is stale",
      })
    }
    const refreshed = {
      ...entry.lease,
      expiresAt: iso(now() + LEASE_TTL_MS),
      revision: ++this.revision,
    }
    entry.lease = refreshed
    return refreshed
  }

  release(terminalId: string, leaseId: string, clientId: string): void {
    const entry = this.entriesFor(terminalId).get(leaseId)
    if (!entry) return
    if (entry.lease.clientId !== clientId) {
      throw new TerminalLeaseError({
        code: "WRITER_LEASE_STALE",
        terminalId,
        leaseId,
        message: "terminal lease belongs to another client",
      })
    }
    this.entriesFor(terminalId).delete(leaseId)
  }

  requestControl(terminalId: string, clientId: string): TerminalLease | null {
    const writer = this.writerFor(terminalId)
    if (!writer || writer.lease.clientId === clientId) {
      return this.acquire(terminalId, clientId, "writer")
    }
    return null
  }

  transfer(
    terminalId: string,
    leaseId: string,
    clientId: string,
    targetClientId: string,
  ): TerminalLease {
    const entry = this.entriesFor(terminalId).get(leaseId)
    if (
      !entry ||
      entry.lease.mode !== "writer" ||
      entry.lease.clientId !== clientId ||
      expired(entry.lease)
    ) {
      throw new TerminalLeaseError({
        code: "WRITER_LEASE_STALE",
        terminalId,
        leaseId,
        message: "only the active writer can transfer control",
      })
    }
    this.entriesFor(terminalId).delete(leaseId)
    return this.acquire(terminalId, targetClientId, "writer")
  }

  authorizeMutationFence(
    terminalId: string,
    fence: {
      readonly terminalId: string
      readonly terminalEpoch: string
      readonly leaseId: string
      readonly leaseGeneration: number
      readonly principalId: string
      readonly connectionId: string
      readonly commandId: string
    },
    principal: { readonly principalId: string; readonly connectionId: string },
  ): TerminalLease {
    const writer = this.writerFor(terminalId)
    if (
      !writer ||
      fence.terminalId !== terminalId ||
      fence.terminalEpoch !== writer.lease.terminalEpoch ||
      fence.leaseId !== writer.lease.leaseId ||
      fence.leaseGeneration !== writer.lease.leaseGeneration ||
      fence.principalId !== principal.principalId ||
      fence.connectionId !== principal.connectionId ||
      fence.connectionId !== writer.lease.clientId
    ) {
      throw new TerminalLeaseError({
        code: writer ? "WRITER_LEASE_STALE" : "WRITER_LEASE_REQUIRED",
        terminalId,
        leaseId: writer?.lease.leaseId,
        message: "terminal mutation fence is stale",
      })
    }
    const commands = this.acceptedCommands.get(terminalId) ?? new Set<string>()
    if (commands.has(fence.commandId)) {
      throw new TerminalLeaseError({
        code: "WRITER_LEASE_STALE",
        terminalId,
        leaseId: fence.leaseId,
        message: "terminal command was already accepted",
      })
    }
    commands.add(fence.commandId)
    while (commands.size > 1_024) {
      const oldest = commands.values().next().value
      if (typeof oldest !== "string") break
      commands.delete(oldest)
    }
    this.acceptedCommands.set(terminalId, commands)
    return this.renew(terminalId, writer.lease.leaseId, writer.lease.clientId)
  }

  authorizeWrite(terminalId: string, clientId: string): TerminalLease {
    const writer = this.writerFor(terminalId)
    if (!writer) {
      throw new TerminalLeaseError({
        code: "WRITER_LEASE_REQUIRED",
        terminalId,
        message: "an explicit writer lease is required before terminal input",
      })
    }
    if (writer.lease.clientId !== clientId) {
      throw new TerminalLeaseError({
        code: "LEASE_NOT_HELD",
        terminalId,
        leaseId: writer.lease.leaseId,
        message: "LEASE_NOT_HELD",
      })
    }
    return this.renew(terminalId, writer.lease.leaseId, clientId)
  }

  /**
   * First eligible client becomes writer. Later attachers are observers unless
   * they already hold the writer lease. Pass `observer` for mobile viewports.
   */
  attachClient(
    terminalId: string,
    clientId: string,
    preferredMode: "writer" | "observer" = "writer",
  ): TerminalLease {
    if (preferredMode === "observer") {
      return this.acquire(terminalId, clientId, "observer")
    }
    const writer = this.writerFor(terminalId)
    if (!writer || writer.lease.clientId === clientId) {
      return this.acquire(terminalId, clientId, "writer")
    }
    return this.acquire(terminalId, clientId, "observer")
  }

  currentWriter(terminalId: string): TerminalLease | undefined {
    return this.writerFor(terminalId)?.lease
  }

  releaseClient(
    clientId: string,
    options: { readonly preserveWriter?: boolean } = {},
  ): void {
    const preserveWriter = options.preserveWriter !== false
    for (const [terminalId, entries] of this.leases) {
      let writerReleased = false
      for (const [leaseId, entry] of entries) {
        if (entry.lease.clientId !== clientId) continue
        if (entry.lease.mode === "writer" && preserveWriter && DISCONNECT_GRACE_MS > 0) {
          entry.lease = {
            ...entry.lease,
            expiresAt: iso(now() + DISCONNECT_GRACE_MS),
          }
          continue
        }
        writerReleased ||= entry.lease.mode === "writer"
        entries.delete(leaseId)
      }
      if (writerReleased && entries.size > 0) {
        const next = [...entries.values()].find(entry => entry.lease.mode === "observer")
        if (next) {
          next.lease = {
            ...next.lease,
            mode: "writer",
            revision: ++this.revision,
          }
        }
      }
      if (entries.size === 0) this.leases.delete(terminalId)
    }
  }

  listViewers(terminalId: string): string[] {
    this.purge(terminalId)
    return [...new Set([...this.entriesFor(terminalId).values()].map(entry => entry.lease.clientId))]
  }

  listAll(): TerminalLease[] {
    const result: TerminalLease[] = []
    for (const terminalId of this.leases.keys()) {
      this.purge(terminalId)
      for (const entry of this.entriesFor(terminalId).values()) result.push(entry.lease)
    }
    return result
  }
}
