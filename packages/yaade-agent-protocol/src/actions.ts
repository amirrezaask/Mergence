import { Schema } from "effect"
import { AgentTurnId, PendingActionId } from "./ids.js"

export const AgentPermissionOption = Schema.Struct({
  id: Schema.String,
  decision: Schema.Literal(
    "allow-once",
    "allow-always",
    "reject-once",
    "reject-always",
    "custom",
  ),
  label: Schema.String,
  description: Schema.optional(Schema.String),
})
export type AgentPermissionOption = Schema.Schema.Type<
  typeof AgentPermissionOption
>

const PendingActionBase = {
  id: PendingActionId,
  turnId: Schema.optional(AgentTurnId),
  createdAt: Schema.String,
}

export const AgentPermissionAction = Schema.Struct({
  type: Schema.Literal("permission"),
  ...PendingActionBase,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  options: Schema.Array(AgentPermissionOption),
})
export type AgentPermissionAction = Schema.Schema.Type<
  typeof AgentPermissionAction
>

export const AgentElicitationField = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optional(Schema.String),
  required: Schema.Boolean,
  input: Schema.Literal(
    "text",
    "confirm",
    "single-select",
    "multi-select",
  ),
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        description: Schema.optional(Schema.String),
      }),
    ),
  ),
})
export type AgentElicitationField = Schema.Schema.Type<
  typeof AgentElicitationField
>

export const AgentElicitationAction = Schema.Struct({
  type: Schema.Literal("elicitation"),
  ...PendingActionBase,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literal("text", "confirm", "select", "multi-select", "form"),
  fields: Schema.Array(AgentElicitationField),
})
export type AgentElicitationAction = Schema.Schema.Type<
  typeof AgentElicitationAction
>

export const AgentAuthenticationAction = Schema.Struct({
  type: Schema.Literal("authentication"),
  ...PendingActionBase,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
})
export type AgentAuthenticationAction = Schema.Schema.Type<
  typeof AgentAuthenticationAction
>

export const AgentPendingAction = Schema.Union(
  AgentPermissionAction,
  AgentElicitationAction,
  AgentAuthenticationAction,
)
export type AgentPendingAction = Schema.Schema.Type<typeof AgentPendingAction>

export const AgentActionResponse = Schema.Union(
  Schema.Struct({ type: Schema.Literal("permission"), optionId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("elicitation"),
    values: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  }),
  Schema.Struct({
    type: Schema.Literal("authentication"),
    status: Schema.Literal("completed", "cancelled"),
  }),
)
export type AgentActionResponse = Schema.Schema.Type<typeof AgentActionResponse>
