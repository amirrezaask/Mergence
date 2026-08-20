#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Effect } from "effect"
import { applyLoginShellEnv } from "@yaade/node-host"
import { loadConfig } from "./config.js"
import { startHostServer } from "./server.js"

export function runHostServer(argv = process.argv.slice(2)): void {
  const program = Effect.gen(function* () {
    applyLoginShellEnv()
    const config = yield* Effect.promise(() => loadConfig(argv))
    const { close } = yield* Effect.promise(() => startHostServer(config))

    const stop = () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => close())
        yield* Effect.sync(() => process.exit(0))
      })

    yield* Effect.sync(() => {
      process.on("SIGINT", () => void Effect.runPromise(stop()))
      process.on("SIGTERM", () => void Effect.runPromise(stop()))
    })

    yield* Effect.never
  })

  NodeRuntime.runMain(program)
}
