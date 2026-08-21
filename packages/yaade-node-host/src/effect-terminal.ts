import { Effect, type Scope } from "effect"
import { TerminalHost } from "./terminal.js"

/**
 * Acquire a {@link TerminalHost} for the lifetime of an Effect scope.
 *
 * On scope finalization, all PTYs are disposed via {@link TerminalHost.stopAll}.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { makeTerminalHostScoped } from "@yaade/node-host"
 *
 * const program = Effect.scoped(
 *   Effect.gen(function* () {
 *     const terminal = yield* makeTerminalHostScoped
 *     return terminal.create("file:///tmp", null, "client")
 *   }),
 * )
 * ```
 */
export const makeTerminalHostScoped: Effect.Effect<TerminalHost, never, Scope.Scope> =
  Effect.acquireRelease(
    Effect.sync(() => new TerminalHost({ semanticState: true })),
    host =>
      Effect.sync(() => {
        host.stopAll()
      }),
  )
