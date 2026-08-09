import {
  AgentCommandEnvelope,
  AgentCommandResult,
  AgentConnectionState,
  AgentDriverDescriptor,
  AgentDriverDiscovery,
  AgentProviderDescriptor,
  AgentEventEnvelope,
  AgentThreadSnapshot,
  ProviderSessionId,
} from "@yaade/agent-protocol"
import { Effect, Schema } from "effect"

export const AgentRuntimeEvent = AgentEventEnvelope
export type AgentRuntimeEvent = Schema.Schema.Type<typeof AgentRuntimeEvent>
export const AgentRuntimeConnectionState = AgentConnectionState
export type AgentRuntimeConnectionState = Schema.Schema.Type<
  typeof AgentRuntimeConnectionState
>

export const AgentRuntimeThreadSnapshot = AgentThreadSnapshot
export type AgentRuntimeThreadSnapshot = Schema.Schema.Type<
  typeof AgentRuntimeThreadSnapshot
>

export const AgentRuntimeCreateRequest = Schema.Struct({
  threadId: Schema.optional(Schema.String),
  projectSessionId: Schema.String,
  providerId: Schema.optional(Schema.String),
  driverId: Schema.optional(Schema.String),
  cwdUri: Schema.String,
  mode: Schema.optional(
    Schema.Union(
      Schema.Struct({ type: Schema.Literal("new") }),
      Schema.Struct({
        type: Schema.Literal("resume"),
        providerSessionId: ProviderSessionId,
      }),
      Schema.Struct({
        type: Schema.Literal("load"),
        providerSessionId: ProviderSessionId,
      }),
    ),
  ),
  configuration: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
})
export type AgentRuntimeCreateRequest = Schema.Schema.Type<
  typeof AgentRuntimeCreateRequest
>

export const AgentRuntimeThreadRecovery = Schema.Struct({
  snapshot: Schema.NullOr(AgentThreadSnapshot),
  events: Schema.Array(AgentEventEnvelope),
})

export const AgentRuntimeAttachmentUpload = Schema.Struct({
  threadId: Schema.String,
  name: Schema.String,
  mediaType: Schema.String,
  contentBase64: Schema.String,
})
export type AgentRuntimeAttachmentUpload = Schema.Schema.Type<
  typeof AgentRuntimeAttachmentUpload
>

export const AgentRuntimeAttachmentDescriptor = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mediaType: Schema.String,
  size: Schema.Number,
})
export type AgentRuntimeAttachmentDescriptor = Schema.Schema.Type<
  typeof AgentRuntimeAttachmentDescriptor
>
export type AgentRuntimeThreadRecovery = Schema.Schema.Type<
  typeof AgentRuntimeThreadRecovery
>

export const AgentRuntimeCommandEnvelope = AgentCommandEnvelope
export const AgentRuntimeCommandResult = AgentCommandResult
export const AgentRuntimeDriverDescriptor = AgentDriverDescriptor
export const AgentRuntimeDriverDiscovery = AgentDriverDiscovery
export const AgentRuntimeProviderDescriptor = AgentProviderDescriptor
export type AgentRuntimeCommandEnvelope = Schema.Schema.Type<
  typeof AgentCommandEnvelope
>
export type AgentRuntimeCommandResult = Schema.Schema.Type<
  typeof AgentCommandResult
>
export type AgentRuntimeDriverDescriptor = Schema.Schema.Type<
  typeof AgentDriverDescriptor
>
export type AgentRuntimeDriverDiscovery = Schema.Schema.Type<
  typeof AgentDriverDiscovery
>
export type AgentRuntimeProviderDescriptor = Schema.Schema.Type<
  typeof AgentProviderDescriptor
>

export const AgentRuntimeConnectionUpdate = Schema.Struct({
  threadId: Schema.String,
  state: AgentConnectionState,
})
export type AgentRuntimeConnectionUpdate = Schema.Schema.Type<
  typeof AgentRuntimeConnectionUpdate
>

export const AgentRuntimeRegistrySnapshot = Schema.Array(AgentProviderDescriptor)
export type AgentRuntimeRegistrySnapshot = Schema.Schema.Type<
  typeof AgentRuntimeRegistrySnapshot
>

export const decodeAgentRuntimeEvent = Schema.decodeUnknown(AgentRuntimeEvent)
export const decodeAgentRuntimeSnapshot = Schema.decodeUnknown(AgentRuntimeThreadSnapshot)
export const decodeAgentRuntimeConnectionUpdate = Schema.decodeUnknown(AgentRuntimeConnectionUpdate)
export const decodeAgentRuntimeRegistrySnapshot = Schema.decodeUnknown(AgentRuntimeRegistrySnapshot)

export function tryDecodeAgentRuntimeEvent(
  raw: unknown,
): AgentRuntimeEvent | undefined {
  try {
    return Effect.runSync(decodeAgentRuntimeEvent(raw))
  } catch {
    return undefined
  }
}

export function tryDecodeAgentRuntimeSnapshot(
  raw: unknown,
): AgentRuntimeThreadSnapshot | undefined {
  try {
    return Effect.runSync(decodeAgentRuntimeSnapshot(raw))
  } catch {
    return undefined
  }
}

export function tryDecodeAgentRuntimeConnectionUpdate(
  raw: unknown,
): AgentRuntimeConnectionUpdate | undefined {
  try {
    return Effect.runSync(decodeAgentRuntimeConnectionUpdate(raw))
  } catch {
    return undefined
  }
}

export function tryDecodeAgentRuntimeRegistrySnapshot(
  raw: unknown,
): AgentRuntimeRegistrySnapshot | undefined {
  try {
    return Effect.runSync(decodeAgentRuntimeRegistrySnapshot(raw))
  } catch {
    return undefined
  }
}
