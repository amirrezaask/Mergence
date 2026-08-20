import { randomUUID } from "node:crypto"
import { TerminalLeaseError, type TerminalLease } from "@yaade/rpc"

const LEASE_TTL_MS = 15_000

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
  private revision = 0

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

  authorizeWrite(terminalId: string, clientId: string): TerminalLease {
    const writer = this.writerFor(terminalId)
    if (!writer) return this.acquire(terminalId, clientId, "writer")
    if (writer.lease.clientId !== clientId) {
      throw new TerminalLeaseError({
        code: "WRITER_LEASE_REQUIRED",
        terminalId,
        leaseId: writer.lease.leaseId,
        message: "writer lease required",
      })
    }
    return this.renew(terminalId, writer.lease.leaseId, clientId)
  }

  releaseClient(clientId: string): void {
    for (const [terminalId, entries] of this.leases) {
      for (const [leaseId, entry] of entries) {
        if (entry.lease.clientId === clientId) entries.delete(leaseId)
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
