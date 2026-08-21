import { Effect, Schema } from "effect";
import { AppSession, ProjectTarget, SessionTab, ToolUse } from "./tool-session.js";

/** Host RPC request envelope (POST /api/v1/rpc). */
export const HostRpcRequest = Schema.Struct({
  channel: Schema.String,
  args: Schema.optionalWith(Schema.Array(Schema.Unknown), {
    default: () => [] as unknown[],
  }),
  /** Correlation key only; host auth creates the request principal. */
  clientId: Schema.optionalWith(Schema.String, { default: () => "browser" }),
});
export type HostRpcRequest = Schema.Schema.Type<typeof HostRpcRequest>;

export const HostRpcSuccess = Schema.Struct({
  value: Schema.Unknown,
});
export type HostRpcSuccess = Schema.Schema.Type<typeof HostRpcSuccess>;

export const HostRpcFailure = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    details: Schema.optionalWith(
      Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      {
        default: () => ({}),
      },
    ),
  }),
});
export type HostRpcFailure = Schema.Schema.Type<typeof HostRpcFailure>;

export const HostRpcResponse = Schema.Union(HostRpcFailure, HostRpcSuccess);
export type HostRpcResponse = Schema.Schema.Type<typeof HostRpcResponse>;

/**
 * The identity of one installed YAADE host. `serverId` survives API and
 * daemon restarts; `serverEpoch` changes every API runtime start.
 */
export const ServerIdentity = Schema.Struct({
  serverId: Schema.String,
  serverEpoch: Schema.String,
  protocolVersion: Schema.Literal(2),
  runtimeVersion: Schema.String,
  startedAt: Schema.String,
});
export type ServerIdentity = Schema.Schema.Type<typeof ServerIdentity>;

export const EventCursor = Schema.Struct({
  serverEpoch: Schema.String,
  sequence: Schema.Number,
});
export type EventCursor = Schema.Schema.Type<typeof EventCursor>;

export const ServerCapabilities = Schema.Struct({
  serverId: Schema.String,
  serverEpoch: Schema.String,
  protocolVersions: Schema.Array(Schema.Number),
  preferredProtocolVersion: Schema.Number,
  runtimeVersion: Schema.String,
  platform: Schema.Literal("linux", "darwin", "windows"),
  features: Schema.Struct({
    runtimeSnapshot: Schema.Boolean,
    terminalCheckpoints: Schema.Boolean,
    writerLeases: Schema.Boolean,
    nativeAgentResume: Schema.Boolean,
    deviceAuthentication: Schema.Boolean,
    persistedTerminalHistory: Schema.Boolean,
  }),
  limits: Schema.Struct({
    maxTerminals: Schema.Number,
    maxReplayBytes: Schema.Number,
    maxWsPayloadBytes: Schema.Number,
  }),
});
export type ServerCapabilities = Schema.Schema.Type<typeof ServerCapabilities>;

export const RuntimeHealth = Schema.Struct({
  status: Schema.Literal("healthy", "degraded", "unhealthy"),
  database: Schema.Struct({ status: Schema.Literal("healthy", "degraded", "unhealthy"), message: Schema.String }),
  supervisor: Schema.Struct({ status: Schema.Literal("healthy", "degraded", "unhealthy"), message: Schema.String }),
  eventLoop: Schema.Struct({ status: Schema.Literal("healthy", "degraded", "unhealthy"), message: Schema.String }),
  storage: Schema.Struct({ status: Schema.Literal("healthy", "degraded", "unhealthy"), message: Schema.String }),
  connectedClients: Schema.Number,
  runningTerminals: Schema.Number,
});
export type RuntimeHealth = Schema.Schema.Type<typeof RuntimeHealth>;

/** Realtime EventHub / WS /ws payload. Version 1 remains decodable during the migration. */
export const HostEventV1 = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  sequence: Schema.Number,
  channel: Schema.String,
  args: Schema.Array(Schema.Unknown),
});
export type HostEventV1 = Schema.Schema.Type<typeof HostEventV1>;

export const HostEventV2 = Schema.Struct({
  protocolVersion: Schema.Literal(2),
  serverId: Schema.String,
  serverEpoch: Schema.String,
  sequence: Schema.Number,
  channel: Schema.String,
  args: Schema.Array(Schema.Unknown),
});
export type HostEventV2 = Schema.Schema.Type<typeof HostEventV2>;

export const HostEvent = Schema.Union(HostEventV1, HostEventV2);
export type HostEvent = Schema.Schema.Type<typeof HostEvent>;

/** Frames sent before a modern realtime connection is synchronized. */
export const ProtocolHello = Schema.Struct({
  type: Schema.Literal("protocol:hello"),
  identity: ServerIdentity,
  capabilities: ServerCapabilities,
});
export type ProtocolHello = Schema.Schema.Type<typeof ProtocolHello>;

export const ProtocolAuthRequired = Schema.Struct({
  type: Schema.Literal("protocol:auth-required"),
});
export const ProtocolAuth = Schema.Struct({
  type: Schema.Literal("protocol:auth"),
  token: Schema.String,
});

export const RuntimeSnapshot = Schema.Struct({
  type: Schema.Literal("runtime:snapshot"),
  schemaVersion: Schema.Literal(1),
  identity: ServerIdentity,
  cursor: EventCursor,
  generatedAt: Schema.String,
  projects: Schema.Array(ProjectTarget),
  sessions: Schema.Array(
    Schema.Struct({
      session: AppSession,
      tabs: Schema.Array(SessionTab),
      toolUses: Schema.Array(ToolUse),
    }),
  ),
  terminalInstances: Schema.Array(Schema.Unknown),
  agents: Schema.Array(Schema.Unknown),
  notifications: Schema.Unknown,
  leases: Schema.Array(Schema.Unknown),
});
export type RuntimeSnapshot = Schema.Schema.Type<typeof RuntimeSnapshot>;

export const HostEventChannels = [
  "terminal:data",
  "terminal:exit",
  "terminal-instances:event",
  "notifications:event",
  "agents:event",
  "tools:event",
  "fs:changed",
  "server:shuttingDown",
  "connection:status",
  "protocol:error",
  "protocol:replay-gap",
] as const;
export type HostEventChannel = (typeof HostEventChannels)[number];

/** Common channel arg codecs (loose where host historically accepted unknown). */
export const FsReadFileArgs = Schema.Tuple(Schema.String);
export const FsWriteFileArgs = Schema.Tuple(Schema.String, Schema.String);
export const TextFileReadResult = Schema.Struct({
  content: Schema.String,
  version: Schema.String,
  size: Schema.Number,
});
export type TextFileReadResult = Schema.Schema.Type<typeof TextFileReadResult>;

export const TextFileWriteOptions = Schema.Union(
  Schema.Struct({ expectedVersion: Schema.String }),
  Schema.Struct({ create: Schema.Literal(true) }),
);
export type TextFileWriteOptions = Schema.Schema.Type<
  typeof TextFileWriteOptions
>;

export const TextFileWriteResult = Schema.Struct({
  version: Schema.String,
  size: Schema.Number,
});
export type TextFileWriteResult = Schema.Schema.Type<
  typeof TextFileWriteResult
>;

export const FsReadTextFileArgs = Schema.Tuple(Schema.String);
export const FsWriteTextFileArgs = Schema.Tuple(
  Schema.String,
  Schema.String,
  TextFileWriteOptions,
);
export const FsReadDirArgs = Schema.Tuple(Schema.String);
export const FsStatArgs = Schema.Tuple(Schema.String);

export const TrashEntry = Schema.Struct({
  id: Schema.String,
  originalUri: Schema.String,
  name: Schema.String,
  isDirectory: Schema.Boolean,
  size: Schema.Number,
  trashedAt: Schema.Number,
});
export type TrashEntry = Schema.Schema.Type<typeof TrashEntry>;

export const FsMutationStat = Schema.Struct({
  uri: Schema.String,
  isDirectory: Schema.Boolean,
  size: Schema.Number,
});
export type FsMutationStat = Schema.Schema.Type<typeof FsMutationStat>;

export const RestoreTrashResult = Schema.Struct({
  entry: TrashEntry,
  uri: Schema.String,
});
export type RestoreTrashResult = Schema.Schema.Type<typeof RestoreTrashResult>;

export const EmptyTrashResult = Schema.Struct({
  removed: Schema.Number,
  bytes: Schema.Number,
});
export type EmptyTrashResult = Schema.Schema.Type<typeof EmptyTrashResult>;

export const FsCreateFileArgs = Schema.Tuple(Schema.String);
export const FsMkdirArgs = Schema.Tuple(Schema.String);
export const FsRenameArgs = Schema.Tuple(Schema.String, Schema.String);
export const FsTrashArgs = Schema.Tuple(Schema.String);
export const FsRestoreTrashArgs = Schema.Union(
  Schema.Tuple(Schema.String),
  Schema.Tuple(Schema.String, Schema.String),
);
export const FsListTrashArgs = Schema.Tuple();
export const FsEmptyTrashArgs = Schema.Tuple();

export const GitPathArgs = Schema.Tuple(Schema.String);
export const TerminalCreateArgs = Schema.Array(Schema.Unknown);
export const TerminalIdArgs = Schema.Tuple(Schema.String);

/** Optional fence carried by current terminal mutation clients. */
export const TerminalMutationFence = Schema.Struct({
  terminalId: Schema.String,
  terminalEpoch: Schema.String,
  leaseId: Schema.String,
  leaseGeneration: Schema.Number,
  principalId: Schema.String,
  connectionId: Schema.String,
  commandId: Schema.String,
});
export type TerminalMutationFence = Schema.Schema.Type<typeof TerminalMutationFence>;

export const TerminalWriteArgs = Schema.Tuple(
  Schema.String,
  Schema.String,
  Schema.optionalElement(TerminalMutationFence),
);
export const TerminalResizeArgs = Schema.Tuple(
  Schema.String,
  Schema.Number,
  Schema.Number,
  Schema.optionalElement(TerminalMutationFence),
);

export const TerminalCheckpoint = Schema.Struct({
  checkpointVersion: Schema.Literal(1),
  terminalEpoch: Schema.String,
  sequence: Schema.Number,
  cols: Schema.Number,
  rows: Schema.Number,
  createdAt: Schema.String,
  syntheticAnsi: Schema.String,
});
export type TerminalCheckpoint = Schema.Schema.Type<typeof TerminalCheckpoint>;

export const TerminalLease = Schema.Struct({
  terminalId: Schema.String,
  terminalEpoch: Schema.String,
  leaseId: Schema.String,
  clientId: Schema.String,
  mode: Schema.Literal("writer", "observer"),
  acquiredAt: Schema.String,
  expiresAt: Schema.String,
  revision: Schema.Number,
  leaseGeneration: Schema.optional(Schema.Number),
  principalId: Schema.optional(Schema.String),
  connectionId: Schema.optional(Schema.String),
});
export type TerminalLease = Schema.Schema.Type<typeof TerminalLease>;

export const decodeHostRpcRequest = Schema.decodeUnknown(HostRpcRequest);
export const encodeHostRpcSuccess = Schema.encode(HostRpcSuccess);
export const encodeHostEvent = Schema.encode(HostEvent);
export const decodeHostEvent = Schema.decodeUnknown(HostEvent);

/** Hot PTY channels — structural gate only (no Schema) for terminal throughput. */
export const HOST_EVENT_HOT_CHANNELS = [
  "terminal:data",
  "terminal:exit",
] as const;

export function isHotPathHostEvent(raw: unknown): raw is HostEvent {
  if (raw === null || typeof raw !== "object") return false;
  const message = raw as Record<string, unknown>;
  return (
    (message.protocolVersion === 1 || message.protocolVersion === 2) &&
    typeof message.sequence === "number" &&
    Number.isFinite(message.sequence) &&
    (message.channel === "terminal:data" ||
      message.channel === "terminal:exit") &&
    Array.isArray(message.args)
  );
}

/**
 * Decode a WS EventHub frame. Hot terminal channels skip Schema; everything else
 * uses `decodeHostEvent`.
 */
export function decodeRealtimeHostEvent(
  raw: unknown,
): ReturnType<typeof decodeHostEvent> {
  if (isHotPathHostEvent(raw)) {
    return Effect.succeed(raw);
  }
  return decodeHostEvent(raw);
}

/** Sync helper for the browser message handler (avoid per-chunk Promise microtasks). */
export function tryDecodeRealtimeHostEvent(
  raw: unknown,
): HostEvent | undefined {
  if (isHotPathHostEvent(raw)) return raw;
  try {
    return Effect.runSync(decodeHostEvent(raw));
  } catch {
    return undefined;
  }
}
