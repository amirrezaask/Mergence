import { randomUUID } from "node:crypto"

export type TerminalLeaseMode = "writer" | "observer"

export type TerminalLease = {
  readonly terminalId: string
  readonly terminalEpoch: string
  readonly leaseId: string
  readonly leaseGeneration: number
  readonly principalId: string
  readonly connectionId: string
  readonly mode: TerminalLeaseMode
  readonly acquiredAt: string
  readonly expiresAt: string
}

export type TerminalLeaseRequest = {
  readonly terminalId: string
  readonly terminalEpoch: string
  readonly principalId: string
  readonly connectionId: string
  readonly mode: TerminalLeaseMode
}

export type TerminalMutationFence = {
  readonly terminalId: string
  readonly terminalEpoch: string
  readonly leaseId: string
  readonly leaseGeneration: number
  readonly principalId: string
  readonly connectionId: string
  readonly commandId: string
}

export type TerminalControlErrorCode =
  | "TERMINAL_NOT_FOUND"
  | "TERMINAL_EPOCH_STALE"
  | "WRITER_LEASE_REQUIRED"
  | "WRITER_LEASE_STALE"
  | "LEASE_NOT_HELD"
  | "COMMAND_DUPLICATE"

export class TerminalControlError extends Error {
  constructor(
    readonly code: TerminalControlErrorCode,
    readonly terminalId: string,
    message: string,
    readonly leaseId?: string,
  ) {
    super(message)
    this.name = "TerminalControlError"
  }
}

type TerminalControlState = {
  terminalEpoch: string
  leaseGeneration: number
  /** Primary writer kept for compatibility with the single-writer API. */
  writer: TerminalLease | null
  /** Writer leases for all connected clients, keyed by lease ID. */
  writers: Map<string, TerminalLease>
  observers: Map<string, TerminalLease>
  commandIds: Map<string, number>
}

type TerminalControlClock = {
  now(): number
}

const SYSTEM_CLOCK: TerminalControlClock = { now: () => Date.now() }
const DEFAULT_LEASE_TTL_MS = 15_000
const MAX_COMMAND_IDS = 1_024

function iso(time: number): string {
  return new Date(time).toISOString()
}

function expired(lease: TerminalLease, now: number): boolean {
  return Date.parse(lease.expiresAt) <= now
}

/**
 * Authoritative control state for one terminal runtime.
 *
 * A terminal may have one writer lease per connected client. Observer leases
 * are still available for explicitly read-only clients, but writer leases do
 * not serialize otherwise-authorized clients behind the first connection. The
 * registry owns only control metadata. PTY bytes and terminal semantic state
 * remain in the terminal entry. Every mutation path must validate a fence here
 * before touching that entry.
 */
export class TerminalControlRegistry {
  private readonly terminals = new Map<string, TerminalControlState>()
  private readonly leaseTtlMs: number
  private readonly clock: TerminalControlClock
  private readonly makeId: () => string

  constructor(options: {
    readonly leaseTtlMs?: number
    readonly clock?: TerminalControlClock
    readonly makeId?: () => string
  } = {}) {
    this.leaseTtlMs = Math.max(1, Math.trunc(options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS))
    this.clock = options.clock ?? SYSTEM_CLOCK
    this.makeId = options.makeId ?? randomUUID
  }

  registerTerminal(terminalId: string, terminalEpoch: string): void {
    if (!terminalId || !terminalEpoch) {
      throw new Error("terminal ID and epoch are required")
    }
    const existing = this.terminals.get(terminalId)
    if (existing && existing.terminalEpoch !== terminalEpoch) {
      throw new TerminalControlError(
        "TERMINAL_EPOCH_STALE",
        terminalId,
        "terminal ID is already registered to another epoch",
      )
    }
    if (!existing) {
      this.terminals.set(terminalId, {
        terminalEpoch,
        leaseGeneration: 0,
        writer: null,
        writers: new Map(),
        observers: new Map(),
        commandIds: new Map(),
      })
    }
  }

  unregisterTerminal(terminalId: string, terminalEpoch?: string): void {
    const state = this.terminals.get(terminalId)
    if (!state) return
    if (terminalEpoch && state.terminalEpoch !== terminalEpoch) return
    this.terminals.delete(terminalId)
  }

  leaseFor(terminalId: string, leaseId: string): TerminalLease | null {
    const state = this.state(terminalId)
    this.purge(state)
    return this.leaseForState(state, leaseId)
  }

  acquire(request: TerminalLeaseRequest): TerminalLease {
    const state = this.stateForEpoch(request.terminalId, request.terminalEpoch)
    this.purge(state)
    if (request.mode === "writer") {
      const existing = [...state.writers.values()].find(
        lease =>
          lease.principalId === request.principalId &&
          lease.connectionId === request.connectionId,
      )
      if (existing) return this.renewLease(state, existing, request.principalId, request.connectionId)

      const previous = [...state.observers.values()].find(
        lease =>
          lease.principalId === request.principalId &&
          lease.connectionId === request.connectionId,
      )
      if (previous) state.observers.delete(previous.leaseId)

      // A generation identifies the current shared writer cohort. New
      // connections join that cohort; forceTakeover is the explicit operation
      // that invalidates every existing writer fence.
      if (!state.writer) state.leaseGeneration += 1
      const lease = this.newLease(state, request, state.leaseGeneration)
      state.writers.set(lease.leaseId, lease)
      if (!state.writer) state.writer = lease
      return lease
    }
    const previous = [...state.observers.values()].find(
      lease =>
        lease.principalId === request.principalId &&
        lease.connectionId === request.connectionId,
    )
    if (previous) return this.renewLease(state, previous, request.principalId, request.connectionId)
    const lease = this.newLease(state, request, state.leaseGeneration)
    state.observers.set(lease.leaseId, lease)
    return lease
  }

  renew(
    terminalId: string,
    terminalEpoch: string,
    leaseId: string,
    principalId: string,
    connectionId: string,
  ): TerminalLease {
    const state = this.stateForEpoch(terminalId, terminalEpoch)
    this.purge(state)
    const lease = this.leaseForState(state, leaseId)
    if (!lease) {
      throw new TerminalControlError(
        "WRITER_LEASE_STALE",
        terminalId,
        "terminal lease is missing or expired",
        leaseId,
      )
    }
    if (lease.principalId !== principalId || lease.connectionId !== connectionId) {
      throw new TerminalControlError(
        "WRITER_LEASE_STALE",
        terminalId,
        "terminal lease belongs to another connection",
        leaseId,
      )
    }
    return this.renewLease(state, lease, principalId, connectionId)
  }

  release(
    terminalId: string,
    terminalEpoch: string,
    leaseId: string,
    principalId: string,
    connectionId: string,
  ): void {
    const state = this.stateForEpoch(terminalId, terminalEpoch)
    const lease = this.leaseForState(state, leaseId)
    if (!lease) return
    if (lease.principalId !== principalId || lease.connectionId !== connectionId) {
      throw new TerminalControlError(
        "LEASE_NOT_HELD",
        terminalId,
        "terminal lease belongs to another connection",
        leaseId,
      )
    }
    if (state.writers.delete(leaseId) && state.writer?.leaseId === leaseId) {
      state.writer = state.writers.values().next().value ?? null
    }
    state.observers.delete(leaseId)
  }

  releaseConnection(connectionId: string): void {
    for (const state of this.terminals.values()) {
      this.purge(state)
      let writerDisconnected = false
      for (const [leaseId, lease] of state.writers) {
        if (lease.connectionId !== connectionId) continue
        writerDisconnected = true
        state.writers.delete(leaseId)
        if (state.writer?.leaseId === leaseId) state.writer = null
      }
      for (const [leaseId, lease] of state.observers) {
        if (lease.connectionId === connectionId) state.observers.delete(leaseId)
      }
      if (!state.writer) state.writer = state.writers.values().next().value ?? null
      if (writerDisconnected && state.writers.size === 0) {
        const nextObserver = state.observers.values().next().value
        if (nextObserver) {
          state.observers.delete(nextObserver.leaseId)
          state.leaseGeneration += 1
          const promoted = this.newLease(
            state,
            {
              terminalId: nextObserver.terminalId,
              terminalEpoch: nextObserver.terminalEpoch,
              principalId: nextObserver.principalId,
              connectionId: nextObserver.connectionId,
              mode: "writer",
            },
            state.leaseGeneration,
          )
          state.writer = promoted
          state.writers.set(promoted.leaseId, promoted)
        }
      }
    }
  }

  forceTakeover(
    terminalId: string,
    terminalEpoch: string,
    principalId: string,
    connectionId: string,
  ): TerminalLease {
    const state = this.stateForEpoch(terminalId, terminalEpoch)
    state.writer = null
    state.writers.clear()
    for (const [leaseId, lease] of state.observers) {
      if (lease.principalId === principalId && lease.connectionId === connectionId) {
        state.observers.delete(leaseId)
      }
    }
    state.leaseGeneration += 1
    const request: TerminalLeaseRequest = {
      terminalId,
      terminalEpoch,
      principalId,
      connectionId,
      mode: "writer",
    }
    const lease = this.newLease(state, request, state.leaseGeneration)
    state.writer = lease
    state.writers.set(lease.leaseId, lease)
    return lease
  }

  transfer(
    terminalId: string,
    terminalEpoch: string,
    leaseId: string,
    principalId: string,
    connectionId: string,
    targetPrincipalId: string,
    targetConnectionId: string,
  ): TerminalLease {
    const state = this.stateForEpoch(terminalId, terminalEpoch)
    this.purge(state)
    const writer = state.writers.get(leaseId)
    if (!writer) {
      throw new TerminalControlError(
        "WRITER_LEASE_STALE",
        terminalId,
        "only the active writer can transfer control",
        leaseId,
      )
    }
    if (writer.principalId !== principalId || writer.connectionId !== connectionId) {
      throw new TerminalControlError(
        "LEASE_NOT_HELD",
        terminalId,
        "terminal lease belongs to another connection",
        leaseId,
      )
    }
    return this.forceTakeover(
      terminalId,
      terminalEpoch,
      targetPrincipalId,
      targetConnectionId,
    )
  }

  authorizeMutation(fence: TerminalMutationFence): TerminalLease {
    const state = this.stateForEpoch(fence.terminalId, fence.terminalEpoch)
    this.purge(state)
    const writer = state.writers.get(fence.leaseId)
    if (!writer) {
      const activeWriter = state.writer ?? state.writers.values().next().value
      throw new TerminalControlError(
        activeWriter ? "WRITER_LEASE_STALE" : "WRITER_LEASE_REQUIRED",
        fence.terminalId,
        activeWriter
          ? "terminal mutation fence is stale"
          : "an active writer lease is required",
        fence.leaseId,
      )
    }
    if (
      writer.terminalEpoch !== fence.terminalEpoch ||
      writer.leaseId !== fence.leaseId ||
      writer.leaseGeneration !== fence.leaseGeneration ||
      writer.principalId !== fence.principalId ||
      writer.connectionId !== fence.connectionId
    ) {
      throw new TerminalControlError(
        "WRITER_LEASE_STALE",
        fence.terminalId,
        "terminal mutation fence is stale",
        fence.leaseId,
      )
    }
    if (state.commandIds.has(fence.commandId)) {
      throw new TerminalControlError(
        "COMMAND_DUPLICATE",
        fence.terminalId,
        "terminal command ID was already accepted",
        fence.leaseId,
      )
    }
    state.commandIds.set(fence.commandId, this.clock.now())
    while (state.commandIds.size > MAX_COMMAND_IDS) {
      const oldest = state.commandIds.keys().next()
      if (oldest.done) break
      state.commandIds.delete(oldest.value)
    }
    // Refresh the fence that accepted this mutation so each active client can
    // keep its own writer lease alive independently.
    return this.renewLease(state, writer, writer.principalId, writer.connectionId)
  }

  writer(terminalId: string): TerminalLease | null {
    const state = this.state(terminalId)
    this.purge(state)
    return state.writer
  }

  list(terminalId: string): TerminalLease[] {
    const state = this.state(terminalId)
    this.purge(state)
    return [
      ...state.writers.values(),
      ...state.observers.values(),
    ]
  }

  private state(terminalId: string): TerminalControlState {
    const state = this.terminals.get(terminalId)
    if (!state) {
      throw new TerminalControlError(
        "TERMINAL_NOT_FOUND",
        terminalId,
        "terminal control state is not registered",
      )
    }
    return state
  }

  private stateForEpoch(terminalId: string, terminalEpoch: string): TerminalControlState {
    const state = this.state(terminalId)
    if (state.terminalEpoch !== terminalEpoch) {
      throw new TerminalControlError(
        "TERMINAL_EPOCH_STALE",
        terminalId,
        "terminal epoch does not match the owner state",
      )
    }
    return state
  }

  private purge(state: TerminalControlState): void {
    const current = this.clock.now()
    for (const [leaseId, lease] of state.writers) {
      if (expired(lease, current)) state.writers.delete(leaseId)
    }
    if (!state.writer || !state.writers.has(state.writer.leaseId)) {
      state.writer = state.writers.values().next().value ?? null
    }
    for (const [leaseId, lease] of state.observers) {
      if (expired(lease, current)) state.observers.delete(leaseId)
    }
  }

  private leaseForState(
    state: TerminalControlState,
    leaseId: string,
  ): TerminalLease | null {
    return state.writers.get(leaseId) ?? state.observers.get(leaseId) ?? null
  }

  private renewLease(
    state: TerminalControlState,
    lease: TerminalLease,
    principalId: string,
    connectionId: string,
  ): TerminalLease {
    const refreshed: TerminalLease = {
      ...lease,
      principalId,
      connectionId,
      expiresAt: iso(this.clock.now() + this.leaseTtlMs),
    }
    if (state.writers.has(lease.leaseId)) {
      state.writers.set(lease.leaseId, refreshed)
      if (state.writer?.leaseId === lease.leaseId) state.writer = refreshed
    } else {
      state.observers.set(lease.leaseId, refreshed)
    }
    return refreshed
  }

  private newLease(
    state: TerminalControlState,
    request: TerminalLeaseRequest,
    leaseGeneration: number,
  ): TerminalLease {
    const acquiredAt = this.clock.now()
    return {
      terminalId: request.terminalId,
      terminalEpoch: state.terminalEpoch,
      leaseId: `lease-${this.makeId()}`,
      leaseGeneration,
      principalId: request.principalId,
      connectionId: request.connectionId,
      mode: request.mode,
      acquiredAt: iso(acquiredAt),
      expiresAt: iso(acquiredAt + this.leaseTtlMs),
    }
  }
}
