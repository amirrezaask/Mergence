import { Schema } from "effect"

export const CapabilitySupport = Schema.Literal(
  "native",
  "emulated",
  "unsupported",
  "unknown",
)
export type CapabilitySupport = Schema.Schema.Type<typeof CapabilitySupport>

const InputCapabilities = Schema.Struct({
  text: CapabilitySupport,
  images: CapabilitySupport,
  workspaceFiles: CapabilitySupport,
  uploadedFiles: CapabilitySupport,
})

const ThreadCapabilities = Schema.Struct({
  load: CapabilitySupport,
  resume: CapabilitySupport,
  fork: CapabilitySupport,
  list: CapabilitySupport,
  delete: CapabilitySupport,
})

const TurnCapabilities = Schema.Struct({
  interrupt: CapabilitySupport,
  queue: CapabilitySupport,
  retry: CapabilitySupport,
  steer: CapabilitySupport,
})

const OutputCapabilities = Schema.Struct({
  reasoning: CapabilitySupport,
  plans: CapabilitySupport,
  usage: CapabilitySupport,
  contextWindow: CapabilitySupport,
  cost: CapabilitySupport,
  subagents: CapabilitySupport,
})

const ToolCapabilities = Schema.Struct({
  streaming: CapabilitySupport,
  parallel: CapabilitySupport,
  terminal: CapabilitySupport,
  fileDiffs: CapabilitySupport,
})

const InteractionCapabilities = Schema.Struct({
  permissions: CapabilitySupport,
  structuredInput: CapabilitySupport,
  externalUrlInput: CapabilitySupport,
})

const ConfigurationCapabilities = Schema.Struct({
  dynamicOptions: CapabilitySupport,
  slashCommands: CapabilitySupport,
})

export class AgentCapabilities extends Schema.Class<AgentCapabilities>(
  "AgentCapabilities",
)({
  input: InputCapabilities,
  threads: ThreadCapabilities,
  turns: TurnCapabilities,
  output: OutputCapabilities,
  tools: ToolCapabilities,
  interaction: InteractionCapabilities,
  configuration: ConfigurationCapabilities,
}) {}

export function unsupportedAgentCapabilities(): AgentCapabilities {
  const unsupported: CapabilitySupport = "unsupported"
  return AgentCapabilities.make({
    input: {
      text: unsupported,
      images: unsupported,
      workspaceFiles: unsupported,
      uploadedFiles: unsupported,
    },
    threads: {
      load: unsupported,
      resume: unsupported,
      fork: unsupported,
      list: unsupported,
      delete: unsupported,
    },
    turns: {
      interrupt: unsupported,
      queue: unsupported,
      retry: unsupported,
      steer: unsupported,
    },
    output: {
      reasoning: unsupported,
      plans: unsupported,
      usage: unsupported,
      contextWindow: unsupported,
      cost: unsupported,
      subagents: unsupported,
    },
    tools: {
      streaming: unsupported,
      parallel: unsupported,
      terminal: unsupported,
      fileDiffs: unsupported,
    },
    interaction: {
      permissions: unsupported,
      structuredInput: unsupported,
      externalUrlInput: unsupported,
    },
    configuration: {
      dynamicOptions: unsupported,
      slashCommands: unsupported,
    },
  })
}
