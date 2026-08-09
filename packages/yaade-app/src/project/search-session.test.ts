import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  buildNeovimQflistSessionPayload,
  formatSearchHitsAsQuickfix,
} from "./search-session.js"

describe("formatSearchHitsAsQuickfix", () => {
  test("formats path:line:col:preview lines", () => {
    const text = formatSearchHitsAsQuickfix([
      { path: "src/a.ts", line: 12, column: 3, preview: "hello world" },
      { path: "src/b.ts", line: 1, column: 1, preview: "foo\nbar" },
    ])
    assert.equal(
      text,
      "src/a.ts:12:3:hello world\nsrc/b.ts:1:1:foo bar\n",
    )
  })

  test("returns empty string for no hits", () => {
    assert.equal(formatSearchHitsAsQuickfix([]), "")
  })
})

describe("buildNeovimQflistSessionPayload", () => {
  test("seeds a Neovim leaf with -q and +copen", () => {
    const payload = buildNeovimQflistSessionPayload(
      "/tmp/proj",
      "/tmp/hits.qf",
    )
    assert.equal(payload.version, 2)
    assert.equal(payload.sessions.length, 1)
    const leaf = payload.sessions[0]!
    assert.equal(leaf.launchCommand, "nvim")
    assert.deepEqual(leaf.launchArgs, ["-q", "/tmp/hits.qf", "+copen"])
    assert.equal(leaf.label, "Neovim")
    assert.ok(leaf.ptyTabId)
    assert.ok(leaf.cwdRootUri.includes("tmp/proj") || leaf.cwdRootUri.includes("tmp%2Fproj") || leaf.cwdRootUri.endsWith("/tmp/proj") || leaf.cwdRootUri.includes("/tmp/proj"))
    assert.notEqual(payload.layout.focusedPaneId, null)
  })
})
