import { describe, it } from "vite-plus/test"
import assert from "node:assert/strict"
import { fuzzyFilter, fuzzyScore } from "./fuzzy.js"

describe("lister fuzzy", () => {
  it("empty query keeps order", () => {
    const items = [{ searchText: "b" }, { searchText: "a" }]
    assert.deepEqual(
      fuzzyFilter("", items).map(i => i.searchText),
      ["b", "a"],
    )
  })

  it("ranks exact / prefix ahead of subsequence", () => {
    const items = [
      { searchText: "open file" },
      { searchText: "workspace.openFile" },
      { searchText: "foo" },
    ]
    const out = fuzzyFilter("open", items).map(i => i.searchText)
    assert.equal(out[0], "open file")
    assert.ok(out.includes("workspace.openFile"))
    assert.ok(!out.includes("foo"))
  })

  it("requires all tokens", () => {
    assert.equal(fuzzyScore("open file", "open folder"), null)
    assert.ok(fuzzyScore("open file", "open file dialog") !== null)
  })

  it("matches subsequence", () => {
    assert.ok(fuzzyScore("wpf", "workspace.openFile") !== null)
  })
})
