import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Schema } from "effect"
import {
  AgentCommandEnvelope,
  AgentEventEnvelope,
  AgentThreadSnapshot,
} from "./index.js"

const capabilities = {
  input: {
    text: "native",
    images: "unsupported",
    workspaceFiles: "native",
    uploadedFiles: "unsupported",
  },
  threads: {
    load: "unsupported",
    resume: "native",
    fork: "unsupported",
    list: "native",
    delete: "unsupported",
  },
  turns: {
    interrupt: "native",
    queue: "unsupported",
    retry: "unknown",
    steer: "unsupported",
  },
  output: {
    reasoning: "native",
    plans: "emulated",
    usage: "native",
    contextWindow: "unknown",
    cost: "unsupported",
    subagents: "unsupported",
  },
  tools: {
    streaming: "native",
    parallel: "native",
    terminal: "emulated",
    fileDiffs: "native",
  },
  interaction: {
    permissions: "native",
    structuredInput: "native",
    externalUrlInput: "unsupported",
  },
  configuration: {
    dynamicOptions: "native",
    slashCommands: "unknown",
  },
}

describe("interactive agent protocol schemas", () => {
  it("round-trips a command while preserving provider action option ids", () => {
    const decoded = Schema.decodeUnknownSync(AgentCommandEnvelope)({
      protocolVersion: 1,
      commandId: "cmd-1",
      threadId: "thread-1",
      issuedAt: "2026-08-09T10:00:00.000Z",
      expectedRevision: 8,
      command: {
        type: "action.respond",
        actionId: "action-1",
        response: {
          type: "permission",
          optionId: "provider:allow-until-exit",
        },
      },
    })

    assert.equal(decoded.command.type, "action.respond")
    if (decoded.command.type !== "action.respond") return
    assert.equal(decoded.command.response.type, "permission")
    if (decoded.command.response.type !== "permission") return
    assert.equal(
      decoded.command.response.optionId,
      "provider:allow-until-exit",
    )
    assert.deepEqual(
      Schema.encodeSync(AgentCommandEnvelope)(decoded),
      JSON.parse(JSON.stringify(decoded)),
    )
  })

  it("decodes a canonical opened event with separate provider and driver ids", () => {
    const decoded = Schema.decodeUnknownSync(AgentEventEnvelope)({
      protocolVersion: 1,
      eventId: "event-1",
      threadId: "thread-1",
      sequence: 1,
      occurredAt: "2026-08-09T10:00:00.000Z",
      receivedAt: "2026-08-09T10:00:00.010Z",
      connectionGeneration: 1,
      event: {
        type: "thread.opened",
        projectSessionId: "ses-1",
        providerId: "codex",
        driverId: "codex:app-server",
        providerSessionId: "native-thread-42",
        cwdUri: "file:///workspace",
        capabilities,
        configuration: [],
      },
    })

    assert.equal(decoded.event.type, "thread.opened")
    if (decoded.event.type !== "thread.opened") return
    assert.equal(decoded.event.providerId, "codex")
    assert.equal(decoded.event.driverId, "codex:app-server")
  })

  it("round-trips a durable snapshot independently of connection state", () => {
    const decoded = Schema.decodeUnknownSync(AgentThreadSnapshot)({
      protocolVersion: 1,
      reducerVersion: 1,
      seenEventIds: ["event-1"],
      state: {
        id: "thread-1",
        projectSessionId: "ses-1",
        providerId: "mock",
        driverId: "mock:canonical",
        cwdUri: "file:///workspace",
        status: "idle",
        capabilities,
        configuration: [],
        turns: [],
        itemsById: {},
        itemOrder: [],
        pendingActions: [],
        lastSequence: 1,
        revision: 1,
        connectionGeneration: 1,
        createdAt: "2026-08-09T10:00:00.000Z",
        updatedAt: "2026-08-09T10:00:00.000Z",
      },
    })

    assert.equal(decoded.state.lastSequence, 1)
    assert.deepEqual(
      Schema.encodeSync(AgentThreadSnapshot)(decoded),
      JSON.parse(JSON.stringify(decoded)),
    )
  })
})
