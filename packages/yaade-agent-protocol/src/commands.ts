import { Schema } from "effect"
import { AgentActionResponse } from "./actions.js"
import { AgentThreadId, AgentTurnId, PendingActionId } from "./ids.js"

export const AgentInputPart = Schema.Union(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("attachment"),
    attachmentId: Schema.String,
    purpose: Schema.Literal("image", "context", "workspace-file"),
  }),
  Schema.Struct({
    type: Schema.Literal("workspace-resource"),
    uri: Schema.String,
  }),
)
export type AgentInputPart = Schema.Schema.Type<typeof AgentInputPart>

export const AgentCommand = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("turn.submit"),
    input: Schema.Array(AgentInputPart),
  }),
  Schema.Struct({
    type: Schema.Literal("turn.interrupt"),
    turnId: AgentTurnId,
  }),
  Schema.Struct({
    type: Schema.Literal("action.respond"),
    actionId: PendingActionId,
    response: AgentActionResponse,
  }),
  Schema.Struct({
    type: Schema.Literal("configuration.set"),
    optionId: Schema.String,
    value: Schema.Unknown,
  }),
  Schema.Struct({ type: Schema.Literal("thread.close") }),
)
export type AgentCommand = Schema.Schema.Type<typeof AgentCommand>

export class AgentCommandEnvelope extends Schema.Class<AgentCommandEnvelope>(
  "AgentCommandEnvelope",
)({
  protocolVersion: Schema.Literal(1),
  commandId: Schema.String,
  threadId: AgentThreadId,
  issuedAt: Schema.String,
  expectedRevision: Schema.optional(Schema.Number),
  command: AgentCommand,
}) {}

export const AgentError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
  details: Schema.optional(Schema.Unknown),
})
export type AgentError = Schema.Schema.Type<typeof AgentError>

export const AgentCommandResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("accepted"),
    commandId: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("already-applied"),
    commandId: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("rejected"),
    commandId: Schema.String,
    error: AgentError,
  }),
)
export type AgentCommandResult = Schema.Schema.Type<typeof AgentCommandResult>
