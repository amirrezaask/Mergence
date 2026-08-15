import assert from "node:assert/strict"
import test from "node:test"
import {
  decodeTerminalDataFrame,
  encodeTerminalDataFrame,
  encodeTerminalWsCommand,
  tryDecodeTerminalWsCommand,
} from "./terminal-ws.js"

test("round-trips binary terminal:data frames", () => {
  const encoded = encodeTerminalDataFrame(42, 7, "term-1", "hello✓")
  const decoded = decodeTerminalDataFrame(encoded)
  assert.deepEqual(decoded, {
    eventSequence: 42,
    terminalSequence: 7,
    id: "term-1",
    data: "hello✓",
  })
})

test("rejects truncated or wrong-type binary frames", () => {
  assert.equal(decodeTerminalDataFrame(new Uint8Array([0x02, 0, 0, 0, 1])), null)
  assert.equal(decodeTerminalDataFrame(new Uint8Array([0x01, 0, 0])), null)
})

test("encodes and decodes terminal WS control commands", () => {
  const raw = JSON.parse(encodeTerminalWsCommand("terminal:write", ["id", "x"]))
  assert.deepEqual(tryDecodeTerminalWsCommand(raw), {
    op: "terminal:write",
    args: ["id", "x"],
  })
  assert.deepEqual(
    tryDecodeTerminalWsCommand({ op: "terminal:ready", args: ["id"] }),
    { op: "terminal:ready", args: ["id"] },
  )
  assert.equal(tryDecodeTerminalWsCommand({ op: "fs:readFile", args: [] }), null)
})
