import { Schema } from "effect"
import { AgentPendingAction, AgentActionResponse } from "./actions.js"
import { AgentCapabilities } from "./capabilities.js"
import { AgentConfigurationOption } from "./configuration.js"
import { AgentTimelineItem } from "./content.js"
import {
  AgentThreadId,
  AgentTurnId,
  DriverId,
  ProjectSessionId,
  ProviderId,
  ProviderSessionId,
  TimelineItemId,
} from "./ids.js"

export const AgentUsage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  cachedInputTokens: Schema.optional(Schema.Number),
  contextWindowTokens: Schema.optional(Schema.Number),
  costUsd: Schema.optional(Schema.Number),
})
export type AgentUsage = Schema.Schema.Type<typeof AgentUsage>

export const ThreadOpenedEvent = Schema.Struct({
  type: Schema.Literal("thread.opened"),
  projectSessionId: ProjectSessionId,
  providerId: ProviderId,
  driverId: DriverId,
  providerSessionId: Schema.optional(ProviderSessionId),
  cwdUri: Schema.String,
  capabilities: AgentCapabilities,
  configuration: Schema.Array(AgentConfigurationOption),
})
export type ThreadOpenedEvent = Schema.Schema.Type<typeof ThreadOpenedEvent>

export const ThreadBindingUpdatedEvent = Schema.Struct({
  type: Schema.Literal("thread.binding-updated"),
  providerSessionId: ProviderSessionId,
})
export type ThreadBindingUpdatedEvent = Schema.Schema.Type<
  typeof ThreadBindingUpdatedEvent
>

export const CapabilitiesUpdatedEvent = Schema.Struct({
  type: Schema.Literal("capabilities.updated"),
  capabilities: AgentCapabilities,
})
export type CapabilitiesUpdatedEvent = Schema.Schema.Type<
  typeof CapabilitiesUpdatedEvent
>

export const ConfigurationUpdatedEvent = Schema.Struct({
  type: Schema.Literal("configuration.updated"),
  configuration: Schema.Array(AgentConfigurationOption),
})
export type ConfigurationUpdatedEvent = Schema.Schema.Type<
  typeof ConfigurationUpdatedEvent
>

export const TurnStartedEvent = Schema.Struct({
  type: Schema.Literal("turn.started"),
  turnId: AgentTurnId,
})
export type TurnStartedEvent = Schema.Schema.Type<typeof TurnStartedEvent>

export const TimelineItemStartedEvent = Schema.Struct({
  type: Schema.Literal("item.started"),
  item: AgentTimelineItem,
})
export type TimelineItemStartedEvent = Schema.Schema.Type<
  typeof TimelineItemStartedEvent
>

export const TimelineItemDeltaEvent = Schema.Struct({
  type: Schema.Literal("item.delta"),
  itemId: TimelineItemId,
  revision: Schema.Number,
  text: Schema.String,
})
export type TimelineItemDeltaEvent = Schema.Schema.Type<
  typeof TimelineItemDeltaEvent
>

export const TimelineItemUpdatedEvent = Schema.Struct({
  type: Schema.Literal("item.updated"),
  item: AgentTimelineItem,
})
export type TimelineItemUpdatedEvent = Schema.Schema.Type<
  typeof TimelineItemUpdatedEvent
>

export const TimelineItemCompletedEvent = Schema.Struct({
  type: Schema.Literal("item.completed"),
  item: AgentTimelineItem,
})
export type TimelineItemCompletedEvent = Schema.Schema.Type<
  typeof TimelineItemCompletedEvent
>

export const ActionRequestedEvent = Schema.Struct({
  type: Schema.Literal("action.requested"),
  action: AgentPendingAction,
})
export type ActionRequestedEvent = Schema.Schema.Type<
  typeof ActionRequestedEvent
>

export const ActionResolvedEvent = Schema.Struct({
  type: Schema.Literal("action.resolved"),
  actionId: Schema.String,
  response: AgentActionResponse,
})
export type ActionResolvedEvent = Schema.Schema.Type<typeof ActionResolvedEvent>

export const UsageUpdatedEvent = Schema.Struct({
  type: Schema.Literal("usage.updated"),
  usage: AgentUsage,
})
export type UsageUpdatedEvent = Schema.Schema.Type<typeof UsageUpdatedEvent>

export const ThreadStatus = Schema.Literal(
  "creating",
  "idle",
  "running",
  "waiting-for-action",
  "interrupted",
  "failed",
  "closed",
)
export type ThreadStatus = Schema.Schema.Type<typeof ThreadStatus>

export const ThreadStatusChangedEvent = Schema.Struct({
  type: Schema.Literal("thread.status-changed"),
  status: ThreadStatus,
})
export type ThreadStatusChangedEvent = Schema.Schema.Type<
  typeof ThreadStatusChangedEvent
>

const TurnTerminalFields = { turnId: AgentTurnId }

export const TurnCompletedEvent = Schema.Struct({
  type: Schema.Literal("turn.completed"),
  ...TurnTerminalFields,
})
export type TurnCompletedEvent = Schema.Schema.Type<typeof TurnCompletedEvent>

export const TurnFailedEvent = Schema.Struct({
  type: Schema.Literal("turn.failed"),
  ...TurnTerminalFields,
  message: Schema.String,
  code: Schema.optional(Schema.String),
})
export type TurnFailedEvent = Schema.Schema.Type<typeof TurnFailedEvent>

export const TurnInterruptedEvent = Schema.Struct({
  type: Schema.Literal("turn.interrupted"),
  ...TurnTerminalFields,
})
export type TurnInterruptedEvent = Schema.Schema.Type<
  typeof TurnInterruptedEvent
>

export const AgentErrorEvent = Schema.Struct({
  type: Schema.Literal("agent.error"),
  message: Schema.String,
  code: Schema.optional(Schema.String),
  retryable: Schema.Boolean,
})
export type AgentErrorEvent = Schema.Schema.Type<typeof AgentErrorEvent>

export const ThreadClosedEvent = Schema.Struct({
  type: Schema.Literal("thread.closed"),
  reason: Schema.Literal("user", "runtime-shutdown", "provider"),
})
export type ThreadClosedEvent = Schema.Schema.Type<typeof ThreadClosedEvent>

export const ExtensionEvent = Schema.Struct({
  type: Schema.Literal("extension"),
  namespace: Schema.String,
  name: Schema.String,
  payload: Schema.Unknown,
})
export type ExtensionEvent = Schema.Schema.Type<typeof ExtensionEvent>

export const AgentEvent = Schema.Union(
  ThreadOpenedEvent,
  ThreadBindingUpdatedEvent,
  CapabilitiesUpdatedEvent,
  ConfigurationUpdatedEvent,
  TurnStartedEvent,
  TimelineItemStartedEvent,
  TimelineItemDeltaEvent,
  TimelineItemUpdatedEvent,
  TimelineItemCompletedEvent,
  ActionRequestedEvent,
  ActionResolvedEvent,
  UsageUpdatedEvent,
  ThreadStatusChangedEvent,
  TurnCompletedEvent,
  TurnFailedEvent,
  TurnInterruptedEvent,
  AgentErrorEvent,
  ThreadClosedEvent,
  ExtensionEvent,
)
export type AgentEvent = Schema.Schema.Type<typeof AgentEvent>

export class AgentEventEnvelope extends Schema.Class<AgentEventEnvelope>(
  "AgentEventEnvelope",
)({
  protocolVersion: Schema.Literal(1),
  eventId: Schema.String,
  threadId: AgentThreadId,
  sequence: Schema.Number,
  occurredAt: Schema.String,
  receivedAt: Schema.String,
  commandId: Schema.optional(Schema.String),
  connectionGeneration: Schema.Number,
  providerCursor: Schema.optional(Schema.String),
  event: AgentEvent,
}) {}

export class UnsequencedAgentEvent extends Schema.Class<UnsequencedAgentEvent>(
  "UnsequencedAgentEvent",
)({
  occurredAt: Schema.optional(Schema.String),
  nativeEventId: Schema.optional(Schema.String),
  providerCursor: Schema.optional(Schema.String),
  event: AgentEvent,
}) {}
