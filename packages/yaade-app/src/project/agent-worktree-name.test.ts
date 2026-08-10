import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { defaultAgentWorktreeName } from "./agent-worktree-name.js"

describe("defaultAgentWorktreeName", () => {
  it("prefixes the driver id under yaade/", () => {
    const name = defaultAgentWorktreeName("codex")
    assert.match(name, /^yaade\/codex-\d{4}-\d{2}-\d{2}T/)
  })
})
