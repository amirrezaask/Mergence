import assert from "node:assert/strict"
import { test } from "node:test"
import {
  AgentEventEnvelope,
  AgentThreadSnapshot,
  unsupportedAgentCapabilities,
} from "@yaade/agent-protocol"
import { reduceAgentThreadEvent } from "@yaade/agent-runtime"
import { Schema } from "effect"
import { AgentRuntimeStore } from "./runtime-store.js"

function event(sequence: number, payload: unknown) {
  return Schema.decodeUnknownSync(AgentEventEnvelope)({
    protocolVersion: 1,
    eventId: `event-${sequence}`,
    threadId: "t1",
    sequence,
    occurredAt: `2026-01-01T00:00:0${sequence}.000Z`,
    receivedAt: `2026-01-01T00:00:0${sequence}.000Z`,
    connectionGeneration: 1,
    event: payload,
  })
}

function opened() {
  return event(1, {
    type: "thread.opened",
    projectSessionId: "ses-1",
    providerId: "mock",
    driverId: "mock:canonical",
    cwdUri: "file:///tmp",
    capabilities: unsupportedAgentCapabilities(),
    configuration: [],
  })
}

function snapshot() {
  const reduced = reduceAgentThreadEvent(undefined, opened())
  assert.equal(reduced.status, "applied")
  return Schema.decodeUnknownSync(AgentThreadSnapshot)(reduced.snapshot)
}

test("batches contiguous canonical events and records reduced state", () => {
  const store = new AgentRuntimeStore()
  let notifications = 0
  store.subscribe(() => notifications += 1)
  store.hydrate(snapshot())
  store.enqueue(event(2, { type: "turn.started", turnId: "turn-1" }))
  store.enqueue(event(3, { type: "turn.completed", turnId: "turn-1" }))
  store.flush()
  const thread = store.getThread("t1")
  assert.equal(thread.lastSequence, 3)
  assert.equal(thread.snapshot?.state.status, "idle")
  assert.equal(thread.snapshot?.state.turns[0]?.status, "completed")
  assert.equal(notifications, 2)
})

test("flags a thread sequence gap and requests recovery", () => {
  const store = new AgentRuntimeStore()
  const recoveries: Array<[string, number]> = []
  store.onRecoveryNeeded((threadId, afterSequence) => recoveries.push([threadId, afterSequence]))
  store.hydrate(snapshot())
  store.enqueue(event(3, { type: "turn.started", turnId: "turn-1" }))
  store.flush()
  assert.equal(store.getThread("t1").gapDetected, true)
  assert.deepEqual(recoveries, [["t1", 1]])
})
