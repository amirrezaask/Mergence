import assert from "node:assert/strict"
import { test } from "node:test"
import {
  AgentConnectionState,
  AgentEventEnvelope,
  AgentThreadSnapshot,
  unsupportedAgentCapabilities,
} from "@yaade/agent-protocol"
import type { JetElectronAgentRuntime } from "@yaade/workspace"
import { reduceAgentThreadEvent } from "@yaade/agent-runtime"
import { Schema } from "effect"
import { AgentRuntimeClient } from "./runtime-client.js"

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

function snapshot() {
  const reduced = reduceAgentThreadEvent(undefined, event(1, {
      type: "thread.opened",
      projectSessionId: "ses-1",
      providerId: "mock",
      driverId: "mock:canonical",
      cwdUri: "file:///tmp",
      capabilities: unsupportedAgentCapabilities(),
      configuration: [],
    }))
  assert.equal(reduced.status, "applied")
  return Schema.decodeUnknownSync(AgentThreadSnapshot)(reduced.snapshot)
}

function completedSnapshot() {
  const started = reduceAgentThreadEvent(
    snapshot(),
    event(2, { type: "turn.started", turnId: "turn-1" }),
  )
  assert.equal(started.status, "applied")
  const completed = reduceAgentThreadEvent(
    started.snapshot,
    event(3, { type: "turn.completed", turnId: "turn-1" }),
  )
  assert.equal(completed.status, "applied")
  return Schema.decodeUnknownSync(AgentThreadSnapshot)(completed.snapshot)
}

function fakeRuntime() {
  let snapshotListener: Parameters<JetElectronAgentRuntime["onSnapshot"]>[0] | undefined
  let connectionListener: Parameters<JetElectronAgentRuntime["onConnection"]>[0] | undefined
  let replayGapListener: (() => void) | undefined
  const recoveries: string[] = []
  const api = {
    createThread: async () => { throw new Error("unused") },
    listThreads: async () => [],
    listProviders: async () => [],
    listDrivers: async () => [],
    uploadAttachment: async () => { throw new Error("unused") },
    getSnapshot: async () => null,
    getConnectionState: async () => AgentConnectionState.make({ status: "connected", generation: 1 }),
    recoverThread: async (threadId: string) => {
      recoveries.push(threadId)
      return {
        snapshot: completedSnapshot(),
        events: [
          event(2, { type: "turn.started", turnId: "turn-1" }),
          event(3, { type: "turn.completed", turnId: "turn-1" }),
        ],
      }
    },
    sendCommand: async () => { throw new Error("unused") },
    closeThread: async () => { throw new Error("unused") },
    deleteThread: async () => false,
    onEvent: () => () => {},
    onSnapshot: callback => { snapshotListener = callback; return () => { snapshotListener = undefined } },
    onConnection: callback => { connectionListener = callback; return () => { connectionListener = undefined } },
    onRegistryChanged: () => () => {},
    onReplayGap: callback => { replayGapListener = () => callback(4, 8); return () => { replayGapListener = undefined } },
  } satisfies JetElectronAgentRuntime
  return { api, recoveries, snapshotListener: () => snapshotListener, connectionListener: () => connectionListener, replayGapListener: () => replayGapListener }
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

test("hydrates pushed snapshots and tracks live connection state", async () => {
  const fake = fakeRuntime()
  const client = new AgentRuntimeClient(fake.api)
  fake.snapshotListener()?.(snapshot())
  await tick()
  assert.equal(client.store.getThread("t1").snapshot?.state.lastSequence, 1)
  assert.equal(client.store.getThread("t1").connection?.status, "connected")
  fake.connectionListener()?.({
    threadId: "t1",
    state: AgentConnectionState.make({ status: "reconnecting", generation: 2 }),
  })
  assert.equal(client.store.getThread("t1").connection?.status, "reconnecting")
  client.close()
})

test("recovers every hydrated thread after replay eviction or a long disconnect", async () => {
  const fake = fakeRuntime()
  const client = new AgentRuntimeClient(fake.api)
  client.hydrate(snapshot())
  fake.replayGapListener()?.()
  await tick()
  assert.deepEqual(fake.recoveries, ["t1"])
  const recovered = client.store.getThread("t1")
  assert.equal(recovered.lastSequence, 3)
  assert.equal(recovered.snapshot?.state.turns.length, 1)
  assert.equal(recovered.snapshot?.state.turns[0]?.status, "completed")
  fake.connectionListener()?.({
    threadId: "t1",
    state: AgentConnectionState.make({ status: "disconnected", generation: 2 }),
  })
  await tick()
  assert.deepEqual(fake.recoveries, ["t1", "t1"])
  client.close()
})
