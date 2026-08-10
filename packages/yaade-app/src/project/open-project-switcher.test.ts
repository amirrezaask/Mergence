import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { isPathInput, resolveProjectInput } from "./OpenProjectOverlay.js"

describe("project switcher path input", () => {
  it("expands home shorthand without duplicating separators", () => {
    assert.equal(resolveProjectInput("~", "/Users/test"), "/Users/test")
    assert.equal(
      resolveProjectInput("~/dev/project", "/Users/test/"),
      "/Users/test/dev/project",
    )
  })

  it("keeps absolute paths unchanged and distinguishes search text", () => {
    assert.equal(
      resolveProjectInput(" /tmp/project ", "/Users/test"),
      "/tmp/project",
    )
    assert.equal(isPathInput("~/dev/project"), true)
    assert.equal(isPathInput("/tmp/project"), true)
    assert.equal(isPathInput("project"), false)
  })
})
