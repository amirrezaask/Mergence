import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { GitReviewController } from "./git-review-controller.js"

function deferred(): {
  readonly promise: Promise<void>
  readonly resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>(next => {
    resolve = next
  })
  return { promise, resolve }
}

test("serializes Git mutations and keeps the queue live after failure", async () => {
  const calls: string[] = []
  const first = deferred()
  let shouldFail = true
  const controller = new GitReviewController(
    {
      stage: async (_root, paths) => {
        calls.push(`stage:${paths.join(",")}`)
        if (shouldFail) {
          shouldFail = false
          await first.promise
          throw new Error("stage failed")
        }
      },
      unstage: async (_root, paths) => {
        calls.push(`unstage:${paths.join(",")}`)
      },
      discard: async () => undefined,
      applyPatch: async () => undefined,
    },
    "file:///repo",
  )

  const failed = controller.stage(["a.ts"]).catch(error => error)
  const queued = controller.unstage(["b.ts"])
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ["stage:a.ts"])
  first.resolve()
  assert.equal((await failed).message, "stage failed")
  await queued
  assert.deepEqual(calls, ["stage:a.ts", "unstage:b.ts"])
})

test("invalidating requests makes an in-flight read stale", () => {
  const controller = new GitReviewController(
    {
      stage: async () => undefined,
      unstage: async () => undefined,
      discard: async () => undefined,
      applyPatch: async () => undefined,
    },
    "file:///repo",
  )
  const request = controller.nextRequest()
  assert.equal(controller.isCurrentRequest(request), true)
  controller.invalidateRequests()
  assert.equal(controller.isCurrentRequest(request), false)
})
