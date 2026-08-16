import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { nvimEditCommand, nvimLaunchArgs } from "./search-neovim.js"

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
})
