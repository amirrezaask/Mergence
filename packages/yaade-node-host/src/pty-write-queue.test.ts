import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { PtyWriteQueue, PtyWriteQueueOverflow } from "./pty-write-queue.js"

test("user input and terminal responses stay ordered and are never dropped", () => {
  const written: string[] = []
  const queue = new PtyWriteQueue(data => {
    written.push(data)
  })
  queue.enqueue("user-1")
  queue.enqueue("da1")
  queue.enqueue("user-2")
  assert.deepEqual(written, ["user-1", "da1", "user-2"])
})

test("queue overflow fails instead of dropping user input", () => {
  const queue = new PtyWriteQueue(() => undefined, 8)
  assert.throws(() => queue.enqueue("123456789"), PtyWriteQueueOverflow)
})
