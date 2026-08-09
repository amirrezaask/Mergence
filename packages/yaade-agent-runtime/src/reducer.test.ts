import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { AgentEventEnvelope } from "@yaade/agent-protocol"
import { Schema } from "effect"
import {
  reduceAgentThreadEvent,
  replayAgentThreadEvents,
} from "./reducer.js"

const capabilities = {
  input: {
    text: "native",
    images: "unsupported",
    workspaceFiles: "native",
    uploadedFiles: "unsupported",
  },
  threads: {
    load: "unsupported",
    resume: "unsupported",
    fork: "unsupported",
    list: "unsupported",
    delete: "unsupported",
  },
  turns: {
    interrupt: "native",
    queue: "unsupported",
    retry: "unsupported",
    steer: "unsupported",
  },
  output: {
    reasoning: "native",
    plans: "unsupported",
    usage: "native",
    contextWindow: "unsupported",
    cost: "unsupported",
    subagents: "unsupported",
  },
  tools: {
    streaming: "native",
    parallel: "unsupported",
    terminal: "unsupported",
    fileDiffs: "unsupported",
  },
  interaction: {
    permissions: "native",
    structuredInput: "unsupported",
    externalUrlInput: "unsupported",
  },
  configuration: {
    dynamicOptions: "native",
    slashCommands: "unsupported",
  },
}

function event(
  sequence: number,
  eventId: string,
  payload: unknown,
  generation = 1,
): AgentEventEnvelope {
  const occurredAt = new Date(Date.parse("2026-08-09T10:00:00.000Z") + sequence * 1_000)
  return Schema.decodeUnknownSync(AgentEventEnvelope)({
    protocolVersion: 1,
    eventId,
    threadId: "thread-1",
    sequence,
    occurredAt: occurredAt.toISOString(),
    receivedAt: new Date(occurredAt.getTime() + 10).toISOString(),
    connectionGeneration: generation,
    event: payload,
  })
}

const trace = [
  event(1, "event-1", {
    type: "thread.opened",
    projectSessionId: "ses-1",
    providerId: "mock",
    driverId: "mock:canonical",
    cwdUri: "file:///workspace",
    capabilities,
    configuration: [],
  }),
  event(2, "event-2", { type: "turn.started", turnId: "turn-1" }),
  event(3, "event-3", {
    type: "item.started",
    item: {
      type: "assistant-message",
      id: "item-1",
      turnId: "turn-1",
      revision: 1,
      text: "",
      status: "streaming",
    },
  }),
  event(4, "event-4", {
    type: "item.delta",
    itemId: "item-1",
    revision: 2,
    text: "Hello",
  }),
  event(5, "event-5", {
    type: "item.completed",
    item: {
      type: "assistant-message",
      id: "item-1",
      turnId: "turn-1",
      revision: 3,
      text: "Hello",
      status: "completed",
    },
  }),
  event(6, "event-6", { type: "turn.completed", turnId: "turn-1" }),
]

describe("agent thread reducer", () => {
  it("reduces a complete trace deterministically", () => {
    const result = replayAgentThreadEvents(undefined, trace)
    assert.equal(result.status, "applied")
    if (result.status !== "applied") return
    assert.equal(result.snapshot.state.status, "idle")
    assert.equal(result.snapshot.state.lastSequence, 6)
    assert.equal(result.snapshot.state.turns[0]?.status, "completed")
    const item = result.snapshot.state.itemsById["item-1"]
    assert.equal(item?.type, "assistant-message")
    if (item?.type !== "assistant-message") return
    assert.equal(item.text, "Hello")
    assert.equal(item.status, "completed")
  })

  it("produces the same state when replay resumes from a snapshot", () => {
    const prefix = replayAgentThreadEvents(undefined, trace.slice(0, 3))
    assert.equal(prefix.status, "applied")
    if (prefix.status !== "applied") return
    const resumed = replayAgentThreadEvents(prefix.snapshot, trace.slice(3))
    const full = replayAgentThreadEvents(undefined, trace)
    assert.equal(resumed.status, "applied")
    assert.equal(full.status, "applied")
    if (resumed.status !== "applied" || full.status !== "applied") return
    assert.deepEqual(resumed.snapshot, full.snapshot)
  })

  it("ignores duplicate event ids without duplicating timeline items", () => {
    const prefix = replayAgentThreadEvents(undefined, trace.slice(0, 3))
    assert.equal(prefix.status, "applied")
    if (prefix.status !== "applied") return
    const duplicate = reduceAgentThreadEvent(prefix.snapshot, trace[2]!)
    assert.equal(duplicate.status, "ignored")
    if (duplicate.status !== "ignored") return
    assert.equal(duplicate.reason, "duplicate-event")
    assert.equal(duplicate.snapshot.state.itemOrder.length, 1)
  })

  it("rejects sequence gaps", () => {
    const opened = reduceAgentThreadEvent(undefined, trace[0]!)
    assert.equal(opened.status, "applied")
    if (opened.status !== "applied") return
    const result = reduceAgentThreadEvent(opened.snapshot, trace[2]!)
    assert.equal(result.status, "rejected")
    if (result.status !== "rejected") return
    assert.equal(result.violations[0]?.code, "sequence.gap")
  })

  it("rejects output after a turn completes", () => {
    const complete = replayAgentThreadEvents(undefined, trace)
    assert.equal(complete.status, "applied")
    if (complete.status !== "applied") return
    const result = reduceAgentThreadEvent(
      complete.snapshot,
      event(7, "event-7", {
        type: "item.updated",
        item: {
          type: "assistant-message",
          id: "item-1",
          turnId: "turn-1",
          revision: 4,
          text: "too late",
          status: "completed",
        },
      }),
    )
    assert.equal(result.status, "rejected")
    if (result.status !== "rejected") return
    assert.equal(result.violations[0]?.code, "turn.not-running")
  })

  it("round-trips only an advertised provider permission option", () => {
    const waitingTrace = [
      ...trace.slice(0, 2),
      event(3, "permission-requested", {
        type: "action.requested",
        action: {
          type: "permission",
          id: "permission-1",
          turnId: "turn-1",
          createdAt: "2026-08-09T10:00:03.000Z",
          title: "Run command",
          options: [
            {
              id: "native:allow-until-exit",
              decision: "custom",
              label: "Allow until exit",
            },
          ],
        },
      }),
    ]
    const waiting = replayAgentThreadEvents(undefined, waitingTrace)
    assert.equal(waiting.status, "applied")
    if (waiting.status !== "applied") return

    const rejected = reduceAgentThreadEvent(
      waiting.snapshot,
      event(4, "bad-response", {
        type: "action.resolved",
        actionId: "permission-1",
        response: { type: "permission", optionId: "allow-once" },
      }),
    )
    assert.equal(rejected.status, "rejected")
    if (rejected.status !== "rejected") return
    assert.equal(rejected.violations[0]?.code, "permission.option-missing")

    const accepted = reduceAgentThreadEvent(
      waiting.snapshot,
      event(4, "good-response", {
        type: "action.resolved",
        actionId: "permission-1",
        response: {
          type: "permission",
          optionId: "native:allow-until-exit",
        },
      }),
    )
    assert.equal(accepted.status, "applied")
  })

  it("ignores events emitted by a stale connection generation", () => {
    const opened = reduceAgentThreadEvent(
      undefined,
      event(1, "open-generation-2", trace[0]!.event, 2),
    )
    assert.equal(opened.status, "applied")
    if (opened.status !== "applied") return
    const stale = reduceAgentThreadEvent(
      opened.snapshot,
      event(2, "stale-turn", { type: "turn.started", turnId: "turn-1" }, 1),
    )
    assert.equal(stale.status, "ignored")
    if (stale.status !== "ignored") return
    assert.equal(stale.reason, "stale-connection-generation")
  })

  it("clears turn-scoped pending actions when a turn is interrupted", () => {
    const waiting = replayAgentThreadEvents(undefined, [
      ...trace.slice(0, 2),
      event(3, "permission-before-interrupt", {
        type: "action.requested",
        action: {
          type: "permission",
          id: "permission-1",
          turnId: "turn-1",
          createdAt: "2026-08-09T10:00:03.000Z",
          title: "Run command",
          options: [{ id: "deny", decision: "reject-once", label: "Deny" }],
        },
      }),
      event(4, "turn-interrupted", {
        type: "turn.interrupted",
        turnId: "turn-1",
      }),
    ])
    assert.equal(waiting.status, "applied")
    if (waiting.status !== "applied") return
    assert.equal(waiting.snapshot.state.pendingActions.length, 0)
    assert.equal(waiting.snapshot.state.status, "interrupted")
  })

  it("rejects oversized streaming deltas", () => {
    const streaming = replayAgentThreadEvents(undefined, trace.slice(0, 3))
    assert.equal(streaming.status, "applied")
    if (streaming.status !== "applied") return
    const result = reduceAgentThreadEvent(
      streaming.snapshot,
      event(4, "oversized-delta", {
        type: "item.delta",
        itemId: "item-1",
        revision: 2,
        text: "x".repeat(256 * 1024 + 1),
      }),
    )
    assert.equal(result.status, "rejected")
    if (result.status !== "rejected") return
    assert.equal(result.violations[0]?.code, "item.delta-too-large")
  })

  it("bounds pending human actions", () => {
    const opened = reduceAgentThreadEvent(undefined, trace[0]!)
    assert.equal(opened.status, "applied")
    if (opened.status !== "applied") return
    let snapshot = opened.snapshot
    for (let index = 0; index < 64; index += 1) {
      const result = reduceAgentThreadEvent(
        snapshot,
        event(index + 2, `action-${index}`, {
          type: "action.requested",
          action: {
            type: "authentication",
            id: `auth-${index}`,
            createdAt: "2026-08-09T10:00:00.000Z",
            title: "Sign in",
          },
        }),
      )
      assert.equal(result.status, "applied")
      if (result.status !== "applied") return
      snapshot = result.snapshot
    }
    const rejected = reduceAgentThreadEvent(
      snapshot,
      event(66, "action-over-limit", {
        type: "action.requested",
        action: {
          type: "authentication",
          id: "auth-over-limit",
          createdAt: "2026-08-09T10:00:00.000Z",
          title: "Sign in",
        },
      }),
    )
    assert.equal(rejected.status, "rejected")
    if (rejected.status !== "rejected") return
    assert.equal(rejected.violations[0]?.code, "action.limit-exceeded")
  })
})
