import type {
  AgentDriver,
  AgentDriverContext,
  AgentDriverDetection,
  AgentDriverDetectionContext,
  AgentThreadConnection,
  OpenAgentThreadRequest,
} from "@yaade/agent-driver"
import {
  AgentConnectionId,
  AgentDriverDescriptor,
  DriverId,
  ProviderId,
  ProviderSessionId,
  type AgentCommandEnvelope,
  type AgentCommandResult,
  type UnsequencedAgentEvent,
} from "@yaade/agent-protocol"
import { Schema } from "effect"
import type { MockScenario, MockScenarioStep } from "./scenario.js"

type QueueResult<T> =
  | { readonly done: false; readonly value: T }
  | { readonly done: true }

class AsyncQueue<T> {
  static readonly maxItems = 256
  static readonly maxBytes = 1_048_576
  private values: T[] = []
  private waiters: Array<(result: QueueResult<T>) => void> = []
  private closed = false
  private bytes = 0
  private overflowed = false

  get didOverflow(): boolean { return this.overflowed }

  push(value: T): boolean {
    if (this.closed) return false
    const waiter = this.waiters.shift()
    if (waiter) { waiter({ done: false, value }); return true }
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
    if (this.values.length >= AsyncQueue.maxItems || this.bytes + bytes > AsyncQueue.maxBytes) { this.overflowed = true; this.close(); return false }
    this.values.push(value); this.bytes += bytes; return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters) waiter({ done: true })
    this.waiters = []
  }

  take(signal?: AbortSignal): Promise<QueueResult<T>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.closed || signal?.aborted) return Promise.resolve({ done: true })
    return new Promise((resolve) => {
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        resolve({ done: true })
      }
      const waiter = (result: QueueResult<T>): void => {
        signal?.removeEventListener("abort", onAbort)
        resolve(result)
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }
}

class MockThreadConnection implements AgentThreadConnection {
  readonly binding: AgentThreadConnection["binding"]
  readonly capabilities: AgentThreadConnection["capabilities"]
  readonly configuration: AgentThreadConnection["configuration"]

  private readonly eventsQueue = new AsyncQueue<UnsequencedAgentEvent>()
  private readonly appliedCommandIds = new Set<string>()
  private stepIndex = 0
  private closed = false

  constructor(private readonly scenario: MockScenario) {
    this.capabilities = scenario.capabilities
    this.configuration = scenario.configuration ?? []
    this.binding = {
      connectionId: Schema.decodeUnknownSync(AgentConnectionId)(
        `mock-connection:${scenario.id}`,
      ),
      providerSessionId: Schema.decodeUnknownSync(ProviderSessionId)(
        `mock-session:${scenario.id}`,
      ),
    }
  }

  async send(command: AgentCommandEnvelope): Promise<AgentCommandResult> {
    if (this.appliedCommandIds.has(command.commandId)) {
      return { status: "already-applied", commandId: command.commandId }
    }
    if (this.closed) {
      return {
        status: "rejected",
        commandId: command.commandId,
        error: {
          code: "mock.connection-closed",
          message: "mock connection is closed",
          retryable: false,
        },
      }
    }

    const step = this.scenario.steps[this.stepIndex]
    if (!step || step.type !== "expect-command") {
      return this.reject(command, "mock scenario expected no command")
    }
    if (step.commandType !== command.command.type) {
      return this.reject(
        command,
        `mock scenario expected ${step.commandType}, got ${command.command.type}`,
      )
    }
    const validationError = step.validate?.(command.command)
    if (validationError) return this.reject(command, validationError)

    if (step.reject) {
      this.appliedCommandIds.add(command.commandId)
      this.stepIndex += 1
      this.emitUntilNextCommand()
      return {
        status: "rejected",
        commandId: command.commandId,
        error: step.reject,
      }
    }

    this.appliedCommandIds.add(command.commandId)
    this.stepIndex += 1
    this.emitUntilNextCommand()
    return { status: "accepted", commandId: command.commandId }
  }

  async *events(signal?: AbortSignal): AsyncIterable<UnsequencedAgentEvent> {
    while (!signal?.aborted) {
      const result = await this.eventsQueue.take(signal)
      if (result.done) return
      yield result.value
    }
  }

  close(): Promise<void> {
    this.closed = true
    this.eventsQueue.close()
    return Promise.resolve()
  }

  private reject(
    command: AgentCommandEnvelope,
    message: string,
  ): AgentCommandResult {
    return {
      status: "rejected",
      commandId: command.commandId,
      error: {
        code: "mock.unexpected-command",
        message,
        retryable: false,
      },
    }
  }

  private emitUntilNextCommand(): void {
    while (this.stepIndex < this.scenario.steps.length) {
      const step: MockScenarioStep | undefined =
        this.scenario.steps[this.stepIndex]
      if (!step || step.type === "expect-command") return
      if (!this.eventsQueue.push(step.event)) {
        this.closed = true
        return
      }
      this.stepIndex += 1
    }
  }
}

export class MockAgentDriver implements AgentDriver {
  readonly descriptor: AgentDriverDescriptor

  constructor(private readonly scenario: MockScenario) {
    this.descriptor = AgentDriverDescriptor.make({
      id: Schema.decodeUnknownSync(DriverId)("mock:canonical"),
      providerId: Schema.decodeUnknownSync(ProviderId)("mock"),
      name: "Canonical Mock Driver",
      integration: "mock",
      priority: 1_000,
      supportsRemoteHost: true,
    })
  }

  detect(_context: AgentDriverDetectionContext): Promise<AgentDriverDetection> {
    return Promise.resolve({ available: true, version: "1" })
  }

  openThread(
    _context: AgentDriverContext,
    _request: OpenAgentThreadRequest,
  ): Promise<AgentThreadConnection> {
    return Promise.resolve(new MockThreadConnection(this.scenario))
  }
}
