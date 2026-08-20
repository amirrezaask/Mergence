import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "vite-plus/test"
import {
  hookQueueDir,
  listQueuedHooks,
  markQueuedHookRetry,
  removeQueuedHook,
} from "./hook-queue.js"

describe("agent hook queue", () => {
  it("drains and updates queue files through async filesystem operations", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-hook-queue-"))
    try {
      const dir = hookQueueDir(dataDir)
      await fs.promises.mkdir(dir, { recursive: true })
      const file = path.join(dir, "0001.json")
      await fs.promises.writeFile(
        file,
        JSON.stringify({
          payload: { type: "Stop" },
          meta: {
            provider: "claude",
            sessionId: "session-1",
            ingestUrl: "http://127.0.0.1/ingest",
          },
          enqueuedAt: new Date().toISOString(),
          retryCount: 0,
          nextAttemptAt: new Date(0).toISOString(),
        }),
      )

      const queued = await listQueuedHooks(dataDir)
      assert.equal(queued.length, 1)
      assert.equal(queued[0]?.file, file)

      await markQueuedHookRetry(file, new Error("offline"))
      assert.deepEqual(await listQueuedHooks(dataDir), [])

      await removeQueuedHook(file)
      await removeQueuedHook(file)
      assert.deepEqual(await listQueuedHooks(dataDir), [])
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
