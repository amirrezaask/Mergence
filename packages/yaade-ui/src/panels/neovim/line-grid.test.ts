import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { decodeRedrawEvents } from "./protocol.js"
import {
  LineGridModel,
  CELL_CONTINUATION,
  CELL_WIDE,
  MAX_GRID_HEIGHT,
  MAX_GRID_WIDTH,
} from "./line-grid.js"

function cells(text: string, highlight?: number): unknown[][] {
  return Array.from(text, (character, index) => index === 0 && highlight !== undefined
    ? [character, highlight]
    : [character])
}

describe("Neovim line-grid model", () => {
  it("normalizes Neovim's grouped redraw event arguments", () => {
    const events = decodeRedrawEvents([
      ["grid_resize", [1, 8, 2]],
      ["grid_line", [1, 0, 0, [cells("ok")], false]],
      ["flush", []],
    ])
    assert.deepEqual(events[0]?.args, [1, 8, 2])
    assert.deepEqual(events[2]?.args, [])
  })

  it("commits redraw mutations at flush and carries omitted highlight ids", () => {
    const model = new LineGridModel()
    const result = model.apply([
      { name: "grid_resize", args: [1, 12, 3] },
      { name: "grid_clear", args: [1] },
      { name: "grid_line", args: [1, 0, 0, cells("hello world", 4), false] },
      { name: "grid_cursor_goto", args: [1, 0, 2] },
      { name: "flush", args: [] },
    ])
    assert.equal(result.flushes, 1)
    assert.match(model.text(), /hello world/)
    assert.equal(model.frame().dirtyRows[0], 1, "flush must not consume renderer dirtiness")
    model.clearDirtyRows()
    assert.equal(model.frame().dirtyRows[0], 0)
  })

  it("ignores zero-repeat cells emitted by newer Neovim builds", () => {
    const model = new LineGridModel()
    model.apply([
      { name: "grid_resize", args: [1, 3, 1] },
      { name: "grid_line", args: [1, 0, 0, [["x", 1, 0], ["y", 1, 1]], false] },
      { name: "flush", args: [] },
    ])
    assert.match(model.text(), /^y/u)
  })

  it("uses Neovim's empty continuation cell for wide clusters", () => {
    const model = new LineGridModel()
    model.apply([
      { name: "grid_resize", args: [1, 4, 1] },
      { name: "grid_line", args: [1, 0, 0, [["界", 1], ["", 1], ["x", 1]], false] },
      { name: "flush", args: [] },
    ])
    const frame = model.frame()
    assert.equal(frame.cellFlags[0], CELL_WIDE)
    assert.equal(frame.cellFlags[1], CELL_CONTINUATION)
    assert.match(model.text(), /^界x/u)
  })

  it("tracks ext_hlstate metadata and mode cursor shapes", () => {
    const model = new LineGridModel()
    model.apply([
      { name: "grid_resize", args: [1, 4, 1] },
      { name: "hl_attr_define", args: [7, { foreground: 1, underdotted: true }, {}, [{ kind: "syntax", hi_name: "String" }]] },
      { name: "mode_info_set", args: [true, [{ cursor_shape: "vertical", cell_percentage: 18, blinkwait: 500, blinkon: 300, blinkoff: 200 }]] },
      { name: "mode_change", args: ["insert", 0] },
      { name: "flush", args: [] },
    ])
    assert.equal(model.highlight(7)?.groupName, "String")
    assert.equal(model.highlight(7)?.underdotted, true)
    assert.deepEqual(model.state().cursorMode, {
      shape: "vertical",
      cellPercentage: 18,
      blinkWaitMs: 500,
      blinkOnMs: 300,
      blinkOffMs: 200,
    })
  })

  it("scrolls overlapping regions in both directions", () => {
    const model = new LineGridModel()
    model.apply([
      { name: "grid_resize", args: [1, 4, 4] },
      { name: "grid_line", args: [1, 0, 0, [["a", 1]], false] },
      { name: "grid_line", args: [1, 1, 0, [["b", 1]], false] },
      { name: "grid_line", args: [1, 2, 0, [["c", 1]], false] },
      { name: "grid_line", args: [1, 3, 0, [["d", 1]], false] },
      { name: "grid_scroll", args: [1, 0, 4, 0, 4, 1, 0] },
      { name: "flush", args: [] },
    ])
    assert.match(model.text(), /b/)
    assert.doesNotMatch(model.text(), /^a/m)
    model.apply([
      { name: "grid_scroll", args: [1, 0, 4, 0, 4, -1, 0] },
      { name: "flush", args: [] },
    ])
    assert.match(model.text(), /b/)
  })

  it("bounds grid allocation and resets glyph interning on clear", () => {
    const model = new LineGridModel()
    assert.throws(
      () => model.apply([{ name: "grid_resize", args: [1, 10_000, 10_000] }]),
      /outside the supported range/,
    )
    model.apply([
      { name: "grid_resize", args: [1, 4, 1] },
      { name: "grid_line", args: [1, 0, 0, cells("abcd"), false] },
      { name: "grid_clear", args: [1] },
    ])
    assert.equal(model.diagnostics().internedGlyphs, 1)
  })

  it("coalesces dirty rows across multiple flushes without copying them", () => {
    const model = new LineGridModel()
    const result = model.apply([
      { name: "grid_resize", args: [1, 8, 4] },
      { name: "grid_line", args: [1, 0, 0, cells("a"), false] },
      { name: "flush", args: [] },
      { name: "grid_line", args: [1, 2, 0, cells("b"), false] },
      { name: "flush", args: [] },
      { name: "grid_line", args: [1, 3, 0, cells("c"), false] },
      { name: "flush", args: [] },
    ])
    const runs: Array<[number, number]> = []
    model.forEachDirtyRowRun((start, end) => runs.push([start, end]))
    assert.equal(result.flushes, 3)
    assert.deepEqual(runs, [[0, 4]])
    assert.equal(result.visualBellChanged, false)
  })

  it("accepts each independent dimension bound but rejects before allocation grows", () => {
    const model = new LineGridModel()
    const initialLength = model.frame().glyphIds.length
    assert.throws(() => model.apply([{ name: "grid_resize", args: [1, MAX_GRID_WIDTH + 1, 1] }]), /outside the supported range/)
    assert.equal(model.frame().glyphIds.length, initialLength)
    model.apply([{ name: "grid_resize", args: [1, MAX_GRID_WIDTH, 1] }])
    model.apply([{ name: "grid_resize", args: [1, 1, MAX_GRID_HEIGHT] }])
    assert.equal(model.state().height, MAX_GRID_HEIGHT)
  })

  it("compacts changing glyph clusters while preserving the visible cell", () => {
    const model = new LineGridModel()
    model.apply([{ name: "grid_resize", args: [1, 1, 1] }])
    for (let index = 0; index < 100_000; index += 1) {
      model.apply([
        { name: "grid_line", args: [1, 0, 0, [[`cluster-${index}`, 0, 1]], false] },
        { name: "flush", args: [] },
      ])
    }
    assert.equal(model.text(), "cluster-99999")
    assert.ok(model.diagnostics().glyphCompactions > 0)
    assert.ok(model.diagnostics().internedGlyphs < 128)
  })

  it("counts and ignores unknown forward-compatible events", () => {
    const model = new LineGridModel()
    model.apply([{ name: "future_grid_event", args: [1, "later"] }, { name: "flush", args: [] }])
    assert.equal(model.diagnostics().unknownEvents, 1)
  })
})
