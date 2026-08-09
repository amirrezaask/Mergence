import assert from "node:assert/strict"
import { test } from "node:test"
import { createYaadeApi } from "./create-yaade-api.js"
import type { YaadeHostTransport } from "./transport.js"

test("forwards only schema-valid agent-runtime events", () => {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const transport: YaadeHostTransport = {
    invoke: async () => undefined as never,
    on: (channel, callback) => {
      handlers.set(channel, callback)
      return () => handlers.delete(channel)
    },
  }
  const api = createYaadeApi(transport)
  const received: string[] = []
  api.agentRuntime?.onEvent(event => received.push(event.event.type))
  handlers.get("agentRuntime:event")?.({
    protocolVersion: 1,
    eventId: "event-1",
    threadId: "thread-1",
    sequence: 1,
    occurredAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:00.000Z",
    connectionGeneration: 1,
    event: {
      type: "thread.opened",
      projectSessionId: "ses-1",
      providerId: "mock",
      driverId: "mock:canonical",
      cwdUri: "file:///tmp",
      capabilities: {
        input: { text: "native", images: "unsupported", workspaceFiles: "unsupported", uploadedFiles: "unsupported" },
        threads: { load: "unsupported", resume: "unsupported", fork: "unsupported", list: "unsupported", delete: "unsupported" },
        turns: { interrupt: "native", queue: "unsupported", retry: "unsupported", steer: "unsupported" },
        output: { reasoning: "unsupported", plans: "unsupported", usage: "unsupported", contextWindow: "unsupported", cost: "unsupported", subagents: "unsupported" },
        tools: { streaming: "unsupported", parallel: "unsupported", terminal: "unsupported", fileDiffs: "unsupported" },
        interaction: { permissions: "unsupported", structuredInput: "unsupported", externalUrlInput: "unsupported" },
        configuration: { dynamicOptions: "unsupported", slashCommands: "unsupported" },
      },
      configuration: [],
    },
  })
  handlers.get("agentRuntime:event")?.({ type: "bad" })
  assert.deepEqual(received, ["thread.opened"])
})

test("forwards a validated protocol replay gap to agent-runtime clients", () => {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const transport: YaadeHostTransport = {
    invoke: async () => undefined as never,
    on: (channel, callback) => {
      handlers.set(channel, callback)
      return () => handlers.delete(channel)
    },
  }
  const api = createYaadeApi(transport)
  const received: Array<[number, number]> = []
  api.agentRuntime?.onReplayGap((floor, lastSequence) => received.push([floor, lastSequence]))
  handlers.get("protocol:replay-gap")?.(16, 22)
  handlers.get("protocol:replay-gap")?.("bad", 22)
  assert.deepEqual(received, [[16, 22]])
})
