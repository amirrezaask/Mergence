import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { appendBoundedTaskOutput } from "./tasks.js"

test("task output remains bounded and keeps the newest complete UTF-8 text", () => {
  const chunk = `${"x".repeat(8 * 1024 * 1024)}🙂tail`
  const output = appendBoundedTaskOutput("old", chunk)
  assert.ok(Buffer.byteLength(output, "utf8") <= 8 * 1024 * 1024)
  assert.ok(output.endsWith("🙂tail"))
  assert.equal(output.includes("\ufffd"), false)
})
