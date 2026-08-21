import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { BasicTerminalStateRecorder } from "./recorder.js"

test("checkpoint recorder reconstructs a bounded screen and cursor", () => {
  const recorder = new BasicTerminalStateRecorder(8, 3, "term-epoch")
  recorder.write("hello\r\nworld\u001b[2;3H!")
  const checkpoint = recorder.checkpoint(7)
  assert.equal(checkpoint.terminalEpoch, "term-epoch")
  assert.equal(checkpoint.sequence, 7)
  assert.match(checkpoint.syntheticAnsi, /hello/)
  assert.match(checkpoint.syntheticAnsi, /wo!ld/)
  assert.match(checkpoint.syntheticAnsi, /\u001b\[2;4H/)
})

test("checkpoint plus later deltas reconstructs a token split across the boundary", () => {
  const writer = new BasicTerminalStateRecorder(80, 24, "epoch")
  writer.write("YAADE_MOCK_N=0218\nYAADE_MOCK_N=02")
  const checkpoint = writer.checkpoint(1)
  const reader = new BasicTerminalStateRecorder(80, 24, "epoch")
  reader.write(checkpoint.syntheticAnsi)
  reader.write("19\nYAADE_MOCK_N=0220\n")
  const screen = reader.plainText()
  assert.match(screen, /YAADE_MOCK_N=0218/)
  assert.match(screen, /YAADE_MOCK_N=0219/)
  assert.match(screen, /YAADE_MOCK_N=0220/)
})

test("alternate screen checkpoint is explicitly represented", () => {
  const recorder = new BasicTerminalStateRecorder(4, 2, "epoch")
  recorder.write("main\u001b[?1049halt\u001b[?1049l")
  const checkpoint = recorder.checkpoint(3)
  assert.match(checkpoint.syntheticAnsi, /\u001b\[\?1049l/)
})
