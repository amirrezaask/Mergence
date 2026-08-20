import { Data } from "effect"
import type {
  CheckoutResolutionFailed,
  InvalidToolCommand,
  InvalidToolInput,
  ProjectTargetUnavailable,
  ToolRuntimeFailure,
  ToolUseConflict,
  ToolUseNotFound,
} from "@yaade/rpc"

export type ToolRuntimeError =
  | InvalidToolCommand
  | InvalidToolInput
  | ProjectTargetUnavailable
  | CheckoutResolutionFailed
  | ToolUseConflict
  | ToolUseNotFound
  | ToolRuntimeFailure
  | ToolDriverFailure

export class ToolDriverFailure extends Data.TaggedError("ToolDriverFailure")<{
  readonly toolUseId: string
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}
