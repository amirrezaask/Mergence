import { Effect, Stream } from "effect"
import type {
  TerminalKind,
  MuxTerminal,
  TerminalInput,
  TerminalOutput,
  TerminalStatus,
} from "@yaade/rpc"
import type { TerminalRuntimeError } from "./errors.js"

export type TerminalRuntimeEvent =
  | { readonly _tag: "OutputChanged"; readonly muxTerminal: MuxTerminal }
  | { readonly _tag: "StatusChanged"; readonly muxTerminal: MuxTerminal }

/** Runtime-only contract. Drivers never know about React or transport framing. */
export type TerminalRuntimeDriver = {
  readonly kind: TerminalKind
  readonly create: (
    muxTerminal: MuxTerminal,
    input: TerminalInput,
  ) => Effect.Effect<TerminalOutput, TerminalRuntimeError>
  readonly updateInput?: (
    muxTerminal: MuxTerminal,
    input: TerminalInput,
  ) => Effect.Effect<TerminalOutput, TerminalRuntimeError>
  readonly restart: (muxTerminal: MuxTerminal) => Effect.Effect<TerminalOutput, TerminalRuntimeError>
  readonly cancel: (muxTerminal: MuxTerminal) => Effect.Effect<TerminalOutput, TerminalRuntimeError>
  readonly attach: (
    muxTerminal: MuxTerminal,
  ) => Stream.Stream<TerminalRuntimeEvent, TerminalRuntimeError>
  readonly close: (muxTerminal: MuxTerminal) => Effect.Effect<void, TerminalRuntimeError>
}

export type TerminalStatusTransition = {
  readonly status: TerminalStatus
  readonly output?: TerminalOutput
}
