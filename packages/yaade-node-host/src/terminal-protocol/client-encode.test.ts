import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { encodeClientCommand } from "./client-encode.js"

test("fenced writes become typed sendInput commands and unknown ops stay legacy", () => {
  const fenced = encodeClientCommand(
    "writeFenced",
    ["pty-1", "x", { commandId: "cmd-1", terminalId: "pty-1" }],
    "7",
    1_700_000_000_000,
  )
  assert.equal(fenced?.operation, "sendInput")
  assert.equal(fenced?.commandId, "cmd-1")
  assert.equal(fenced?.payload.terminalId, "pty-1")
  assert.equal(encodeClientCommand("write", ["pty-1", "x"], "8", Date.now()), null)
  assert.equal(encodeClientCommand("acknowledgeData", ["pty-1", 4], "9", Date.now()), null)
})
