import type {
  AgentCapabilities,
  AgentCommand,
  AgentConfigurationOption,
  AgentError,
  UnsequencedAgentEvent,
} from "@yaade/agent-protocol"

export interface MockExpectedCommand {
  readonly type: "expect-command"
  readonly commandType: AgentCommand["type"]
  readonly validate?: (command: AgentCommand) => string | undefined
  readonly reject?: AgentError
}

export interface MockEmittedEvent {
  readonly type: "emit-event"
  readonly event: UnsequencedAgentEvent
}

export type MockScenarioStep = MockExpectedCommand | MockEmittedEvent

export interface MockScenario {
  readonly id: string
  readonly capabilities: AgentCapabilities
  readonly configuration?: ReadonlyArray<AgentConfigurationOption>
  readonly steps: ReadonlyArray<MockScenarioStep>
}

export function rejectCommand(
  commandType: AgentCommand["type"],
  error: AgentError,
  validate?: (command: AgentCommand) => string | undefined,
): MockExpectedCommand {
  return {
    type: "expect-command",
    commandType,
    ...(validate ? { validate } : {}),
    reject: error,
  }
}

export function defineScenario(scenario: MockScenario): MockScenario {
  return scenario
}

export function expectCommand(
  commandType: AgentCommand["type"],
  validate?: (command: AgentCommand) => string | undefined,
): MockExpectedCommand {
  return {
    type: "expect-command",
    commandType,
    ...(validate ? { validate } : {}),
  }
}

export function emitEvent(event: UnsequencedAgentEvent): MockEmittedEvent {
  return { type: "emit-event", event }
}
