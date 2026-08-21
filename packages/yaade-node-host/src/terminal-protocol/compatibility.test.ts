import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  legacyEventToV2,
  legacyRequestToCommand,
  legacyResponseToV2,
} from "./legacy-v1-adapter.js"
import { SupervisorProtocolError } from "./errors.js"

test("legacy supervisor messages normalize without granting new capabilities", () => {
  const command = legacyRequestToCommand(
    { kind: "req", id: 7, op: "write", args: ["terminal-a", "x"] },
    Date.now() + 1_000,
  )
  assert.equal(command.operation, "sendInput")
  assert.deepEqual(command.payload, { args: ["terminal-a", "x"] })

  const response = legacyResponseToV2({ kind: "res", id: 7, ok: false, error: "stale" })
  assert.equal(response.requestId, "7")
  assert.equal(response.error?.code, "LEGACY_ERROR")

  const event = legacyEventToV2(
    { kind: "event", channel: "terminal:exit", args: ["terminal-a", 0] },
    "owner-epoch",
  )
  assert.equal(event.event, "terminal.exited")
  assert.equal(event.terminalId, "terminal-a")
  assert.throws(
    () => legacyRequestToCommand({ kind: "req", id: 8, op: "unknown", args: [] }, Date.now() + 1_000),
    (error: unknown) => error instanceof SupervisorProtocolError && error.code === "INVALID_MESSAGE",
  )
})
