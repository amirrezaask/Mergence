import { Effect, Stream } from "effect"
import type {
  ToolKind,
  ToolUse,
  ToolUseInput,
  ToolUseOutput,
  ToolUseStatus,
} from "@yaade/rpc"
import type { ToolRuntimeError } from "./errors.js"

export type ToolRuntimeEvent =
  | { readonly _tag: "OutputChanged"; readonly toolUse: ToolUse }
  | { readonly _tag: "StatusChanged"; readonly toolUse: ToolUse }

/** Runtime-only contract. Drivers never know about React or transport framing. */
export type ToolDriver = {
  readonly kind: ToolKind
  readonly create: (
    toolUse: ToolUse,
    input: ToolUseInput,
  ) => Effect.Effect<ToolUseOutput, ToolRuntimeError>
  readonly updateInput?: (
    toolUse: ToolUse,
    input: ToolUseInput,
  ) => Effect.Effect<ToolUseOutput, ToolRuntimeError>
  readonly restart: (toolUse: ToolUse) => Effect.Effect<ToolUseOutput, ToolRuntimeError>
  readonly cancel: (toolUse: ToolUse) => Effect.Effect<ToolUseOutput, ToolRuntimeError>
  readonly attach: (
    toolUse: ToolUse,
  ) => Stream.Stream<ToolRuntimeEvent, ToolRuntimeError>
  readonly close: (toolUse: ToolUse) => Effect.Effect<void, ToolRuntimeError>
}

export type ToolStatusTransition = {
  readonly status: ToolUseStatus
  readonly output?: ToolUseOutput
}
