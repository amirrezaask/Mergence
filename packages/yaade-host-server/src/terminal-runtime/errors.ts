import { Data } from "effect"
import type {
  InvalidMuxCommand,
  InvalidTerminalInput,
  TerminalRuntimeFailure,
  TerminalConflict,
  TerminalNotFound,
} from "@yaade/rpc"

export type TerminalRuntimeError =
  | InvalidMuxCommand
  | InvalidTerminalInput
  | TerminalConflict
  | TerminalNotFound
  | TerminalRuntimeFailure
  | TerminalRuntimeDriverFailure

export class TerminalRuntimeDriverFailure extends Data.TaggedError("TerminalRuntimeDriverFailure")<{
  readonly muxTerminalId: string
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}
