import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { ProjectSearchResult } from "@yaade/shared"
import { buildSearchFileGroup, buildSearchFileGroups, groupSearchResultsByPath } from "./search-chunks.js"

function hit(
  path: string,
  line: number,
  preview: string,
): ProjectSearchResult {
  return {
    path,
    line,
    column: 1,
    preview,
    ranges: [
      {
        startLine: line,
        startColumn: 1,
        endLine: line,
        endColumn: Math.max(2, preview.length),
      },
    ],
  }
}

describe("buildSearchFileGroups", () => {
  it("adds context lines and merges adjacent windows", () => {
    const file = ["a", "b", "MATCH1", "d", "e", "MATCH2", "g"].join("\n")
    const groups = buildSearchFileGroups(
      [hit("f.ts", 3, "MATCH1"), hit("f.ts", 6, "MATCH2")],
      new Map([["f.ts", file]]),
      1,
    )
    assert.equal(groups.length, 1)
    assert.equal(groups[0]!.chunks.length, 1)
    assert.deepEqual(
      groups[0]!.chunks[0]!.lines.map(line => `${line.line}:${line.text}`),
      ["2:b", "3:MATCH1", "4:d", "5:e", "6:MATCH2", "7:g"],
    )
  })

  it("leaves a gap between distant matches", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`)
    const groups = buildSearchFileGroups(
      [hit("f.ts", 2, "L2"), hit("f.ts", 18, "L18")],
      new Map([["f.ts", lines.join("\n")]]),
      1,
    )
    assert.equal(groups[0]!.chunks.length, 2)
    assert.equal(groups[0]!.chunks[0]!.endLine, 3)
    assert.equal(groups[0]!.chunks[1]!.startLine, 17)
  })

  it("keeps preview-only match lines when file text is missing", () => {
    const group = buildSearchFileGroup("f.ts", [hit("f.ts", 3, "MATCH")], undefined, 1)
    assert.deepEqual(
      group.chunks[0]!.lines.map(line => `${line.line}:${line.text}`),
      ["3:MATCH"],
    )
  })

  it("preserves first-seen path order", () => {
    const buckets = groupSearchResultsByPath([
      hit("b.ts", 1, "x"),
      hit("a.ts", 1, "y"),
      hit("b.ts", 2, "z"),
    ])
    assert.deepEqual(
      buckets.map(bucket => `${bucket.path}:${bucket.matches.length}`),
      ["b.ts:2", "a.ts:1"],
    )
  })
})
