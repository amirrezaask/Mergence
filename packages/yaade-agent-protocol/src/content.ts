import { Schema } from "effect"
import { AgentThreadId, AgentTurnId, TimelineItemId } from "./ids.js"

export const AgentContentPart = Schema.Union(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("code"),
    text: Schema.String,
    language: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("workspace-resource"),
    uri: Schema.String,
    label: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("terminal-artifact"),
    terminalId: Schema.String,
    label: Schema.optional(Schema.String),
  }),
)
export type AgentContentPart = Schema.Schema.Type<typeof AgentContentPart>

const TimelineBase = {
  id: TimelineItemId,
  turnId: AgentTurnId,
  revision: Schema.Number,
}

export const UserMessageItem = Schema.Struct({
  type: Schema.Literal("user-message"),
  ...TimelineBase,
  content: Schema.Array(AgentContentPart),
})
export type UserMessageItem = Schema.Schema.Type<typeof UserMessageItem>

export const AssistantMessageItem = Schema.Struct({
  type: Schema.Literal("assistant-message"),
  ...TimelineBase,
  text: Schema.String,
  status: Schema.Literal("streaming", "completed", "cancelled"),
})
export type AssistantMessageItem = Schema.Schema.Type<
  typeof AssistantMessageItem
>

export const ReasoningItem = Schema.Struct({
  type: Schema.Literal("reasoning"),
  ...TimelineBase,
  text: Schema.String,
  status: Schema.Literal("streaming", "completed", "cancelled"),
})
export type ReasoningItem = Schema.Schema.Type<typeof ReasoningItem>

export const KnownToolCategory = Schema.Literal(
  "shell",
  "file.read",
  "file.write",
  "search",
  "git",
  "web",
  "mcp",
  "agent",
  "other",
)
export type KnownToolCategory = Schema.Schema.Type<typeof KnownToolCategory>

export const AgentToolCallItem = Schema.Struct({
  type: Schema.Literal("tool-call"),
  ...TimelineBase,
  nativeName: Schema.optional(Schema.String),
  category: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  status: Schema.Literal(
    "pending",
    "waiting-for-permission",
    "running",
    "completed",
    "failed",
    "cancelled",
  ),
  input: Schema.optional(Schema.Array(AgentContentPart)),
  output: Schema.optional(Schema.Array(AgentContentPart)),
  locations: Schema.optional(
    Schema.Array(
      Schema.Struct({
        uri: Schema.String,
        line: Schema.optional(Schema.Number),
        column: Schema.optional(Schema.Number),
      }),
    ),
  ),
  parentItemId: Schema.optional(TimelineItemId),
  subagentThreadId: Schema.optional(AgentThreadId),
  progress: Schema.optional(
    Schema.Struct({
      current: Schema.optional(Schema.Number),
      total: Schema.optional(Schema.Number),
      message: Schema.optional(Schema.String),
    }),
  ),
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
})
export type AgentToolCallItem = Schema.Schema.Type<typeof AgentToolCallItem>

export const PlanItem = Schema.Struct({
  type: Schema.Literal("plan"),
  ...TimelineBase,
  title: Schema.optional(Schema.String),
  entries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      text: Schema.String,
      status: Schema.Literal("pending", "in-progress", "completed", "cancelled"),
    }),
  ),
  status: Schema.Literal("active", "completed", "cancelled"),
})
export type PlanItem = Schema.Schema.Type<typeof PlanItem>

export const DiffItem = Schema.Struct({
  type: Schema.Literal("diff"),
  ...TimelineBase,
  uri: Schema.String,
  patch: Schema.String,
  status: Schema.Literal("proposed", "applied", "rejected"),
})
export type DiffItem = Schema.Schema.Type<typeof DiffItem>

export const SubagentItem = Schema.Struct({
  type: Schema.Literal("subagent"),
  ...TimelineBase,
  title: Schema.String,
  status: Schema.Literal("running", "completed", "failed", "cancelled"),
  threadId: Schema.optional(AgentThreadId),
})
export type SubagentItem = Schema.Schema.Type<typeof SubagentItem>

export const ArtifactItem = Schema.Struct({
  type: Schema.Literal("artifact"),
  ...TimelineBase,
  title: Schema.String,
  mediaType: Schema.String,
  uri: Schema.String,
})
export type ArtifactItem = Schema.Schema.Type<typeof ArtifactItem>

export const ErrorItem = Schema.Struct({
  type: Schema.Literal("error"),
  ...TimelineBase,
  message: Schema.String,
  code: Schema.optional(Schema.String),
  retryable: Schema.Boolean,
})
export type ErrorItem = Schema.Schema.Type<typeof ErrorItem>

export const ExtensionItem = Schema.Struct({
  type: Schema.Literal("extension"),
  ...TimelineBase,
  namespace: Schema.String,
  name: Schema.String,
  payload: Schema.Unknown,
})
export type ExtensionItem = Schema.Schema.Type<typeof ExtensionItem>

export const AgentTimelineItem = Schema.Union(
  UserMessageItem,
  AssistantMessageItem,
  ReasoningItem,
  AgentToolCallItem,
  PlanItem,
  DiffItem,
  SubagentItem,
  ArtifactItem,
  ErrorItem,
  ExtensionItem,
)
export type AgentTimelineItem = Schema.Schema.Type<typeof AgentTimelineItem>
