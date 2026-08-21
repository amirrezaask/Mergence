import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  ClientSocketWriter,
  WEBSOCKET_OPEN,
  type ClientSocketSink,
  type SocketWriterCloseInfo,
} from "./client-socket-writer.js"

class FakeSink implements ClientSocketSink {
  readyState = WEBSOCKET_OPEN
  bufferedAmount = 0
  sent: Array<string | Uint8Array> = []
  closed: { code?: number; reason?: string } | null = null
  terminated = false
  hold = false
  private pending: Array<{ data: string | Uint8Array; cb?: (error?: Error) => void }> = []

  send(data: string | Uint8Array, cb?: (error?: Error) => void): void {
    if (this.hold) {
      this.pending.push({ data, cb })
      this.bufferedAmount += typeof data === "string" ? data.length : data.byteLength
      return
    }
    this.sent.push(data)
    cb?.()
  }

  release(): void {
    this.hold = false
    const queued = this.pending.splice(0)
    for (const item of queued) {
      this.sent.push(item.data)
      this.bufferedAmount = 0
      item.cb?.()
    }
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
    this.readyState = 3
  }

  terminate(): void {
    this.terminated = true
    this.readyState = 3
  }
}

test("normal typing keeps the socket open and preserves chunk order", () => {
  const sink = new FakeSink()
  const writer = new ClientSocketWriter(sink)
  for (const chunk of ["a", "b", "c", "d", "e"]) {
    assert.equal(writer.enqueueLegacyOutput("term-a", chunk), true)
  }
  assert.equal(writer.isClosed, false)
  assert.deepEqual(sink.sent, ["a", "b", "c", "d", "e"])
})

test("burst output queues while a send is in flight and flushes in order", () => {
  const sink = new FakeSink()
  sink.hold = true
  const writer = new ClientSocketWriter(sink)
  assert.equal(writer.enqueueLegacyOutput("term-a", "one"), true)
  assert.equal(writer.enqueueLegacyOutput("term-a", "two"), true)
  assert.equal(writer.enqueueLegacyOutput("term-a", "three"), true)
  assert.equal(writer.isClosed, false)
  assert.equal(sink.sent.length, 0)
  assert.equal(writer.pendingFrames, 2)
  sink.release()
  assert.deepEqual(sink.sent, ["one", "two", "three"])
  assert.equal(writer.pendingFrames, 0)
})

test("repeated typing while the socket is busy does not close the connection", () => {
  const sink = new FakeSink()
  sink.hold = true
  const writer = new ClientSocketWriter(sink)
  const chunks = Array.from({ length: 80 }, (_, index) => `k${index}`)
  for (const chunk of chunks) {
    assert.equal(writer.enqueueLegacyOutput("term-a", chunk), true)
  }
  assert.equal(writer.isClosed, false)
  assert.equal(sink.closed, null)
  sink.release()
  assert.deepEqual(sink.sent, chunks)
  assert.equal(writer.isClosed, false)
})

test("true slow consumers close only after hard overflow", () => {
  const sink = new FakeSink()
  sink.hold = true
  const closes: SocketWriterCloseInfo[] = []
  const writer = new ClientSocketWriter(sink, {
    limits: { legacyMaxFrames: 2, legacyMaxBytes: 16 },
    onClose: (info) => closes.push(info),
  })
  assert.equal(writer.enqueueLegacyOutput("term-a", "one"), true)
  assert.equal(writer.enqueueLegacyOutput("term-a", "two"), true)
  assert.equal(writer.enqueueLegacyOutput("term-a", "three"), false)
  assert.equal(writer.enqueueLegacyOutput("term-a", "four"), false)
  assert.equal(writer.isClosed, true)
  assert.equal(sink.closed?.code, 1013)
  assert.equal(sink.closed?.reason, "legacy mailbox overflow")
  assert.equal(closes.length, 1)
  assert.equal(closes[0]?.terminalId, "term-a")
})

test("reliable overflow closes the socket", () => {
  const sink = new FakeSink()
  sink.hold = true
  const writer = new ClientSocketWriter(sink, {
    limits: { reliableMaxFrames: 2, reliableMaxBytes: 16 },
  })
  assert.equal(writer.enqueueReliable("a"), true)
  assert.equal(writer.enqueueReliable("b"), true)
  assert.equal(writer.enqueueReliable("c"), false)
  assert.equal(writer.enqueueReliable("d"), false)
  assert.equal(sink.closed?.reason, "reliable mailbox overflow")
})

test("semantic replacement marks resync and does not close", () => {
  const sink = new FakeSink()
  sink.hold = true
  const writer = new ClientSocketWriter(sink)
  assert.equal(writer.enqueueReliable("hold"), true)
  assert.equal(writer.enqueueSemanticRender("term-a", "snap-1"), true)
  assert.equal(writer.enqueueSemanticRender("term-a", "snap-2"), true)
  assert.equal(writer.enqueueReliable("hello"), true)
  assert.equal(writer.isClosed, false)
  assert.deepEqual(writer.consumeResyncRequired(), ["term-a"])
  sink.release()
  assert.deepEqual(sink.sent, ["hold", "snap-2", "hello"])
  assert.equal(sink.closed, null)
})
