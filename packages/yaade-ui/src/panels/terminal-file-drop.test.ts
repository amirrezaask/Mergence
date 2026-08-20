import { describe, it } from "vite-plus/test"
import assert from "node:assert/strict"
import { formatDroppedPaths, quoteShellPath } from "./terminal-file-drop.js"

describe("quoteShellPath", () => {
  it("POSIX: wraps in single quotes", () => {
    assert.equal(quoteShellPath("/tmp/foo", false), "'/tmp/foo'")
  })

  it("POSIX: escapes embedded single quotes", () => {
    assert.equal(quoteShellPath("/tmp/it's.txt", false), `'/tmp/it'\\''s.txt'`)
  })

  it("Windows: wraps in double quotes", () => {
    assert.equal(quoteShellPath("C:\\Users\\a\\file.txt", true), `"C:\\Users\\a\\file.txt"`)
  })

  it("Windows: doubles embedded quotes", () => {
    assert.equal(quoteShellPath(`C:\\a\\"b".txt`, true), `"C:\\a\\""b"".txt"`)
  })
})

describe("formatDroppedPaths", () => {
  it("joins with spaces and trailing space", () => {
    assert.equal(
      formatDroppedPaths(["/a", "/b c"], false),
      "'/a' '/b c' ",
    )
  })

  it("returns empty for no paths", () => {
    assert.equal(formatDroppedPaths([], false), "")
  })
})
