import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { AtlasPacker, glyphCellPlacement } from "./atlas.js"

describe("Neovim atlas packing", () => {
  it("packs deterministic non-overlapping rows across layers", () => {
    const packer = new AtlasPacker(8, 8, 2)
    const first = packer.allocate(4, 2)
    const second = packer.allocate(4, 2)
    const third = packer.allocate(8, 6)
    assert.deepEqual(first, { layer: 0, x: 0, y: 0, width: 4, height: 2 })
    assert.deepEqual(second, { layer: 0, x: 4, y: 0, width: 4, height: 2 })
    assert.deepEqual(third, { layer: 0, x: 0, y: 2, width: 8, height: 6 })
    assert.deepEqual(packer.allocate(8, 8), { layer: 1, x: 0, y: 0, width: 8, height: 8 })
    assert.equal(packer.allocate(1, 1), null)
  })

  it("rejects glyphs larger than a layer", () => {
    const packer = new AtlasPacker(4, 4, 1)
    assert.equal(packer.allocate(5, 1), null)
    assert.equal(packer.allocate(1, 5), null)
  })
})

describe("Neovim glyph cell placement", () => {
  it("left-aligns to the text origin and shares one baseline", () => {
    const narrow = glyphCellPlacement({ padding: 2, left: 0, ascent: 10, baseline: 18 })
    const wide = glyphCellPlacement({ padding: 2, left: 1, ascent: 14, baseline: 18 })
    const italic = glyphCellPlacement({ padding: 2, left: 3, ascent: 10, baseline: 18 })
    assert.deepEqual(narrow, { offsetX: -2, offsetY: 6 })
    assert.deepEqual(wide, { offsetX: -3, offsetY: 2 })
    assert.deepEqual(italic, { offsetX: -5, offsetY: 6 })
    assert.equal(narrow.offsetY, italic.offsetY)
    assert.notEqual(narrow.offsetX, italic.offsetX)
  })
})
