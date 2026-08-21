import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  assertPendingRequestCapacity,
  assertSupervisorDeadline,
  decodeSupervisorProtocolMessage,
  encodeSupervisorProtocolMessage,
  SupervisorProtocolFrameReader,
} from "./codec.js"
import { SupervisorProtocolError } from "./errors.js"
import type { SupervisorCommand } from "./schema.js"

function command(requestId: string): SupervisorCommand {
  return {
    version: 2,
    kind: "command",
    requestId,
    deadlineUnixMs: Date.now() + 5_000,
    operation: "inspect",
    payload: { terminalId: "terminal-a" },
  }
}

test("protocol frames support fragmentation and multiple messages per read", () => {
  const first = encodeSupervisorProtocolMessage(command("one"))
  const second = encodeSupervisorProtocolMessage(command("two"))
  const reader = new SupervisorProtocolFrameReader()
  assert.deepEqual(reader.push(first.subarray(0, 3)), [])
  const messages = reader.push(Buffer.concat([first.subarray(3), second]))
  assert.deepEqual(messages.map(message => message.kind === "command" ? message.requestId : ""), ["one", "two"])
})

test("invalid, oversized, and truncated frames fail closed", () => {
  const reader = new SupervisorProtocolFrameReader()
  const oversized = Buffer.alloc(4)
  oversized.writeUInt32BE(17 * 1024 * 1024, 0)
  assert.throws(
    () => reader.push(oversized),
    (error: unknown) => error instanceof SupervisorProtocolError && error.code === "FRAME_TOO_LARGE",
  )

  const invalid = Buffer.alloc(5)
  invalid.writeUInt32BE(1, 0)
  invalid[4] = 0xff
  assert.throws(
    () => new SupervisorProtocolFrameReader().push(invalid),
    (error: unknown) => error instanceof SupervisorProtocolError && error.code === "INVALID_JSON",
  )

  const valid = encodeSupervisorProtocolMessage(command("truncated"))
  const partial = new SupervisorProtocolFrameReader()
  partial.push(valid.subarray(0, valid.length - 1))
  assert.throws(
    () => partial.finish(),
    (error: unknown) => error instanceof SupervisorProtocolError && error.code === "FRAME_TRUNCATED",
  )
})

test("deadlines and pending-request bounds are explicit", () => {
  assert.doesNotThrow(() => assertSupervisorDeadline({ deadlineUnixMs: 101 }, 100))
  assert.throws(
    () => assertSupervisorDeadline({ deadlineUnixMs: 100 }, 100),
    (error: unknown) => error instanceof SupervisorProtocolError && error.code === "DEADLINE_EXPIRED",
  )
  assert.doesNotThrow(() => assertPendingRequestCapacity(2, 3))
  assert.throws(
    () => assertPendingRequestCapacity(3, 3),
    (error: unknown) => error instanceof SupervisorProtocolError && error.code === "PENDING_REQUEST_LIMIT",
  )
})

test("unknown envelopes are rejected instead of deserialized as commands", () => {
  const payload = Buffer.from(JSON.stringify({ version: 2, kind: "future", payload: {} }))
  assert.throws(
    () => decodeSupervisorProtocolMessage(payload),
    (error: unknown) => error instanceof SupervisorProtocolError && error.code === "INVALID_MESSAGE",
  )
})
