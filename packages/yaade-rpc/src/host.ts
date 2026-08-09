import { Effect, Schema } from "effect"

/** Host RPC request envelope (POST /api/v1/rpc). */
export const HostRpcRequest = Schema.Struct({
  channel: Schema.String,
  args: Schema.optionalWith(Schema.Array(Schema.Unknown), { default: () => [] as unknown[] }),
  clientId: Schema.optionalWith(Schema.String, { default: () => "browser" }),
})
export type HostRpcRequest = Schema.Schema.Type<typeof HostRpcRequest>

export const HostRpcSuccess = Schema.Struct({
  value: Schema.Unknown,
})
export type HostRpcSuccess = Schema.Schema.Type<typeof HostRpcSuccess>

export const HostRpcFailure = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    details: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.Unknown }), {
      default: () => ({}),
    }),
  }),
})
export type HostRpcFailure = Schema.Schema.Type<typeof HostRpcFailure>

export const HostRpcResponse = Schema.Union(HostRpcSuccess, HostRpcFailure)
export type HostRpcResponse = Schema.Schema.Type<typeof HostRpcResponse>

/** Realtime EventHub / WS /ws payload. */
export const HostEvent = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  sequence: Schema.Number,
  channel: Schema.String,
  args: Schema.Array(Schema.Unknown),
})
export type HostEvent = Schema.Schema.Type<typeof HostEvent>

export const HostEventChannels = [
  "terminal:data",
  "terminal:exit",
  "notifications:event",
  "agents:event",
  "agentRuntime:event",
  "agentRuntime:snapshot",
  "agentRuntime:connection",
  "agentRuntime:registryChanged",
  "workspace:gitBranch",
  "workspace:searchReady",
  "workspace:fileIndex",
  "fs:changed",
  "lsp:crashed",
  "lsp:lifecycle",
  "server:shuttingDown",
  "connection:status",
  "protocol:error",
  "protocol:replay-gap",
] as const
export type HostEventChannel = (typeof HostEventChannels)[number]

/** Common channel arg codecs (loose where host historically accepted unknown). */
export const FsReadFileArgs = Schema.Tuple(Schema.String)
export const FsWriteFileArgs = Schema.Tuple(Schema.String, Schema.String)
export const TextFileReadResult = Schema.Struct({
  content: Schema.String,
  version: Schema.String,
  size: Schema.Number,
})
export type TextFileReadResult = Schema.Schema.Type<typeof TextFileReadResult>

export const TextFileWriteOptions = Schema.Union(
  Schema.Struct({ expectedVersion: Schema.String }),
  Schema.Struct({ create: Schema.Literal(true) }),
)
export type TextFileWriteOptions = Schema.Schema.Type<typeof TextFileWriteOptions>

export const TextFileWriteResult = Schema.Struct({
  version: Schema.String,
  size: Schema.Number,
})
export type TextFileWriteResult = Schema.Schema.Type<typeof TextFileWriteResult>

export const FsReadTextFileArgs = Schema.Tuple(Schema.String)
export const FsWriteTextFileArgs = Schema.Tuple(
  Schema.String,
  Schema.String,
  TextFileWriteOptions,
)
export const FsReadDirArgs = Schema.Tuple(Schema.String)
export const FsStatArgs = Schema.Tuple(Schema.String)

export const TrashEntry = Schema.Struct({
  id: Schema.String,
  originalUri: Schema.String,
  name: Schema.String,
  isDirectory: Schema.Boolean,
  size: Schema.Number,
  trashedAt: Schema.Number,
})
export type TrashEntry = Schema.Schema.Type<typeof TrashEntry>

export const FsMutationStat = Schema.Struct({
  uri: Schema.String,
  isDirectory: Schema.Boolean,
  size: Schema.Number,
})
export type FsMutationStat = Schema.Schema.Type<typeof FsMutationStat>

export const RestoreTrashResult = Schema.Struct({
  entry: TrashEntry,
  uri: Schema.String,
})
export type RestoreTrashResult = Schema.Schema.Type<typeof RestoreTrashResult>

export const EmptyTrashResult = Schema.Struct({
  removed: Schema.Number,
  bytes: Schema.Number,
})
export type EmptyTrashResult = Schema.Schema.Type<typeof EmptyTrashResult>

export const FsCreateFileArgs = Schema.Tuple(Schema.String)
export const FsMkdirArgs = Schema.Tuple(Schema.String)
export const FsRenameArgs = Schema.Tuple(Schema.String, Schema.String)
export const FsTrashArgs = Schema.Tuple(Schema.String)
export const FsRestoreTrashArgs = Schema.Union(
  Schema.Tuple(Schema.String),
  Schema.Tuple(Schema.String, Schema.String),
)
export const FsListTrashArgs = Schema.Tuple()
export const FsEmptyTrashArgs = Schema.Tuple()

export const GitPathArgs = Schema.Tuple(Schema.String)
export const TerminalCreateArgs = Schema.Array(Schema.Unknown)
export const TerminalIdArgs = Schema.Tuple(Schema.String)
export const TerminalWriteArgs = Schema.Tuple(Schema.String, Schema.String)
export const TerminalResizeArgs = Schema.Tuple(Schema.String, Schema.Number, Schema.Number)

export const decodeHostRpcRequest = Schema.decodeUnknown(HostRpcRequest)
export const encodeHostRpcSuccess = Schema.encode(HostRpcSuccess)
export const encodeHostEvent = Schema.encode(HostEvent)
export const decodeHostEvent = Schema.decodeUnknown(HostEvent)

/** Hot PTY channels — structural gate only (no Schema) for terminal throughput. */
export const HOST_EVENT_HOT_CHANNELS = ["terminal:data", "terminal:exit"] as const

export function isHotPathHostEvent(raw: unknown): raw is HostEvent {
  if (raw === null || typeof raw !== "object") return false
  const message = raw as Record<string, unknown>
  return (
    message.protocolVersion === 1 &&
    typeof message.sequence === "number" &&
    Number.isFinite(message.sequence) &&
    (message.channel === "terminal:data" || message.channel === "terminal:exit") &&
    Array.isArray(message.args)
  )
}

/**
 * Decode a WS EventHub frame. Hot terminal channels skip Schema; everything else
 * uses `decodeHostEvent`.
 */
export function decodeRealtimeHostEvent(raw: unknown): ReturnType<typeof decodeHostEvent> {
  if (isHotPathHostEvent(raw)) {
    return Effect.succeed(raw)
  }
  return decodeHostEvent(raw)
}

/** Sync helper for the browser message handler (avoid per-chunk Promise microtasks). */
export function tryDecodeRealtimeHostEvent(raw: unknown): HostEvent | undefined {
  if (isHotPathHostEvent(raw)) return raw
  try {
    return Effect.runSync(decodeHostEvent(raw))
  } catch {
    return undefined
  }
}
