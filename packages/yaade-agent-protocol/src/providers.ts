import { Schema } from "effect"
import { DriverId, ProviderId } from "./ids.js"

export class AgentProviderDescriptor extends Schema.Class<AgentProviderDescriptor>(
  "AgentProviderDescriptor",
)({
  id: ProviderId,
  name: Schema.String,
  description: Schema.optional(Schema.String),
}) {}

export class AgentDriverDescriptor extends Schema.Class<AgentDriverDescriptor>(
  "AgentDriverDescriptor",
)({
  id: DriverId,
  providerId: ProviderId,
  name: Schema.String,
  integration: Schema.Literal(
    "acp",
    "app-server",
    "agent-sdk",
    "http-sdk",
    "cli-stream",
    "mock",
  ),
  integrationVersion: Schema.optional(Schema.String),
  priority: Schema.Number,
  supportsRemoteHost: Schema.Boolean,
}) {}

export class AgentDriverDiscovery extends Schema.Class<AgentDriverDiscovery>(
  "AgentDriverDiscovery",
)({
  descriptor: AgentDriverDescriptor,
  available: Schema.Boolean,
  version: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
}) {}
