import { Context, Effect, Layer, Schema } from "effect"
import {
  CheckoutResolutionFailed,
  ConflictError,
  decodeHostRpcRequest,
  decodeHostRouteArgs,
  decodeHostRouteResult,
  isHostRouteName,
  type HostRouteArgs,
  type HostRouteName,
  type HostRouteResult,
  FileChangedError,
  HostDisconnectedError,
  HostRpcRequest,
  HostRpcResponse,
  InvalidRpcPayloadError,
  InvalidToolCommand,
  InvalidToolInput,
  NotFoundError,
  OperationFailedError,
  PathOutsideRootsError,
  PayloadTooLargeError,
  ProjectTargetUnavailable,
  SessionNotFound,
  SessionTabConflict,
  SessionTabNotFound,
  ToolRuntimeFailure,
  ToolUseConflict,
  ToolUseNotFound,
  type HostRpcError,
} from "@yaade/rpc"
import type { YaadeHostTransport } from "./transport.js"
import { readHostAuthToken } from "./web-transport.js"

export class HostClient extends Context.Tag("yaade/HostClient")<
  HostClient,
  {
    readonly invoke: (
      channel: string,
      ...args: unknown[]
    ) => Effect.Effect<unknown, HostRpcError>
    readonly on: (
      channel: string,
      listener: (...args: unknown[]) => void,
    ) => Effect.Effect<() => void>
  }
>() {}

function mapFetchError(
  message: string,
  code?: string,
  details?: Record<string, unknown>,
): HostRpcError {
  if (code === "PATH_OUTSIDE_ALLOWED_ROOTS" || message.includes("PATH_OUTSIDE")) {
    if (typeof details?.projectPath === "string") {
      return new ProjectTargetUnavailable({ projectPath: details.projectPath, message })
    }
    return new PathOutsideRootsError({
      message,
      ...(typeof details?.path === "string" ? { path: details.path } : {}),
    })
  }
  if (code === "CONFLICT") {
    const expectedRevision = typeof details?.expectedRevision === "number" ? details.expectedRevision : undefined
    const actualRevision = typeof details?.actualRevision === "number" ? details.actualRevision : undefined
    const toolUseId = typeof details?.toolUseId === "string" ? details.toolUseId : undefined
    if (toolUseId && expectedRevision !== undefined && actualRevision !== undefined) {
      return new ToolUseConflict({ toolUseId, expectedRevision, actualRevision, message })
    }
    const tabId = typeof details?.tabId === "string" ? details.tabId : undefined
    if (tabId && expectedRevision !== undefined && actualRevision !== undefined) {
      return new SessionTabConflict({ tabId, expectedRevision, actualRevision, message })
    }
    return new ConflictError({ message })
  }
  if (code === "NOT_FOUND") {
    if (typeof details?.sessionId === "string") return new SessionNotFound({ sessionId: details.sessionId, message })
    if (typeof details?.tabId === "string") return new SessionTabNotFound({ tabId: details.tabId, message })
    if (typeof details?.toolUseId === "string") return new ToolUseNotFound({ toolUseId: details.toolUseId, message })
    return new NotFoundError({ message })
  }
  if (code === "PAYLOAD_TOO_LARGE") return new PayloadTooLargeError({ message })
  if (
    code === "FILE_CHANGED" &&
    typeof details?.uri === "string" &&
    typeof details.actualVersion === "string"
  ) {
    return new FileChangedError({
      message,
      uri: details.uri,
      actualVersion: details.actualVersion,
      ...(typeof details.expectedVersion === "string"
        ? { expectedVersion: details.expectedVersion }
        : {}),
    })
  }
  switch (details?.toolError) {
    case "InvalidToolInput":
      return new InvalidToolInput({ message })
    case "InvalidToolCommand":
      return new InvalidToolCommand({ message })
    case "CheckoutResolutionFailed":
      return new CheckoutResolutionFailed({ message })
    case "ToolRuntimeFailure":
      if (typeof details.toolUseId === "string") {
        return new ToolRuntimeFailure({ toolUseId: details.toolUseId, message })
      }
      break
  }
  return new OperationFailedError({ message })
}

/** Effect invoke over fetch + the canonical route registry. */
export function invokeHostRpc<Name extends HostRouteName>(
  clientId: string,
  channel: Name,
  args: HostRouteArgs<Name> | readonly unknown[],
  options?: { signal?: AbortSignal },
): Effect.Effect<HostRouteResult<Name>, HostRpcError> {
  return invokeHostRpcUnchecked(clientId, channel, args, options).pipe(
    Effect.map(value => decodeHostRouteResult(channel, value)),
  )
}

/** Internal adapter for legacy callers whose channel is not narrowed yet. */
export function invokeHostRpcUnchecked(
  clientId: string,
  channel: string,
  args: readonly unknown[],
  options?: { signal?: AbortSignal },
): Effect.Effect<unknown, HostRpcError> {
  return Effect.gen(function* () {
    const routeArgs = yield* Effect.try({
      try: () => {
        if (!isHostRouteName(channel)) throw new Error(`unknown host channel: ${channel}`)
        return decodeHostRouteArgs(channel, [...args])
      },
      catch: cause =>
        new InvalidRpcPayloadError({
          message: "invalid host RPC arguments",
          cause,
        }),
    })
    const body = yield* Effect.mapError(
      decodeHostRpcRequest({ channel, args: routeArgs, clientId }),
      cause =>
        new InvalidRpcPayloadError({
          message: "invalid host RPC request",
          cause,
        }),
    )
    const token = readHostAuthToken()
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (token) headers.authorization = `Bearer ${token}`
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch("/api/v1/rpc", {
          method: "POST",
          headers,
          body: JSON.stringify(body satisfies HostRpcRequest),
          signal: options?.signal,
        }),
      catch: err => {
        if (
          options?.signal?.aborted ||
          (err instanceof Error && err.name === "AbortError") ||
          (typeof DOMException !== "undefined" &&
            err instanceof DOMException &&
            err.name === "AbortError")
        ) {
          const reason = options?.signal?.reason
          if (reason instanceof HostDisconnectedError) return reason
          return new HostDisconnectedError({
            message: "host invoke aborted",
            cause: err,
          })
        }
        return new OperationFailedError({
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        })
      },
    })
    const payload = yield* Effect.tryPromise({
      try: async () =>
        Schema.decodeUnknownPromise(HostRpcResponse)(await response.json()),
      catch: err =>
        new OperationFailedError({
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        }),
    })
    if (!response.ok) {
      const error = "error" in payload ? payload.error : undefined
      return yield* Effect.fail(
        mapFetchError(
          error?.message ?? `Jet API request failed (${response.status})`,
          error?.code,
          error?.details,
        ),
      )
    }
    return yield* Effect.try({
      try: () => {
        if (!isHostRouteName(channel)) throw new Error(`unknown host channel: ${channel}`)
        return decodeHostRouteResult(
          channel,
          "value" in payload ? payload.value : undefined,
        )
      },
      catch: cause =>
        new InvalidRpcPayloadError({
          message: "invalid host RPC result",
          cause,
        }),
    })
  })
}

export function HostClientLive(transport: YaadeHostTransport): Layer.Layer<HostClient> {
  const clientId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `client-${Date.now()}`
  return Layer.succeed(HostClient, {
    invoke: (channel, ...args) =>
      // Prefer Schema path; fall back to transport for non-browser tests.
      typeof fetch === "function"
        ? invokeHostRpcUnchecked(clientId, channel, args)
        : Effect.tryPromise({
            try: () => transport.invoke(channel, ...args),
            catch: err =>
              new OperationFailedError({
                message: err instanceof Error ? err.message : String(err),
                cause: err,
              }),
          }),
    on: (channel, listener) => Effect.sync(() => transport.on(channel, listener)),
  })
}

/** Promise shim used by createYaadeApi during migration. */
export async function runHostInvoke<T>(
  layer: Layer.Layer<HostClient>,
  channel: string,
  ...args: unknown[]
): Promise<T> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HostClient
      return (yield* client.invoke(channel, ...args)) as T
    }).pipe(Effect.provide(layer)),
  )
}
