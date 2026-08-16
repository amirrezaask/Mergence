import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { nvimEditCommand, nvimLaunchArgs } from "./search-neovim.js"
import {
  disposeSearchNvimSessions,
  rememberSearchNvimSession,
  searchNvimPtyId,
  searchNvimSessionKey,
} from "./search-neovim-sessions.js"

describe("search Neovim targets", () => {
  it("launches the selected absolute path at its result position", () => {
    assert.deepEqual(
      nvimLaunchArgs({ path: "/tmp/src/main.ts", line: 4, column: 2 }),
      ["+call cursor(4, 2)", "--", "/tmp/src/main.ts"],
    )
  })

  it("escapes paths when reusing an existing Neovim PTY", () => {
    assert.equal(
      nvimEditCommand({
        path: "/tmp/a file|with%special#.ts",
        line: 0,
        column: 0,
      }),
      ":edit /tmp/a\\ file\\|with\\%special\\#.ts\r:call cursor(1, 1)\r",
    )
  })

  it("disposes every auxiliary PTY owned by one archived SearchTool", async () => {
    const first = searchNvimSessionKey("use-search-a", "/tmp/a")
    const second = searchNvimSessionKey("use-search-a", "/tmp/b")
    const unrelated = searchNvimSessionKey("use-search-b", "/tmp/a")
    rememberSearchNvimSession(first, "pty-1")
    rememberSearchNvimSession(second, "pty-2")
    rememberSearchNvimSession(unrelated, "pty-3")
    const disposed: string[] = []

    await disposeSearchNvimSessions("use-search-a", async ptyId => {
      disposed.push(ptyId)
    })

    assert.deepEqual(disposed.sort(), ["pty-1", "pty-2"])
    assert.equal(searchNvimPtyId(first), undefined)
    assert.equal(searchNvimPtyId(second), undefined)
    assert.equal(searchNvimPtyId(unrelated), "pty-3")
    await disposeSearchNvimSessions("use-search-b", async () => undefined)
  })
})
