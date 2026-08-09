import { Schema } from "effect"

export const ProviderId = Schema.String.pipe(Schema.brand("ProviderId"))
export type ProviderId = Schema.Schema.Type<typeof ProviderId>

export const DriverId = Schema.String.pipe(Schema.brand("DriverId"))
export type DriverId = Schema.Schema.Type<typeof DriverId>

export const ProjectSessionId = Schema.String.pipe(
  Schema.brand("ProjectSessionId"),
)
export type ProjectSessionId = Schema.Schema.Type<typeof ProjectSessionId>

export const AgentThreadId = Schema.String.pipe(Schema.brand("AgentThreadId"))
export type AgentThreadId = Schema.Schema.Type<typeof AgentThreadId>

export const AgentTurnId = Schema.String.pipe(Schema.brand("AgentTurnId"))
export type AgentTurnId = Schema.Schema.Type<typeof AgentTurnId>

export const TimelineItemId = Schema.String.pipe(Schema.brand("TimelineItemId"))
export type TimelineItemId = Schema.Schema.Type<typeof TimelineItemId>

export const PendingActionId = Schema.String.pipe(
  Schema.brand("PendingActionId"),
)
export type PendingActionId = Schema.Schema.Type<typeof PendingActionId>

export const ProviderSessionId = Schema.String.pipe(
  Schema.brand("ProviderSessionId"),
)
export type ProviderSessionId = Schema.Schema.Type<typeof ProviderSessionId>

export const AgentConnectionId = Schema.String.pipe(
  Schema.brand("AgentConnectionId"),
)
export type AgentConnectionId = Schema.Schema.Type<typeof AgentConnectionId>
