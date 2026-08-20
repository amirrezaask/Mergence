import assert from "node:assert/strict"
import { test } from "vite-plus/test"

import { createYaadeApi } from "./create-yaade-api.js"
import type { YaadeHostTransport } from "./transport.js"

test("forwards watched-file kinds and defaults legacy events to changed", () => {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const transport: YaadeHostTransport = {
    invoke: async () => undefined as never,
    on: (channel, callback) => {
      handlers.set(channel, callback)
      return () => handlers.delete(channel)
    },
  }
  const api = createYaadeApi(transport)
  const changes: Array<[string, string]> = []
  api.fs.onFileChanged?.((uri, kind) => changes.push([uri, kind]))

  handlers.get("fs:changed")?.("file:///workspace/new.ts", "created")
  handlers.get("fs:changed")?.("file:///workspace/old.ts", "deleted")
  handlers.get("fs:changed")?.("file:///workspace/existing.ts")

  assert.deepEqual(changes, [
    ["file:///workspace/new.ts", "created"],
    ["file:///workspace/old.ts", "deleted"],
    ["file:///workspace/existing.ts", "changed"],
  ])
})
