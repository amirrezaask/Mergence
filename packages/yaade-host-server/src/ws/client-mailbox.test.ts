import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { ClientOutboundMailbox, type OutboundFrame } from "./client-outbound-mailbox.js"

function frame(bytes: number, terminalId?: string, label = "x"): OutboundFrame {
  return { data: label, bytes, ...(terminalId ? { terminalId } : {}) }
}

test("reliable frames are ordered and bounded without silent drops", () => {
  const mailbox = new ClientOutboundMailbox({
    reliableMaxFrames: 2,
    reliableMaxBytes: 10,
  })
  assert.equal(mailbox.enqueueReliable(frame(4)).accepted, true)
  assert.equal(mailbox.enqueueReliable(frame(4)).accepted, true)
  assert.equal(mailbox.enqueueReliable(frame(4)).accepted, false)
  assert.equal(mailbox.next()?.bytes, 4)
  assert.equal(mailbox.next()?.bytes, 4)
  assert.equal(mailbox.next(), null)
})

test("legacy raw chunks stay ordered and are never replaced", () => {
  const mailbox = new ClientOutboundMailbox({
    legacyMaxFrames: 8,
    legacyMaxBytes: 32,
  })
  assert.equal(mailbox.enqueueLegacyOutput("a", frame(4, "a", "one")).accepted, true)
  assert.equal(mailbox.enqueueLegacyOutput("a", frame(4, "a", "two")).accepted, true)
  assert.equal(mailbox.enqueueLegacyOutput("a", frame(4, "a", "three")).accepted, true)
  assert.equal(mailbox.pendingLegacyFrames, 3)
  assert.equal(mailbox.next()?.data, "one")
  assert.equal(mailbox.next()?.data, "two")
  assert.equal(mailbox.next()?.data, "three")
  assert.equal(mailbox.consumeResyncRequired().length, 0)
})

test("legacy overflow rejects instead of replacing earlier chunks", () => {
  const mailbox = new ClientOutboundMailbox({
    legacyMaxFrames: 2,
    legacyMaxBytes: 10,
  })
  assert.equal(mailbox.enqueueLegacyOutput("a", frame(4, "a", "one")).accepted, true)
  assert.equal(mailbox.enqueueLegacyOutput("a", frame(4, "a", "two")).accepted, true)
  const overflow = mailbox.enqueueLegacyOutput("a", frame(4, "a", "three"))
  assert.equal(overflow.accepted, false)
  assert.equal(overflow.overflow, "legacy")
  assert.equal(overflow.requiresResync, false)
  assert.equal(mailbox.pendingLegacyFrames, 2)
})

test("semantic frames replace stale terminal state and mark resync without overflow", () => {
  const mailbox = new ClientOutboundMailbox({
    semanticMaxTerminals: 2,
    semanticMaxBytes: 10,
  })
  assert.equal(mailbox.enqueueSemanticRender("a", frame(4, "a", "snap-1")).accepted, true)
  const replacement = mailbox.enqueueSemanticRender("a", frame(5, "a", "snap-2"))
  assert.equal(replacement.accepted, true)
  assert.equal(replacement.replaced, true)
  assert.equal(replacement.requiresResync, true)
  assert.equal(replacement.overflow, null)
  assert.equal(mailbox.pendingRenderBytes, 5)
  assert.equal(mailbox.next()?.data, "snap-2")
  assert.deepEqual(mailbox.consumeResyncRequired(), ["a"])
})

test("a semantic frame larger than the budget is rejected instead of retained", () => {
  const mailbox = new ClientOutboundMailbox({ semanticMaxBytes: 4 })
  const result = mailbox.enqueueSemanticRender("terminal-a", frame(5, "terminal-a"))
  assert.equal(result.accepted, false)
  assert.equal(result.requiresResync, true)
  assert.equal(mailbox.pendingBytes, 0)
  assert.deepEqual(mailbox.consumeResyncRequired(), ["terminal-a"])
})

test("reliable responses keep order relative to legacy terminal output", () => {
  const mailbox = new ClientOutboundMailbox()
  mailbox.enqueueReliable(frame(1, undefined, "res"))
  mailbox.enqueueLegacyOutput("a", frame(1, "a", "out"))
  mailbox.enqueueReliable(frame(1, undefined, "evt"))
  assert.equal(mailbox.next()?.data, "res")
  assert.equal(mailbox.next()?.data, "out")
  assert.equal(mailbox.next()?.data, "evt")
})
