import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { Effect } from "effect"
import { makeTerminalHostScoped } from "./effect-terminal.js"

test("makeTerminalHostScoped disposes PTYs when scope closes", async () => {
  let stopped = false
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const terminal = yield* makeTerminalHostScoped
        const original = terminal.stopAll.bind(terminal)
        terminal.stopAll = () => {
          stopped = true
          original()
        }
        assert.equal(typeof terminal.create, "function")
      }),
    ),
  )
  assert.equal(stopped, true)
})
