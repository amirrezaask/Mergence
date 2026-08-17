import { Effect, Stream } from "effect"
import { NeovimToolOutput, type ToolUse, type ToolUseInput } from "@yaade/rpc"
import type { HostRuntime } from "../host-runtime.js"
import type { ToolDriver, ToolRuntimeEvent } from "./model.js"
import { ToolDriverFailure } from "./errors.js"

function driverFailure(toolUse: ToolUse, operation: string, cause: unknown): ToolDriverFailure {
  return new ToolDriverFailure({
    toolUseId: toolUse.id,
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  })
}

function generationFor(toolUse: ToolUse, increment = false): number {
  const current = toolUse.output.kind === "neovim" ? toolUse.output.generation : 0
  return Math.max(1, current + (increment ? 1 : 0))
}

const startRuntime = Effect.fn("NeovimToolDriver.start")(function*(
  runtime: HostRuntime,
  toolUse: ToolUse,
  generation: number,
) {
  return yield* Effect.tryPromise({
    try: () => runtime.neovim.start(toolUse.id, generation, toolUse.context.checkoutPath),
    catch: cause => driverFailure(toolUse, "create", cause),
  })
})

const restartRuntime = Effect.fn("NeovimToolDriver.restart")(function*(
  runtime: HostRuntime,
  toolUse: ToolUse,
  generation: number,
) {
  return yield* Effect.tryPromise({
    try: () => runtime.neovim.restart(toolUse.id, generation, toolUse.context.checkoutPath),
    catch: cause => driverFailure(toolUse, "restart", cause),
  })
})

const stopRuntime = Effect.fn("NeovimToolDriver.stop")(function*(
  runtime: HostRuntime,
  toolUse: ToolUse,
) {
  return yield* Effect.tryPromise({
    try: () => runtime.neovim.stop(toolUse.id),
    catch: cause => driverFailure(toolUse, "cancel", cause),
  })
})

/** Effect adapter for the host-owned Neovim process registry. */
export class NeovimToolDriver implements ToolDriver {
  readonly kind = "neovim" as const

  constructor(private readonly runtime: HostRuntime) {}

  create(toolUse: ToolUse, input: ToolUseInput): Effect.Effect<NeovimToolOutput, ToolDriverFailure> {
    if (input.kind !== "neovim") {
      return Effect.fail(driverFailure(toolUse, "create", new Error("Neovim driver received mismatched input")))
    }
    return startRuntime(this.runtime, toolUse, generationFor(toolUse))
  }

  restart(toolUse: ToolUse): Effect.Effect<NeovimToolOutput, ToolDriverFailure> {
    return restartRuntime(this.runtime, toolUse, generationFor(toolUse, true))
  }

  cancel(toolUse: ToolUse): Effect.Effect<NeovimToolOutput, ToolDriverFailure> {
    return stopRuntime(this.runtime, toolUse).pipe(
      Effect.flatMap(stopped => {
        if (stopped) return Effect.succeed(stopped)
        if (toolUse.output.kind === "neovim") {
          return Effect.succeed(NeovimToolOutput.make({
            ...toolUse.output,
            processState: "exited",
          }))
        }
        return Effect.fail(driverFailure(toolUse, "cancel", new Error("Neovim output is unavailable")))
      }),
    )
  }

  attach(toolUse: ToolUse): Stream.Stream<ToolRuntimeEvent> {
    return Stream.succeed({ _tag: "OutputChanged", toolUse })
  }

  close(toolUse: ToolUse): Effect.Effect<void, ToolDriverFailure> {
    return this.cancel(toolUse).pipe(Effect.asVoid)
  }
}
