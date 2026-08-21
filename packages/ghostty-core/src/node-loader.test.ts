import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { GhosttyTerminalCore } from "./core.js"
import { nodeGhosttyWasmSource } from "./loaders/node.js"

test("Node loader instantiates the pinned Ghostty core without browser globals", async () => {
  const source = await nodeGhosttyWasmSource()
  const core = await GhosttyTerminalCore.create(
    20,
    3,
    8,
    16,
    {
      foreground: { r: 229, g: 231, b: 235 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 229, g: 231, b: 235 },
    },
    () => undefined,
    source,
  )
  try {
    core.write("hello\n世界")
    const snapshot = core.snapshot(false)
    assert.equal(snapshot.cols, 20)
    assert.equal(snapshot.rows, 3)
    assert.match(snapshot.rowData.map(row => row.text).join("\n"), /hello/)
  } finally {
    core.dispose()
  }

  let responses = 0
  const renderOnly = await GhosttyTerminalCore.create(
    20,
    3,
    8,
    16,
    {
      foreground: { r: 229, g: 231, b: 235 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 229, g: 231, b: 235 },
    },
    () => { responses += 1 },
    source,
    "render-only",
  )
  renderOnly.write("\u001b[0c")
  renderOnly.dispose()
  assert.equal(responses, 0)
})
