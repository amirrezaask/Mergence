import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { TerminalFlowControl } from "./terminal-flow-control.js"

test("acknowledgements release per-terminal output credit", () => {
  const flow = new TerminalFlowControl(10)
  assert.equal(flow.reserve("a", 1, 6).accepted, true)
  assert.equal(flow.reserve("a", 2, 4).accepted, true)
  assert.equal(flow.outstandingBytes, 10)
  flow.acknowledge("a", 1)
  assert.equal(flow.outstandingBytes, 4)
  assert.equal(flow.reserve("a", 3, 6).accepted, true)
})

test("a lagging terminal requires replay without consuming another terminal's credit", () => {
  const flow = new TerminalFlowControl(8)
  assert.equal(flow.reserve("slow", 1, 8).accepted, true)
  const rejected = flow.reserve("slow", 2, 1)
  assert.deepEqual(rejected, { accepted: false, acknowledgedSequence: 0 })
  assert.equal(flow.reserve("fast", 1, 8).accepted, true)
  flow.reset("slow", 1)
  assert.equal(flow.reserve("slow", 2, 8).accepted, true)
})

test("socket-wide credit resynchronizes one producer before mailbox overflow", () => {
  const flow = new TerminalFlowControl(8, 12)
  assert.equal(flow.reserve("a", 1, 8).accepted, true)
  assert.equal(flow.reserve("b", 1, 4).accepted, true)
  assert.deepEqual(flow.reserve("b", 2, 1), {
    accepted: false,
    acknowledgedSequence: 0,
  })
  flow.acknowledge("a", 1)
  flow.reset("b", 1)
  assert.equal(flow.reserve("b", 2, 8).accepted, true)
  assert.equal(flow.outstandingBytes, 8)
  flow.delete("b")
  assert.equal(flow.outstandingBytes, 0)
})

test("stale acknowledgements do not release newer frames", () => {
  const flow = new TerminalFlowControl(16)
  flow.reset("a", 5)
  assert.equal(flow.reserve("a", 6, 8).accepted, true)
  flow.acknowledge("a", 5)
  assert.equal(flow.outstandingBytes, 8)
  flow.acknowledge("a", 6)
  assert.equal(flow.outstandingBytes, 0)
})
