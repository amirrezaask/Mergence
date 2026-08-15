import assert from "node:assert/strict"
import test from "node:test"
import {
  createDa1Scanner,
  feedDa1Queries,
  stripDa1Responses,
  TERMINAL_DA1_RESPONSE,
} from "./terminal-da.js"

test("detects CSI c and CSI 0 c", () => {
  const scanner = createDa1Scanner()
  assert.equal(feedDa1Queries(scanner, "hello\x1b[0cworld"), 1)
  assert.equal(feedDa1Queries(scanner, "\x1b[c"), 1)
  assert.equal(scanner.leftover, "")
})

test("holds an incomplete query across chunks", () => {
  const scanner = createDa1Scanner()
  assert.equal(feedDa1Queries(scanner, "pre\x1b"), 0)
  assert.equal(scanner.leftover, "\x1b")
  assert.equal(feedDa1Queries(scanner, "[0"), 0)
  assert.equal(scanner.leftover, "\x1b[0")
  assert.equal(feedDa1Queries(scanner, "cpost"), 1)
  assert.equal(scanner.leftover, "")
})

test("does not treat a DA1 response as a query", () => {
  const scanner = createDa1Scanner()
  assert.equal(feedDa1Queries(scanner, TERMINAL_DA1_RESPONSE), 0)
})

test("strips DA1 responses and leaves surrounding bytes", () => {
  assert.equal(stripDa1Responses(`ab${TERMINAL_DA1_RESPONSE}cd`), "abcd")
  assert.equal(stripDa1Responses("plain"), "plain")
  assert.equal(stripDa1Responses("\x1b[0c"), "\x1b[0c")
})
