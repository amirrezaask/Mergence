import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import { LatestRootTaskQueue } from "./latest-root-task-queue.js"

function deferredTask(label: string, events: string[]) {
  return (signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      events.push(`start:${label}`)
      const timer = setTimeout(() => {
        events.push(`finish:${label}`)
        resolve(label)
      }, 25)
      signal.addEventListener("abort", () => {
        clearTimeout(timer)
        events.push(`abort:${label}`)
        reject(signal.reason)
      }, { once: true })
    })
}

describe("LatestRootTaskQueue", () => {
  it("runs only the latest queued task after aborting the active task", async () => {
    const queue = new LatestRootTaskQueue()
    const events: string[] = []
    const first = queue.run("root", deferredTask("first", events))
    const second = queue.run("root", deferredTask("second", events))
    const third = queue.run("root", deferredTask("third", events))

    const results = await Promise.allSettled([first, second, third])
    assert.deepEqual(
      results.map(result => result.status),
      ["rejected", "rejected", "fulfilled"],
    )
    assert.deepEqual(events, ["start:first", "abort:first", "start:third", "finish:third"])
  })

  it("cancels an active task from the caller signal", async () => {
    const queue = new LatestRootTaskQueue()
    const events: string[] = []
    const controller = new AbortController()
    const result = queue.run("root", deferredTask("one", events), controller.signal)
    controller.abort()
    await assert.rejects(() => result, error => {
      assert.equal(error instanceof Error ? error.name : undefined, "AbortError")
      return true
    })
    assert.deepEqual(events, ["start:one", "abort:one"])
  })

  it("allows different roots to run independently", async () => {
    const queue = new LatestRootTaskQueue()
    const events: string[] = []
    const values = await Promise.all([
      queue.run("a", deferredTask("a", events)),
      queue.run("b", deferredTask("b", events)),
    ])
    assert.deepEqual(values.sort(), ["a", "b"])
    assert.equal(events.filter(event => event.startsWith("start:")).length, 2)
  })
})
