import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { AgentDriver, AgentDriverContext, AgentDriverDetectionContext, AgentThreadConnection, OpenAgentThreadRequest } from "@yaade/agent-driver"
import {
  AgentCommandEnvelope,
  AgentConnectionState,
  AgentEventEnvelope,
  AgentProviderDescriptor,
  AgentThreadId,
  type AgentCommandEnvelope as AgentCommandEnvelopeType,
  type AgentCommandResult,
  type AgentEvent,
  type AgentEventEnvelope as AgentEventEnvelopeType,
  type AgentThreadSnapshot,
  type UnsequencedAgentEvent,
} from "@yaade/agent-protocol"
import { Schema } from "effect"
import { AgentThreadStore } from "./store.js"

export type CreateAgentThread = {
  threadId?: string
  projectSessionId: string
  providerId?: string
  driverId?: string
  cwdUri: string
  mode?: OpenAgentThreadRequest["mode"]
  configuration?: Readonly<Record<string, unknown>>
}

export type AgentThreadRuntimeOptions = {
  db: DatabaseSync
  drivers: ReadonlyArray<AgentDriver>
  context?: AgentDriverContext
  contextFor?: (input: {
    readonly threadId: string
    readonly projectSessionId: string
    readonly cwdUri: string
    readonly signal: AbortSignal
  }) => AgentDriverContext
  detectionContextFor?: (input: {
    readonly cwdUri: string
    readonly signal: AbortSignal
  }) => AgentDriverDetectionContext
  publish?: (
    event: AgentEventEnvelopeType,
    snapshot: AgentThreadSnapshot,
  ) => void
  publishSnapshot?: (snapshot: AgentThreadSnapshot) => void
  publishConnection?: (threadId: string, state: AgentConnectionState) => void
  /** Test hook; production retries unexpected provider disconnects exponentially. */
  reconnectDelayMs?: (attempt: number) => number
}

type Controller = {
  connection: AgentThreadConnection
  generation: number
  abort: AbortController
  queue: Promise<void>
  clock: AgentDriverContext["clock"]
  pendingDelta?: PendingDelta
}

type ConnectionAttempt = {
  readonly abort: AbortController
  readonly token: object
}

class ConnectionAttemptCancelled extends Error {
  constructor() {
    super("agent connection attempt was cancelled")
    this.name = "ConnectionAttemptCancelled"
  }
}

type DeltaEvent = Extract<AgentEvent, { readonly type: "item.delta" }>

type PendingDelta = {
  readonly itemId: DeltaEvent["itemId"]
  revision: number
  text: string
  occurredAt?: string
  providerCursor?: string
  nativeEventId?: string
  readonly token: object
}

const DELTA_COALESCE_MS = 12
const MAX_COALESCED_DELTA_BYTES = 16 * 1024

const asThreadId = (value: string) => Schema.decodeUnknownSync(AgentThreadId)(value)

/** Host-only controller. A Promise tail serializes create/event/command work per thread. */
export class AgentThreadRuntime {
  private readonly store: AgentThreadStore
  private readonly drivers = new Map<string, AgentDriver>()
  private readonly controllers = new Map<string, Controller>()
  private readonly connectionStates = new Map<string, AgentConnectionState>()
  private readonly publish: (
    event: AgentEventEnvelopeType,
    snapshot: AgentThreadSnapshot,
  ) => void
  private readonly publishSnapshot: (snapshot: AgentThreadSnapshot) => void
  private readonly publishConnection: (threadId: string, state: AgentConnectionState) => void
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly reconnectAttempts = new Map<string, number>()
  private readonly connectionAttempts = new Map<string, ConnectionAttempt>()
  private stopping = false

  constructor(private readonly options: AgentThreadRuntimeOptions) {
    this.store = new AgentThreadStore(options.db)
    for (const driver of options.drivers) this.drivers.set(String(driver.descriptor.id), driver)
    this.publish = options.publish ?? (() => {})
    this.publishSnapshot = options.publishSnapshot ?? (() => {})
    this.publishConnection = options.publishConnection ?? (() => {})
  }

  getSnapshot(threadId: string): AgentThreadSnapshot | null { return this.store.getSnapshot(threadId) }
  getConnectionState(threadId: string): AgentConnectionState {
    return this.connectionStates.get(threadId) ?? AgentConnectionState.make({
      status: "disconnected",
      generation: this.store.getSnapshot(threadId)?.state.connectionGeneration ?? 0,
    })
  }
  list(projectSessionId?: string): AgentThreadSnapshot[] { return this.store.listSnapshots(projectSessionId) }
  listEvents(threadId: string, after?: number): AgentEventEnvelopeType[] { return this.store.listEvents(threadId, after) }
  listProviders(): AgentProviderDescriptor[] {
    const providers = new Map<string, AgentProviderDescriptor>()
    for (const driver of this.drivers.values()) {
      const id = String(driver.descriptor.providerId)
      if (providers.has(id)) continue
      providers.set(id, AgentProviderDescriptor.make({
        id: driver.descriptor.providerId,
        name: id.charAt(0).toUpperCase() + id.slice(1),
      }))
    }
    return [...providers.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  async listDrivers(cwdUri: string): Promise<ReadonlyArray<{
    descriptor: AgentDriver["descriptor"]
    available: boolean
    version?: string
    reason?: string
  }>> {
    const abort = new AbortController()
    const detected = await Promise.all([...this.drivers.values()].map(async driver => {
      try {
        const result = await driver.detect(this.makeDetectionContext(cwdUri, abort.signal))
        return { descriptor: driver.descriptor, ...result }
      } catch (error) {
        return {
          descriptor: driver.descriptor,
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    }))
    return detected.sort((left, right) =>
      Number(right.available) - Number(left.available) ||
      right.descriptor.priority - left.descriptor.priority,
    )
  }

  async restore(): Promise<void> {
    for (const snapshot of this.store.listSnapshots()) {
      if (snapshot.state.status === "closed" || this.controllers.has(snapshot.state.id)) continue
      try {
        this.setConnectionState(String(snapshot.state.id), AgentConnectionState.make({
          status: "connecting",
          generation: snapshot.state.connectionGeneration + 1,
        }))
        await this.connectExisting(snapshot)
      } catch (error) {
        if (error instanceof ConnectionAttemptCancelled || this.stopping) continue
        this.setConnectionState(String(snapshot.state.id), AgentConnectionState.make({
          status: "unavailable",
          generation: snapshot.state.connectionGeneration,
          error: {
            code: "agent.restore-unavailable",
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          },
        }))
        // A missing provider binary must not prevent the host from starting.
        // The durable snapshot remains available while the bounded reconnect
        // loop retries the same concrete driver binding.
        this.scheduleReconnect(String(snapshot.state.id))
      }
    }
  }

  async create(input: CreateAgentThread): Promise<AgentThreadSnapshot> {
    if (this.stopping) throw new Error("agent runtime is shutting down")
    const threadId = input.threadId ?? `ath-${randomUUID()}`
    this.clearReconnect(threadId)
    if (this.store.getSnapshot(threadId)) throw new Error(`agent thread already exists: ${threadId}`)
    const driver = await this.resolveDriver(input, threadId)
    const abort = new AbortController()
    const context = this.makeContext(threadId, input.projectSessionId, input.cwdUri, abort)
    let connection: AgentThreadConnection
    try {
      connection = await driver.openThread(context, {
        mode: input.mode ?? { type: "new" }, cwdUri: input.cwdUri,
        ...(input.configuration ? { initialConfiguration: input.configuration } : {}),
      })
    } catch (error) {
      abort.abort()
      throw error
    }
    const controller: Controller = {
      connection,
      generation: 1,
      abort,
      queue: Promise.resolve(),
      clock: context.clock,
    }
    this.controllers.set(threadId, controller)
    this.setConnectionState(threadId, AgentConnectionState.make({
      connectionId: connection.binding.connectionId,
      status: "connected",
      generation: controller.generation,
      lastConnectedAt: new Date().toISOString(),
    }))
    const snapshot = await this.serial(threadId, async () => {
      const opened = this.commit(threadId, controller.generation, {
        type: "thread.opened", projectSessionId: input.projectSessionId as never,
        providerId: driver.descriptor.providerId, driverId: driver.descriptor.id,
        ...(connection.binding.providerSessionId ? { providerSessionId: connection.binding.providerSessionId } : {}),
        cwdUri: input.cwdUri,
        capabilities: connection.capabilities,
        configuration: connection.configuration ?? [],
      })
      return opened
    })
    void this.pump(threadId, controller)
    return snapshot
  }

  async sendCommand(raw: AgentCommandEnvelopeType): Promise<AgentCommandResult> {
    const command = Schema.decodeUnknownSync(AgentCommandEnvelope)(raw) as AgentCommandEnvelopeType
    const stored = this.store.getCommandState(command.threadId, command.commandId)
    if (stored) return duplicateCommandResult(command.commandId, stored)
    return this.serial(command.threadId, async () => {
      const duplicate = this.store.getCommandState(command.threadId, command.commandId)
      if (duplicate) return duplicateCommandResult(command.commandId, duplicate)
      const controller = this.controllers.get(command.threadId)
      if (!controller) throw new Error(`agent thread is not connected: ${command.threadId}`)
      const snapshot = this.store.getSnapshot(command.threadId)
      if (
        command.expectedRevision !== undefined &&
        snapshot?.state.revision !== command.expectedRevision
      ) {
        const result: AgentCommandResult = {
          status: "rejected",
          commandId: command.commandId,
          error: {
            code: "agent.revision-conflict",
            message: `thread revision is ${snapshot?.state.revision ?? "missing"}, expected ${command.expectedRevision}`,
            retryable: true,
          },
        }
        this.store.recordCommand(command.threadId, result, new Date().toISOString())
        return result
      }
      const claimed = this.store.claimCommand(
        command.threadId,
        command,
        new Date().toISOString(),
      )
      if (!claimed) {
        const existing = this.store.getCommandState(command.threadId, command.commandId)
        return existing
          ? duplicateCommandResult(command.commandId, existing)
          : commandOutcomeUnknown(command.commandId)
      }
      let result: AgentCommandResult
      try {
        result = await controller.connection.send(command)
      } catch (error) {
        result = {
          status: "rejected",
          commandId: command.commandId,
          error: {
            code: "agent.command-outcome-unknown",
            message: `provider command outcome is unknown: ${error instanceof Error ? error.message : String(error)}`,
            retryable: false,
          },
        }
      }
      this.store.recordCommand(command.threadId, result, new Date().toISOString())
      if (command.command.type === "thread.close" && result.status !== "rejected") {
        this.flushPendingDelta(command.threadId, controller)
        this.commit(command.threadId, controller.generation, { type: "thread.closed", reason: "user" }, command.commandId)
        controller.abort.abort()
        try {
          await controller.connection.close("user")
        } catch {
          // The close event and command result are durable; cleanup is best-effort.
        }
        this.controllers.delete(command.threadId)
        this.setConnectionState(command.threadId, AgentConnectionState.make({
          status: "disconnected",
          generation: controller.generation,
          lastDisconnectedAt: new Date().toISOString(),
        }))
      }
      return result
    })
  }

  async close(threadId: string): Promise<AgentThreadSnapshot> {
    const snapshot = this.store.getSnapshot(threadId)
    if (!snapshot) throw new Error(`unknown agent thread: ${threadId}`)
    if (snapshot.state.status === "closed") return snapshot
    this.clearReconnect(threadId)
    const controller = this.controllers.get(threadId)
    if (!controller) {
      const closed = this.commit(threadId, snapshot.state.connectionGeneration, {
        type: "thread.closed",
        reason: "user",
      })
      this.setConnectionState(threadId, AgentConnectionState.make({
        status: "disconnected",
        generation: snapshot.state.connectionGeneration,
        lastDisconnectedAt: new Date().toISOString(),
      }))
      return closed
    }
    return this.serial(threadId, async () => {
      this.flushPendingDelta(threadId, controller)
      const closed = this.commit(threadId, controller.generation, {
        type: "thread.closed",
        reason: "user",
      })
      controller.abort.abort()
      try {
        await controller.connection.close("user")
      } catch {
        // The durable thread is already closed. Provider cleanup is best-effort.
      }
      this.controllers.delete(threadId)
      this.setConnectionState(threadId, AgentConnectionState.make({
        status: "disconnected",
        generation: controller.generation,
        lastDisconnectedAt: new Date().toISOString(),
      }))
      return closed
    })
  }

  async delete(threadId: string): Promise<boolean> {
    this.clearReconnect(threadId)
    if (this.controllers.has(threadId)) await this.close(threadId)
    return this.store.deleteThread(threadId)
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    for (const threadId of new Set([
      ...this.reconnectTimers.keys(),
      ...this.connectionAttempts.keys(),
    ])) this.clearReconnect(threadId)
    await Promise.all([...this.controllers.entries()].map(async ([threadId, controller]) => {
      await this.serial(threadId, async () => {
        this.flushPendingDelta(threadId, controller)
        const activeTurn = this.store
          .getSnapshot(threadId)
          ?.state.turns.find(turn => turn.status === "running")
        if (activeTurn) {
          this.commit(threadId, controller.generation, {
            type: "turn.interrupted",
            turnId: activeTurn.id,
          })
        }
        controller.abort.abort()
        await controller.connection.close("runtime-shutdown")
        this.controllers.delete(threadId)
        this.setConnectionState(threadId, AgentConnectionState.make({
          status: "disconnected",
          generation: controller.generation,
          lastDisconnectedAt: new Date().toISOString(),
        }))
      })
    }))
  }

  private async pump(threadId: string, controller: Controller): Promise<void> {
    try {
      for await (const raw of controller.connection.events(controller.abort.signal)) {
        await this.serial(threadId, () => {
          if (this.controllers.get(threadId) !== controller) return
          if (raw.event.type === "item.delta") {
            this.bufferDelta(threadId, controller, raw)
            return
          }
          this.flushPendingDelta(threadId, controller)
          this.commitUnsequenced(threadId, controller.generation, raw)
        })
      }
      if (!controller.abort.signal.aborted) {
        await this.handleUnexpectedDisconnect(threadId, controller)
      }
    } catch (error) {
      if (!controller.abort.signal.aborted) {
        await this.handleUnexpectedDisconnect(threadId, controller, error)
      }
    }
  }

  private async handleUnexpectedDisconnect(
    threadId: string,
    controller: Controller,
    error?: unknown,
  ): Promise<void> {
    await this.serial(threadId, () => {
      if (this.controllers.get(threadId) !== controller) return
      this.flushPendingDelta(threadId, controller)
      if (error !== undefined) {
        this.commit(threadId, controller.generation, {
          type: "agent.error",
          message: error instanceof Error ? error.message : String(error),
          code: "driver.event-stream",
          retryable: true,
        })
      }
      this.controllers.delete(threadId)
      this.setConnectionState(threadId, AgentConnectionState.make({
        status: error === undefined ? "disconnected" : "degraded",
        generation: controller.generation,
        lastDisconnectedAt: new Date().toISOString(),
        ...(error === undefined ? {} : {
          error: {
            code: "driver.event-stream",
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          },
        }),
      }))
    })
    try {
      await controller.connection.close("driver-restart")
    } catch {
      // The stream is already gone. Reconnect remains authoritative.
    }
    this.scheduleReconnect(threadId)
  }

  private scheduleReconnect(threadId: string): void {
    if (this.stopping || this.controllers.has(threadId) || this.reconnectTimers.has(threadId)) return
    const snapshot = this.store.getSnapshot(threadId)
    if (!snapshot || snapshot.state.status === "closed") return
    const attempt = this.reconnectAttempts.get(threadId) ?? 0
    const configuredDelay = this.options.reconnectDelayMs?.(attempt)
    const delay = configuredDelay === undefined
      ? Math.min(30_000, 1_000 * (2 ** Math.min(attempt, 5)))
      : Math.max(0, configuredDelay)
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(threadId)
      void this.reconnect(threadId, attempt)
    }, delay)
    timer.unref?.()
    this.reconnectTimers.set(threadId, timer)
  }

  private async reconnect(threadId: string, attempt: number): Promise<void> {
    if (this.stopping || this.controllers.has(threadId)) return
    const snapshot = this.store.getSnapshot(threadId)
    if (!snapshot || snapshot.state.status === "closed") return
    this.setConnectionState(threadId, AgentConnectionState.make({
      status: "connecting",
      generation: snapshot.state.connectionGeneration + 1,
    }))
    try {
      await this.connectExisting(snapshot)
      this.reconnectAttempts.delete(threadId)
    } catch (error) {
      if (error instanceof ConnectionAttemptCancelled || this.stopping) return
      this.reconnectAttempts.set(threadId, attempt + 1)
      this.setConnectionState(threadId, AgentConnectionState.make({
        status: "unavailable",
        generation: snapshot.state.connectionGeneration,
        error: {
          code: "agent.reconnect-unavailable",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      }))
      this.scheduleReconnect(threadId)
    }
  }

  private clearReconnect(threadId: string): void {
    const timer = this.reconnectTimers.get(threadId)
    if (timer) clearTimeout(timer)
    this.reconnectTimers.delete(threadId)
    this.reconnectAttempts.delete(threadId)
    const attempt = this.connectionAttempts.get(threadId)
    attempt?.abort.abort()
    this.connectionAttempts.delete(threadId)
  }

  private commitUnsequenced(threadId: string, generation: number, raw: UnsequencedAgentEvent): AgentThreadSnapshot {
    return this.commit(threadId, generation, raw.event, undefined, raw.occurredAt, raw.providerCursor, raw.nativeEventId)
  }

  private bufferDelta(
    threadId: string,
    controller: Controller,
    raw: UnsequencedAgentEvent,
  ): void {
    if (raw.event.type !== "item.delta") return
    const pending = controller.pendingDelta
    const compatible = pending?.itemId === raw.event.itemId &&
      raw.event.revision > pending.revision &&
      Buffer.byteLength(pending.text, "utf8") + Buffer.byteLength(raw.event.text, "utf8") <= MAX_COALESCED_DELTA_BYTES
    if (pending && !compatible) this.flushPendingDelta(threadId, controller)
    if (compatible && pending) {
      pending.text += raw.event.text
      pending.revision = raw.event.revision
      pending.occurredAt = raw.occurredAt ?? pending.occurredAt
      pending.providerCursor = raw.providerCursor ?? pending.providerCursor
      return
    }
    const token = {}
    controller.pendingDelta = {
      itemId: raw.event.itemId,
      revision: raw.event.revision,
      text: raw.event.text,
      ...(raw.occurredAt ? { occurredAt: raw.occurredAt } : {}),
      ...(raw.providerCursor ? { providerCursor: raw.providerCursor } : {}),
      ...(raw.nativeEventId ? { nativeEventId: raw.nativeEventId } : {}),
      token,
    }
    void controller.clock.sleep(DELTA_COALESCE_MS).then(() =>
      this.serial(threadId, () => {
        if (
          this.controllers.get(threadId) === controller &&
          controller.pendingDelta?.token === token
        ) this.flushPendingDelta(threadId, controller)
      }),
    ).catch(() => {})
  }

  private flushPendingDelta(threadId: string, controller: Controller): void {
    const pending = controller.pendingDelta
    if (!pending) return
    controller.pendingDelta = undefined
    this.commit(
      threadId,
      controller.generation,
      {
        type: "item.delta",
        itemId: pending.itemId,
        revision: pending.revision,
        text: pending.text,
      },
      undefined,
      pending.occurredAt,
      pending.providerCursor,
      pending.nativeEventId,
    )
  }

  private commit(threadId: string, generation: number, event: AgentEvent, commandId?: string, occurredAt?: string, providerCursor?: string, nativeEventId?: string): AgentThreadSnapshot {
    const previous = this.store.getSnapshot(threadId)
    const now = new Date().toISOString()
    const envelope = AgentEventEnvelope.make({
      protocolVersion: 1, eventId: nativeEventId ?? `ae-${randomUUID()}`,
      threadId: asThreadId(threadId), sequence: (previous?.state.lastSequence ?? 0) + 1,
      occurredAt: occurredAt ?? now, receivedAt: now, connectionGeneration: generation,
      ...(commandId ? { commandId } : {}), ...(providerCursor ? { providerCursor } : {}), event,
    })
    const committed = this.store.append(envelope)
    if (committed.applied) {
      this.publish(envelope, committed.snapshot)
      if (isSnapshotBoundary(event)) this.publishSnapshot(committed.snapshot)
    }
    return committed.snapshot
  }

  private async resolveDriver(
    input: CreateAgentThread,
    threadId: string,
  ): Promise<AgentDriver> {
    if (input.driverId) {
      const driver = this.drivers.get(input.driverId)
      if (!driver) throw new Error(`unknown agent driver: ${input.driverId}`)
      return driver
    }
    if (!input.providerId) throw new Error("providerId or driverId is required")
    const candidates = [...this.drivers.values()]
      .filter(driver => driver.descriptor.providerId === input.providerId)
      .sort((left, right) => right.descriptor.priority - left.descriptor.priority)
    const context = this.makeContext(
      threadId,
      input.projectSessionId,
      input.cwdUri,
      new AbortController(),
    )
    for (const driver of candidates) {
      const detection = await driver.detect(this.makeDetectionContext(input.cwdUri, context.signal))
      if (detection.available) return driver
    }
    throw new Error(`no available agent driver for provider: ${input.providerId}`)
  }

  private async connectExisting(snapshot: AgentThreadSnapshot): Promise<void> {
    const state = snapshot.state
    const threadId = String(state.id)
    if (this.stopping) throw new ConnectionAttemptCancelled()
    if (this.connectionAttempts.has(threadId)) {
      throw new Error(`agent thread is already connecting: ${threadId}`)
    }
    const driver = this.drivers.get(state.driverId)
    if (!driver) throw new Error(`unknown agent driver: ${state.driverId}`)
    const abort = new AbortController()
    const context = this.makeContext(
      threadId,
      String(state.projectSessionId),
      state.cwdUri,
      abort,
    )
    const mode: OpenAgentThreadRequest["mode"] = state.providerSessionId
      ? state.capabilities.threads.resume === "native"
        ? { type: "resume", providerSessionId: state.providerSessionId }
        : state.capabilities.threads.load === "native"
          ? { type: "load", providerSessionId: state.providerSessionId }
          : (() => {
              throw new Error(
                `driver ${state.driverId} cannot restore provider thread ${state.providerSessionId}`,
              )
            })()
      : { type: "new" }
    const attempt: ConnectionAttempt = { abort, token: {} }
    this.connectionAttempts.set(threadId, attempt)
    let connection: AgentThreadConnection
    try {
      connection = await driver.openThread(context, { mode, cwdUri: state.cwdUri })
    } catch (error) {
      if (abort.signal.aborted) throw new ConnectionAttemptCancelled()
      abort.abort()
      throw error
    } finally {
      if (this.connectionAttempts.get(threadId)?.token === attempt.token) {
        this.connectionAttempts.delete(threadId)
      }
    }
    const current = abort.signal.aborted || this.stopping
      ? null
      : this.store.getSnapshot(threadId)
    if (
      abort.signal.aborted ||
      this.stopping ||
      !current ||
      current.state.status === "closed" ||
      this.controllers.has(threadId)
    ) {
      abort.abort()
      try {
        await connection.close("driver-restart")
      } catch {
        // A cancelled late result is stale regardless of provider cleanup.
      }
      throw new ConnectionAttemptCancelled()
    }
    const controller: Controller = {
      connection,
      generation: state.connectionGeneration + 1,
      abort,
      queue: Promise.resolve(),
      clock: context.clock,
    }
    this.controllers.set(threadId, controller)
    this.setConnectionState(threadId, AgentConnectionState.make({
      connectionId: connection.binding.connectionId,
      status: "connected",
      generation: controller.generation,
      lastConnectedAt: new Date().toISOString(),
    }))
    if (
      connection.binding.providerSessionId &&
      connection.binding.providerSessionId !== state.providerSessionId
    ) {
      await this.serial(threadId, () => {
        this.commit(threadId, controller.generation, {
          type: "thread.binding-updated",
          providerSessionId: connection.binding.providerSessionId!,
        })
      })
    }
    void this.pump(threadId, controller)
  }

  private makeContext(
    threadId: string,
    projectSessionId: string,
    cwdUri: string,
    abort: AbortController,
  ): AgentDriverContext {
    const base = this.options.contextFor?.({
      threadId,
      projectSessionId,
      cwdUri,
      signal: abort.signal,
    })
      ?? this.options.context
    if (!base) throw new Error("agent driver context is not configured")
    return {
      ...base,
      workspace: { ...base.workspace, rootUri: cwdUri },
      signal: abort.signal,
    }
  }

  private makeDetectionContext(cwdUri: string, signal: AbortSignal): AgentDriverDetectionContext {
    const context = this.options.detectionContextFor?.({ cwdUri, signal })
    if (context) return context
    if (!this.options.context) throw new Error("agent driver detection context is not configured")
    return { cwdUri, signal, commands: this.options.context.commands }
  }

  private setConnectionState(threadId: string, state: AgentConnectionState): void {
    this.connectionStates.set(threadId, state)
    this.publishConnection(threadId, state)
  }

  private serial<T>(threadId: string, operation: () => Promise<T> | T): Promise<T> {
    const controller = this.controllers.get(threadId)
    if (!controller) return Promise.reject(new Error(`unknown agent thread: ${threadId}`))
    const run = controller.queue.then(operation, operation)
    controller.queue = run.then(() => undefined, () => undefined)
    return run
  }
}

function isSnapshotBoundary(event: AgentEvent): boolean {
  switch (event.type) {
    case "thread.opened":
    case "thread.closed":
    case "turn.completed":
    case "turn.failed":
    case "turn.interrupted":
    case "action.requested":
    case "action.resolved":
      return true
    default:
      return false
  }
}

function duplicateCommandResult(
  commandId: string,
  stored:
    | { readonly state: "pending" }
    | { readonly state: "completed"; readonly result: AgentCommandResult },
): AgentCommandResult {
  return stored.state === "completed"
    ? { ...stored.result, status: "already-applied" }
    : commandOutcomeUnknown(commandId)
}

function commandOutcomeUnknown(commandId: string): AgentCommandResult {
  return {
    status: "rejected",
    commandId,
    error: {
      code: "agent.command-outcome-unknown",
      message: "this command was durably dispatched but its provider outcome is unknown",
      retryable: false,
    },
  }
}
