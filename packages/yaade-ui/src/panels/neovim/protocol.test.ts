import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { decodeRedrawEvents, forEachRedrawEvent, NeovimProtocolError } from "./protocol.js"

describe("Neovim redraw protocol", () => {
  it("visits grouped calls by reference and keeps flattened fixtures compatible", () => {
    const groupedArgs = [1, 4, 1]
    const grouped = [ ["grid_resize", groupedArgs], ["flush"] ] as unknown[]
    const visited: Array<{ name: string; args: readonly unknown[] }> = []
    forEachRedrawEvent(grouped, (name, args) => visited.push({ name, args }))
    assert.equal(visited[0]?.args, groupedArgs)
    assert.deepEqual(decodeRedrawEvents([["grid_resize", 1, 4, 1]]), [{ name: "grid_resize", args: [1, 4, 1] }])
  })

  it("rejects malformed redraw event lists at the wire boundary", () => {
    assert.throws(() => decodeRedrawEvents([null]), NeovimProtocolError)
    assert.throws(() => decodeRedrawEvents([["grid_line", [1], "bad"]]), NeovimProtocolError)
  })
})
