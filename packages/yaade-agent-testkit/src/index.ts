import type {
  AgentDriver,
  AgentDriverContext,
  OpenAgentThreadRequest,
} from "@yaade/agent-driver"
import type {
  AgentCommandEnvelope,
  AgentCommandResult,
} from "@yaade/agent-protocol"

export interface AgentDriverConformanceOptions {
  readonly driver: AgentDriver
  readonly context: AgentDriverContext
  readonly request: OpenAgentThreadRequest
  readonly command: AgentCommandEnvelope
  readonly expectedEventCount: number
}

export interface AgentDriverConformanceReport {
  readonly passed: boolean
  readonly checks: ReadonlyArray<{
    readonly name: string
    readonly passed: boolean
    readonly detail?: string
  }>
  readonly firstCommand: AgentCommandResult
  readonly duplicateCommand: AgentCommandResult
  readonly eventTypes: ReadonlyArray<string>
}

/**
 * Capability-neutral core lifecycle checks shared by every driver.
 * Provider-specific suites can layer capability-gated assertions on this report.
 */
export async function runAgentDriverConformanceSuite(
  options: AgentDriverConformanceOptions,
): Promise<AgentDriverConformanceReport> {
  const checks: Array<{
    readonly name: string
    readonly passed: boolean
    readonly detail?: string
  }> = []
  const detection = await options.driver.detect({
    cwdUri: options.request.cwdUri,
    signal: options.context.signal,
    commands: options.context.commands,
  })
  checks.push({
    name: "driver detection",
    passed: detection.available,
    ...(detection.reason ? { detail: detection.reason } : {}),
  })

  const connection = await options.driver.openThread(
    options.context,
    options.request,
  )
  checks.push({
    name: "stable connection binding",
    passed: connection.binding.connectionId.length > 0,
  })
  checks.push({
    name: "negotiated capabilities",
    passed: connection.capabilities.input.text !== "unknown",
  })

  const firstCommand = await connection.send(options.command)
  checks.push({
    name: "first command accepted",
    passed: firstCommand.status === "accepted",
    detail: firstCommand.status,
  })

  const duplicateCommand = await connection.send(options.command)
  checks.push({
    name: "duplicate command idempotent",
    passed: duplicateCommand.status === "already-applied",
    detail: duplicateCommand.status,
  })

  const iterator = connection.events()[Symbol.asyncIterator]()
  const eventTypes: string[] = []
  for (let index = 0; index < options.expectedEventCount; index += 1) {
    const next = await iterator.next()
    if (next.done) break
    eventTypes.push(next.value.event.type)
  }
  checks.push({
    name: "canonical event stream",
    passed: eventTypes.length === options.expectedEventCount,
    detail: `${eventTypes.length}/${options.expectedEventCount}`,
  })

  await connection.close("user")
  return {
    passed: checks.every((check) => check.passed),
    checks,
    firstCommand,
    duplicateCommand,
    eventTypes,
  }
}
