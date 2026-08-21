import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { test } from "vite-plus/test"
import { SupervisorPeerWriter, type PeerSocket } from "./supervisor-peer-writer.js"

class FakeSocket extends EventEmitter {
  destroyed = false
  writes: Buffer[] = []
  blockWrites = true

  write(frame: Uint8Array): boolean {
    this.writes.push(Buffer.from(frame))
    return !this.blockWrites
  }

  destroy(): this {
    this.destroyed = true
    return this
  }
}

function peer(socket: FakeSocket): PeerSocket {
  return socket
}

test("three legacy chunks for one terminal queue while write waits for drain", () => {
  const socket = new FakeSocket()
  const writer = new SupervisorPeerWriter(peer(socket), {
    maxBytes: 64,
    maxFrames: 8,
  })
  assert.equal(writer.enqueueLegacyOutput("term-a", Buffer.from("one")), true)
  assert.equal(writer.enqueueLegacyOutput("term-a", Buffer.from("two")), true)
  assert.equal(writer.enqueueLegacyOutput("term-a", Buffer.from("three")), true)
  assert.equal(socket.destroyed, false)
  assert.equal(socket.writes.length, 1)
  assert.equal(writer.pendingFrames, 2)
})

test("drain resumes legacy output in the original enqueue order", () => {
  const socket = new FakeSocket()
  const writer = new SupervisorPeerWriter(peer(socket), {
    maxBytes: 64,
    maxFrames: 8,
  })
  assert.equal(writer.enqueueLegacyOutput("term-a", Buffer.from("one")), true)
  assert.equal(writer.enqueueLegacyOutput("term-a", Buffer.from("two")), true)
  assert.equal(writer.enqueueLegacyOutput("term-a", Buffer.from("three")), true)
  socket.blockWrites = false
  socket.emit("drain")
  assert.deepEqual(
    socket.writes.map((frame) => frame.toString()),
    ["one", "two", "three"],
  )
  assert.equal(writer.pendingFrames, 0)
  assert.equal(socket.destroyed, false)
})

test("hard queue overflow disconnects only that peer", () => {
  const flooded = new FakeSocket()
  const other = new FakeSocket()
  const floodedWriter = new SupervisorPeerWriter(peer(flooded), {
    maxBytes: 8,
    maxFrames: 2,
  })
  const otherWriter = new SupervisorPeerWriter(peer(other), {
    maxBytes: 64,
    maxFrames: 8,
  })
  assert.equal(floodedWriter.enqueueLegacyOutput("term-a", Buffer.from("aaaa")), true)
  assert.equal(floodedWriter.enqueueLegacyOutput("term-a", Buffer.from("bbbb")), true)
  assert.equal(floodedWriter.enqueueLegacyOutput("term-a", Buffer.from("cccc")), false)
  assert.equal(floodedWriter.enqueueLegacyOutput("term-a", Buffer.from("dddd")), false)
  assert.equal(flooded.destroyed, true)
  assert.equal(floodedWriter.isClosed, true)

  assert.equal(otherWriter.enqueueLegacyOutput("term-a", Buffer.from("keep")), true)
  assert.equal(otherWriter.enqueueLegacyOutput("term-b", Buffer.from("also")), true)
  other.blockWrites = false
  other.emit("drain")
  assert.equal(other.destroyed, false)
  assert.deepEqual(
    other.writes.map((frame) => frame.toString()),
    ["keep", "also"],
  )
})

test("reliable responses keep order relative to terminal-control events", () => {
  const socket = new FakeSocket()
  const writer = new SupervisorPeerWriter(peer(socket), {
    maxBytes: 64,
    maxFrames: 8,
  })
  assert.equal(writer.enqueueReliable(Buffer.from("res:write")), true)
  assert.equal(writer.enqueueLegacyOutput("term-a", Buffer.from("out")), true)
  assert.equal(writer.enqueueReliable(Buffer.from("evt:exit")), true)
  socket.blockWrites = false
  socket.emit("drain")
  assert.deepEqual(
    socket.writes.map((frame) => frame.toString()),
    ["res:write", "out", "evt:exit"],
  )
})

test("semantic replacement stays open and does not drop later reliable frames", () => {
  const socket = new FakeSocket()
  const writer = new SupervisorPeerWriter(peer(socket), {
    maxBytes: 64,
    maxFrames: 8,
  })
  assert.equal(writer.enqueueReliable(Buffer.from("hold")), true)
  assert.equal(writer.enqueueSemanticRender("term-a", Buffer.from("snap-1")), true)
  assert.equal(writer.enqueueSemanticRender("term-a", Buffer.from("snap-2")), true)
  assert.equal(writer.enqueueReliable(Buffer.from("res:ok")), true)
  assert.equal(socket.destroyed, false)
  socket.blockWrites = false
  socket.emit("drain")
  assert.deepEqual(
    socket.writes.map((frame) => frame.toString()),
    ["hold", "snap-2", "res:ok"],
  )
})
