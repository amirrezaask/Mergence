import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { createTerminalOutputWriter } from "./terminal-output-writer.js"

test("coalesces multiple enqueues into one write per flush", () => {
  const writes: string[] = []
  const scheduled: Array<() => void> = []
  const writer = createTerminalOutputWriter({
    write: (data, onPainted) => {
      writes.push(data)
      onPainted?.()
    },
    schedule: cb => {
      scheduled.push(cb)
      return scheduled.length
    },
    cancel: () => {},
    // Force rAF path so this test owns the scheduler.
    interactiveMaxChars: 0,
  })

  writer.enqueue("a")
  writer.enqueue("b")
  writer.enqueue("c")
  assert.equal(writes.length, 0)
  assert.equal(scheduled.length, 1)
  scheduled[0]!()
  assert.deepEqual(writes, ["abc"])
})

test("marks cursor-visibility chunks for a single post-paint refresh", () => {
  let refreshes = 0
  const scheduled: Array<() => void> = []
  const writer = createTerminalOutputWriter({
    write: (_data, onPainted) => {
      onPainted?.()
    },
    refreshAfterPaint: () => {
      refreshes += 1
    },
    schedule: cb => {
      scheduled.push(cb)
      return scheduled.length
    },
    cancel: () => {},
    interactiveMaxChars: 0,
  })

  writer.enqueue("hello")
  writer.enqueue("\x1b[?25l")
  writer.enqueue("\x1b[?25h")
  scheduled[0]!()
  assert.equal(refreshes, 1)
})

test("optional maxCharsPerFlush still slices across frames for tests", () => {
  const writes: string[] = []
  const scheduled: Array<() => void> = []
  const writer = createTerminalOutputWriter({
    write: (data, onPainted) => {
      writes.push(data)
      onPainted?.()
    },
    schedule: cb => {
      scheduled.push(cb)
      return scheduled.length
    },
    cancel: () => {},
    maxCharsPerFlush: 4,
    interactiveMaxChars: 0,
  })

  writer.enqueue("abcdefgh")
  assert.equal(scheduled.length, 1)
  scheduled[0]!()
  assert.deepEqual(writes, ["abcd"])
  assert.equal(scheduled.length, 2)
  scheduled[1]!()
  assert.deepEqual(writes, ["abcd", "efgh"])
})

test("parses flood output when animation frames are suspended", () => {
  const writes: string[] = []
  const frames: Array<() => void> = []
  const fallbacks: Array<() => void> = []
  const cancelledFrames: number[] = []
  const writer = createTerminalOutputWriter({
    write: (data, onPainted) => {
      writes.push(data)
      onPainted?.()
    },
    schedule: cb => {
      frames.push(cb)
      return frames.length
    },
    cancel: id => cancelledFrames.push(id),
    scheduleFrameFallback: cb => {
      fallbacks.push(cb)
      return fallbacks.length
    },
    cancelFrameFallback: () => {},
    interactiveMaxChars: 0,
  })

  // fish's Primary Device Attributes query can arrive behind enough startup
  // output to take the flood/rAF path. Background tabs suspend that clock.
  writer.enqueue(`${"x".repeat(1_024)}\x1b[0c`)
  assert.equal(writes.length, 0)
  assert.equal(frames.length, 1)
  assert.equal(fallbacks.length, 1)

  fallbacks[0]!()
  assert.deepEqual(writes, [`${"x".repeat(1_024)}\x1b[0c`])
  assert.deepEqual(cancelledFrames, [1])
})

test("parses terminal queries immediately while the frame clock is inactive", async () => {
  const writes: string[] = []
  let frameCount = 0
  const writer = createTerminalOutputWriter({
    write: (data, onPainted) => {
      writes.push(data)
      onPainted?.()
    },
    schedule: () => {
      frameCount += 1
      return frameCount
    },
    cancel: () => {},
    frameClockActive: () => false,
    interactiveMaxChars: 0,
  })

  writer.enqueue(`${"x".repeat(1_024)}\x1b[0c`)
  await Promise.resolve()
  assert.deepEqual(writes, [`${"x".repeat(1_024)}\x1b[0c`])
  assert.equal(frameCount, 0)
})

test("default flush feeds the full coalesced chunk (no 16KiB starve)", () => {
  const writes: string[] = []
  const scheduled: Array<() => void> = []
  const parsed: number[] = []
  const writer = createTerminalOutputWriter({
    write: (data, onPainted) => {
      writes.push(data)
      onPainted?.()
    },
    onParsed: n => parsed.push(n),
    schedule: cb => {
      scheduled.push(cb)
      return scheduled.length
    },
    cancel: () => {},
    interactiveMaxChars: 0,
  })

  const flood = "x".repeat(64 * 1024)
  writer.enqueue(flood)
  scheduled[0]!()
  assert.equal(writes.length, 1)
  assert.equal(writes[0]!.length, 64 * 1024)
  assert.deepEqual(parsed, [64 * 1024])
})

test("does not gate the next flush on write callback (xterm queues itself)", () => {
  const writes: string[] = []
  const scheduled: Array<() => void> = []
  const pendingCallbacks: Array<() => void> = []
  const writer = createTerminalOutputWriter({
    write: (data, onPainted) => {
      writes.push(data)
      if (onPainted) pendingCallbacks.push(onPainted)
    },
    schedule: cb => {
      scheduled.push(cb)
      return scheduled.length
    },
    cancel: () => {},
    interactiveMaxChars: 0,
  })

  writer.enqueue("one")
  scheduled[0]!()
  assert.equal(writes.length, 1)
  assert.equal(pendingCallbacks.length, 1)

  // More data arrives while xterm is still parsing the first write.
  writer.enqueue("two")
  assert.equal(scheduled.length, 2)
  scheduled[1]!()
  assert.deepEqual(writes, ["one", "two"])

  // Callbacks fire later — still only for ack/paint, not gating.
  pendingCallbacks[0]!()
  pendingCallbacks[1]!()
})

test("flush ignores per-frame cap for attach replay", () => {
  const writes: string[] = []
  const writer = createTerminalOutputWriter({
    write: (data, onPainted) => {
      writes.push(data)
      onPainted?.()
    },
    schedule: () => 1,
    cancel: () => {},
    maxCharsPerFlush: 2,
  })

  writer.enqueue("attach-replay-full")
  writer.flush()
  assert.deepEqual(writes, ["attach-replay-full"])
})

test("flush drains pending bytes without waiting for schedule", () => {
  const writes: string[] = []
  const writer = createTerminalOutputWriter({
    write: (data, onPainted) => {
      writes.push(data)
      onPainted?.()
    },
    schedule: () => 1,
    cancel: () => {},
  })

  writer.enqueue("attach-replay")
  writer.flush()
  assert.deepEqual(writes, ["attach-replay"])
})

test("replay bypasses the live cap and is not acknowledged", () => {
  const replayWrites: string[][] = []
  const parsed: number[] = []
  const writer = createTerminalOutputWriter({
    write: () => assert.fail("replay must use the replay writer"),
    writeReplay: (chunks, onPainted) => {
      replayWrites.push([...chunks])
      onPainted?.()
    },
    onParsed: chars => parsed.push(chars),
    maxPendingChars: 8,
  })

  writer.enqueueReplay("A".repeat(512 * 1024))
  writer.enqueueReplay("B".repeat(512 * 1024))
  writer.flush()

  assert.deepEqual(replayWrites, [["A".repeat(512 * 1024), "B".repeat(512 * 1024)]])
  assert.deepEqual(parsed, [])
})

test("sheds oldest pending when over maxPendingChars", () => {
  const writes: string[] = []
  const scheduled: Array<() => void> = []
  const writer = createTerminalOutputWriter({
    write: (data, onPainted) => {
      writes.push(data)
      onPainted?.()
    },
    schedule: cb => {
      scheduled.push(cb)
      return scheduled.length
    },
    cancel: () => {},
    maxPendingChars: 8,
    interactiveMaxChars: 0,
  })

  writer.enqueue("AAAAAAAA") // 8
  writer.enqueue("BBBB") // shed AAAAAAAA → BBBB
  scheduled[0]!()
  assert.deepEqual(writes, ["BBBB"])
})

test("joins parts without repeated string +=", () => {
  const writes: string[] = []
  const scheduled: Array<() => void> = []
  const writer = createTerminalOutputWriter({
    write: (data, onPainted) => {
      writes.push(data)
      onPainted?.()
    },
    schedule: cb => {
      scheduled.push(cb)
      return scheduled.length
    },
    cancel: () => {},
    interactiveMaxChars: 0,
  })

  writer.enqueue("one")
  writer.enqueue("two")
  writer.enqueue("three")
  scheduled[0]!()
  assert.deepEqual(writes, ["onetwothree"])
})

test("interactive echoes flush on microtask without rAF", async () => {
  const writes: string[] = []
  let rafCalls = 0
  const writer = createTerminalOutputWriter({
    write: (data, onPainted) => {
      writes.push(data)
      onPainted?.()
    },
    schedule: cb => {
      rafCalls += 1
      queueMicrotask(cb)
      return rafCalls
    },
    cancel: () => {},
    maxCharsPerFlush: 32 * 1024,
  })

  writer.enqueue("x")
  assert.equal(rafCalls, 0)
  assert.equal(writes.length, 0)
  await Promise.resolve()
  assert.deepEqual(writes, ["x"])
  assert.equal(rafCalls, 0)
})
