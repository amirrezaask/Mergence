import { Data } from "effect"
import type { ToolSessionError } from "./tool-session.js"

/** Host / shared wire error codes (stable JSON). */
export type HostErrorCode =
  | "PATH_OUTSIDE_ALLOWED_ROOTS"
  | "UNKNOWN_OPERATION"
  | "OPERATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "FILE_CHANGED"
  | "PAYLOAD_TOO_LARGE"
  | "HOST_DISCONNECTED"

export class PathOutsideRootsError extends Data.TaggedError("PathOutsideRoots")<{
  readonly message: string
  readonly path?: string
}> {
  readonly code = "PATH_OUTSIDE_ALLOWED_ROOTS" as const
}

export class UnknownChannelError extends Data.TaggedError("UnknownChannel")<{
  readonly channel: string
  readonly message: string
}> {
  readonly code = "UNKNOWN_OPERATION" as const
}

export function unknownChannel(channel: string): UnknownChannelError {
  return new UnknownChannelError({
    channel,
    message: `unknown host channel: ${channel}`,
  })
}

export class OperationFailedError extends Data.TaggedError("OperationFailed")<{
  readonly message: string
  readonly cause?: unknown
}> {
  readonly code = "OPERATION_FAILED" as const
}

export class NotFoundError extends Data.TaggedError("NotFound")<{
  readonly message: string
  readonly resource?: string
}> {
  readonly code = "NOT_FOUND" as const
}

export class ConflictError extends Data.TaggedError("Conflict")<{
  readonly message: string
}> {
  readonly code = "CONFLICT" as const
}

/** Optimistic text-file write rejected because the disk version no longer matches. */
export class FileChangedError extends Data.TaggedError("FileChanged")<{
  readonly message: string
  readonly uri: string
  readonly expectedVersion?: string
  readonly actualVersion: string
}> {
  readonly code = "FILE_CHANGED" as const
}

export class PayloadTooLargeError extends Data.TaggedError("PayloadTooLarge")<{
  readonly message: string
}> {
  readonly code = "PAYLOAD_TOO_LARGE" as const
}

export class LspCrashedError extends Data.TaggedError("LspCrashed")<{
  readonly sessionId: string
  readonly message: string
}> {
  readonly code = "OPERATION_FAILED" as const
}

/** @deprecated Legacy agent RPC error tag; in-app agent control plane removed. */
export class AgentRpcTaggedError extends Data.TaggedError("AgentRpcError")<{
  readonly message: string
  readonly method?: string
  readonly cause?: unknown
}> {}

export class InvalidRpcPayloadError extends Data.TaggedError("InvalidRpcPayload")<{
  readonly message: string
  readonly cause?: unknown
}> {
  readonly code = "OPERATION_FAILED" as const
}

/** Transport closed or WS dropped while an invoke was in flight. */
export class HostDisconnectedError extends Data.TaggedError("HostDisconnected")<{
  readonly message: string
  readonly cause?: unknown
}> {
  readonly code = "HOST_DISCONNECTED" as const
}

/** Git CLI failed (non-zero exit / spawn error). Wire code stays OPERATION_FAILED. */
export class GitCommandFailedError extends Data.TaggedError("GitCommandFailed")<{
  readonly message: string
  readonly cause?: unknown
}> {
  readonly code = "OPERATION_FAILED" as const
}

export type HostRpcError =
  | PathOutsideRootsError
  | UnknownChannelError
  | OperationFailedError
  | NotFoundError
  | ConflictError
  | FileChangedError
  | PayloadTooLargeError
  | LspCrashedError
  | InvalidRpcPayloadError
  | HostDisconnectedError
  | GitCommandFailedError
  | ToolSessionError

export function hostErrorHttpStatus(error: HostRpcError): number {
  switch (error._tag) {
    case "PathOutsideRoots":
      return 403
    case "NotFound":
      return 404
    case "Conflict":
    case "FileChanged":
      return 409
    case "PayloadTooLarge":
      return 413
    case "HostDisconnected":
      return 503
    default:
      return 400
  }
}

export function hostErrorWire(error: HostRpcError): {
  code: HostErrorCode
  message: string
  details: Record<string, unknown>
} {
  const details =
    error._tag === "FileChanged"
      ? {
          uri: error.uri,
          expectedVersion: error.expectedVersion,
          actualVersion: error.actualVersion,
        }
      : error._tag === "ProjectTargetUnavailable"
        ? { projectPath: error.projectPath, toolError: error._tag }
        : error._tag === "PathOutsideRoots"
          ? (error.path ? { path: error.path } : {})
          : error._tag === "ToolUseConflict"
          ? {
              toolUseId: error.toolUseId,
              expectedRevision: error.expectedRevision,
              actualRevision: error.actualRevision,
            }
          : error._tag === "SessionTabConflict"
            ? {
                tabId: error.tabId,
                expectedRevision: error.expectedRevision,
                actualRevision: error.actualRevision,
              }
          : error._tag === "SessionNotFound"
            ? { sessionId: error.sessionId }
            : error._tag === "SessionTabNotFound"
              ? { tabId: error.tabId }
              : error._tag === "ToolUseNotFound"
            ? { toolUseId: error.toolUseId }
            : error._tag === "InvalidToolInput" ||
                error._tag === "InvalidToolCommand" ||
                error._tag === "CheckoutResolutionFailed"
              ? { toolError: error._tag }
              : error._tag === "ToolRuntimeFailure"
                ? { toolError: error._tag, toolUseId: error.toolUseId }
                : {}
  return {
    code: error.code,
    message: error.message,
    details,
  }
}
