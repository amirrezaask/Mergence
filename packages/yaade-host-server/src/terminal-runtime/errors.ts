import { Data } from "effect"

export class TerminalRuntimeDriverFailure extends Data.TaggedError("TerminalRuntimeDriverFailure")<{
  readonly muxTerminalId: string
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}
