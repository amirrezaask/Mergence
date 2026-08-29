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

    const firstCell = snapshot.rowData[0]?.cells[0]
    core.write("\u001b[HH")
    const nextSnapshot = core.snapshot(false)
    assert.equal(nextSnapshot.rowData[0]?.cells[0], firstCell)
    assert.equal(nextSnapshot.rowData[0]?.cells[0]?.text, "H")
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

test("snapshot matches Ghostty's default faint opacity", async () => {
  const source = await nodeGhosttyWasmSource()
  const core = await GhosttyTerminalCore.create(
    10,
    2,
    8,
    16,
    {
      foreground: { r: 200, g: 100, b: 50 },
      background: { r: 0, g: 20, b: 50 },
      cursor: { r: 229, g: 231, b: 235 },
    },
    () => undefined,
    source,
    "render-only",
  )
  try {
    core.write("\u001b[2mX")
    assert.deepEqual(core.snapshot(false).rowData[0]?.cells[0]?.foreground, {
      r: 100,
      g: 60,
      b: 50,
    })
  } finally {
    core.dispose()
  }
})
