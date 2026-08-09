import { Schema } from "effect"
import { AgentPendingAction } from "./actions.js"
import { AgentCapabilities } from "./capabilities.js"
import { AgentConfigurationOption } from "./configuration.js"
import { AgentTimelineItem } from "./content.js"
import { AgentUsage, ThreadStatus } from "./events.js"
import {
  AgentConnectionId,
  AgentThreadId,
  AgentTurnId,
  DriverId,
  ProjectSessionId,
  ProviderId,
  ProviderSessionId,
  TimelineItemId,
} from "./ids.js"

export const AgentTurn = Schema.Struct({
  id: AgentTurnId,
  status: Schema.Literal("running", "completed", "failed", "interrupted"),
  itemIds: Schema.Array(TimelineItemId),
  startedAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Struct({
      message: Schema.String,
      code: Schema.optional(Schema.String),
    }),
  ),
})
export type AgentTurn = Schema.Schema.Type<typeof AgentTurn>

export class AgentThreadState extends Schema.Class<AgentThreadState>(
  "AgentThreadState",
)({
  id: AgentThreadId,
  projectSessionId: ProjectSessionId,
  providerId: ProviderId,
  driverId: DriverId,
  providerSessionId: Schema.optional(ProviderSessionId),
  cwdUri: Schema.String,
  status: ThreadStatus,
  capabilities: AgentCapabilities,
  configuration: Schema.Array(AgentConfigurationOption),
  turns: Schema.Array(AgentTurn),
  itemsById: Schema.Record({ key: Schema.String, value: AgentTimelineItem }),
  itemOrder: Schema.Array(TimelineItemId),
  pendingActions: Schema.Array(AgentPendingAction),
  usage: Schema.optional(AgentUsage),
  lastSequence: Schema.Number,
  revision: Schema.Number,
  connectionGeneration: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

export class AgentThreadSnapshot extends Schema.Class<AgentThreadSnapshot>(
  "AgentThreadSnapshot",
)({
  protocolVersion: Schema.Literal(1),
  reducerVersion: Schema.Literal(1),
  state: AgentThreadState,
  seenEventIds: Schema.Array(Schema.String),
}) {}

export class AgentConnectionState extends Schema.Class<AgentConnectionState>(
  "AgentConnectionState",
)({
  connectionId: Schema.optional(AgentConnectionId),
  status: Schema.Literal(
    "disconnected",
    "connecting",
    "connected",
    "reconnecting",
    "degraded",
    "unavailable",
  ),
  generation: Schema.Number,
  lastConnectedAt: Schema.optional(Schema.String),
  lastDisconnectedAt: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      retryable: Schema.Boolean,
    }),
  ),
}) {}
