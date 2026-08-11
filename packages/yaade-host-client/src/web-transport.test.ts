import assert from "node:assert/strict"
import test from "node:test"
import { Duration, Effect } from "effect"
import {
  acceptHostEvent,
  createClientId,
  hostRealtimeReconnectDelay,
  subscribeRealtimeWake,
  websocketUrl,
} from "./web-transport.js"
import {
  decodeRealtimeHostEvent,
  isHotPathHostEvent,
  tryDecodeRealtimeHostEvent,
} from "@yaade/rpc"

test("websocket URL follows the page origin and carries replay sequence", () => {
  assert.equal(
    websocketUrl({ protocol: "http:", host: "example.test:4747" } as Location, 42),
    "ws://example.test:4747/ws?since=42",
  )
  assert.equal(
    websocketUrl({ protocol: "https:", host: "jet.example" } as Location),
    "wss://jet.example/ws?since=0",
  )
  assert.equal(
    websocketUrl(
      { protocol: "https:", host: "jet.example" } as Location,
      9,
      "client id/with reserved chars",
    ),
    "wss://jet.example/ws?since=9&clientId=client%20id%2Fwith%20reserved%20chars",
  )
})

test("client ids work when randomUUID is unavailable outside secure contexts", () => {
  const id = createClientId({} as Crypto)
  assert.match(id, /^client-[a-z0-9]+-[a-z0-9]+$/)
})

test("protocol gate rejects duplicates and incompatible messages", () => {
  assert.equal(
    acceptHostEvent(4, { protocolVersion: 1, sequence: 5, channel: "x", args: [] }),
    true,
  )
  assert.equal(
    acceptHostEvent(5, { protocolVersion: 1, sequence: 5, channel: "x", args: [] }),
    false,
  )
  assert.equal(
    acceptHostEvent(0, {
      protocolVersion: 2,
      sequence: 1,
      channel: "x",
      args: [],
    } as unknown as Parameters<typeof acceptHostEvent>[1]),
    false,
  )
})

test("reconnect delay doubles then caps at 10s", () => {
  assert.equal(Duration.toMillis(hostRealtimeReconnectDelay(0)), 250)
  assert.equal(Duration.toMillis(hostRealtimeReconnectDelay(1)), 500)
  assert.equal(Duration.toMillis(hostRealtimeReconnectDelay(2)), 1000)
  assert.equal(Duration.toMillis(hostRealtimeReconnectDelay(5)), 8000)
  assert.equal(Duration.toMillis(hostRealtimeReconnectDelay(6)), 10_000)
  assert.equal(Duration.toMillis(hostRealtimeReconnectDelay(20)), 10_000)
})

test("foreground lifecycle wakes reconnect and replaces a backgrounded socket", () => {
  class WakeDocument extends EventTarget {
    visibilityState: DocumentVisibilityState = "visible"
  }
  const doc = new WakeDocument()
  const target = new EventTarget()
  const wakes: boolean[] = []
  const dispose = subscribeRealtimeWake(replace => wakes.push(replace), doc, target)

  target.dispatchEvent(new Event("focus"))
  target.dispatchEvent(new Event("blur"))
  target.dispatchEvent(new Event("focus"))
  doc.visibilityState = "hidden"
  doc.dispatchEvent(new Event("visibilitychange"))
  doc.visibilityState = "visible"
  doc.dispatchEvent(new Event("visibilitychange"))
  target.dispatchEvent(new Event("online"))

  assert.deepEqual(wakes, [true, true, true])
  dispose()
  target.dispatchEvent(new Event("focus"))
  assert.deepEqual(wakes, [true, true, true])
})

test("hot path accepts terminal frames structurally", () => {
  const data = {
    protocolVersion: 1,
    sequence: 9,
    channel: "terminal:data",
    args: ["pty-1", "hello", 3],
  }
  const exit = {
    protocolVersion: 1,
    sequence: 10,
    channel: "terminal:exit",
    args: ["pty-1", 0],
  }
  assert.equal(isHotPathHostEvent(data), true)
  assert.equal(isHotPathHostEvent(exit), true)
  assert.equal(
    isHotPathHostEvent({
      protocolVersion: 1,
      sequence: 1,
      channel: "notifications:event",
      args: [],
    }),
    false,
  )
  assert.equal(tryDecodeRealtimeHostEvent(data)?.channel, "terminal:data")
  assert.equal(tryDecodeRealtimeHostEvent({ nope: true }), undefined)
})

test("cold path still Schema-decodes low-rate events", async () => {
  const decoded = await Effect.runPromise(
    decodeRealtimeHostEvent({
      protocolVersion: 1,
      sequence: 2,
      channel: "workspace:gitBranch",
      args: ["main"],
    }),
  )
  assert.equal(decoded.channel, "workspace:gitBranch")
  assert.deepEqual(decoded.args, ["main"])
})
