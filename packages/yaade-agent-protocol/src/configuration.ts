import { Schema } from "effect"

export const AgentConfigurationCategory = Schema.Literal(
  "model",
  "mode",
  "reasoning",
  "permission",
  "performance",
  "other",
)
export type AgentConfigurationCategory = Schema.Schema.Type<
  typeof AgentConfigurationCategory
>

export const AgentConfigurationChoice = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
  description: Schema.optional(Schema.String),
})
export type AgentConfigurationChoice = Schema.Schema.Type<
  typeof AgentConfigurationChoice
>

const EnumConfigurationValue = Schema.Struct({
  type: Schema.Literal("enum"),
  current: Schema.String,
  choices: Schema.Array(AgentConfigurationChoice),
})

const BooleanConfigurationValue = Schema.Struct({
  type: Schema.Literal("boolean"),
  current: Schema.Boolean,
})

const NumberConfigurationValue = Schema.Struct({
  type: Schema.Literal("number"),
  current: Schema.Number,
  minimum: Schema.optional(Schema.Number),
  maximum: Schema.optional(Schema.Number),
})

const StringConfigurationValue = Schema.Struct({
  type: Schema.Literal("string"),
  current: Schema.String,
})

export const AgentConfigurationValue = Schema.Union(
  EnumConfigurationValue,
  BooleanConfigurationValue,
  NumberConfigurationValue,
  StringConfigurationValue,
)
export type AgentConfigurationValue = Schema.Schema.Type<
  typeof AgentConfigurationValue
>

export class AgentConfigurationOption extends Schema.Class<AgentConfigurationOption>(
  "AgentConfigurationOption",
)({
  id: Schema.String,
  category: AgentConfigurationCategory,
  label: Schema.String,
  description: Schema.optional(Schema.String),
  value: AgentConfigurationValue,
}) {}
