import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { AgentEvent } from "../types/events.js"
import {
  filterAgentActivityUiEvents,
  isAgentActivityUiEvent,
} from "./ui-events.js"

function ev(kind: AgentEvent["kind"]): AgentEvent {
  return {
    schemaVersion: 1,
    id: kind,
    kind,
    provider: "cursor",
    occurredAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:00.000Z",
    processId: "p1",
    sessionId: "s1",
    nativeSessionId: "n1",
    source: { nativeEventName: kind },
  }
}

describe("filterAgentActivityUiEvents", () => {
  it("hides process and session lifecycle noise", () => {
    const hidden = [
      ev("process.started"),
      ev("process.exited"),
      ev("session.started"),
      ev("turn.started"),
      ev("prompt.submitted"),
    ]
    const shown = [
      ev("tool.started"),
      ev("permission.requested"),
      ev("session.failed"),
    ]
    for (const e of hidden) assert.equal(isAgentActivityUiEvent(e), false)
    for (const e of shown) assert.equal(isAgentActivityUiEvent(e), true)
    assert.deepEqual(filterAgentActivityUiEvents([...hidden, ...shown]), shown)
  })
})
