import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import {
  projectAgentNotification,
  shouldDeliverDesktopNotification,
} from "./project.js"
import type { AgentEvent } from "../types/events.js"

function ev(partial: Partial<AgentEvent> & Pick<AgentEvent, "id" | "kind">): AgentEvent {
  return {
    schemaVersion: 1,
    provider: "claude",
    occurredAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:00.000Z",
    processId: "pty-1",
    sessionId: "sess-1",
    nativeSessionId: "native-1",
    source: { nativeEventName: partial.kind },
    ...partial,
  }
}

describe("projectAgentNotification", () => {
  it("creates permission notification", () => {
    const n = projectAgentNotification(
      ev({
        id: "p1",
        kind: "permission.requested",
        permission: { id: "x", status: "requested", toolName: "Bash" },
      }),
      { projectName: "yaade", appFocused: true },
    )
    assert.ok(n)
    assert.equal(n?.kind, "permission_required")
    assert.equal(n?.persistent, true)
    assert.ok(!n?.message.includes("rm -rf"))
  })

  it("skips turn.completed when session focused and app focused", () => {
    const n = projectAgentNotification(
      ev({ id: "t1", kind: "turn.completed" }),
      {
        focusedSessionId: "sess-1",
        appFocused: true,
        sessionViewedSinceTurnStart: true,
      },
    )
    assert.equal(n, null)
  })

  it("creates turn.completed when another session focused", () => {
    const n = projectAgentNotification(
      ev({
        id: "codex:_:turn.completed:turn-9:agent-turn-complete",
        kind: "turn.completed",
        provider: "codex",
        turn: { id: "turn-9", nativeId: "turn-9" },
      }),
      { focusedSessionId: "other", appFocused: true, projectName: "yaade" },
    )
    assert.equal(n?.kind, "turn_completed")
    assert.ok(n?.title.includes("completed"))
    assert.equal(n?.sourceEventId, "turn-9")
    assert.equal(n?.providerTurnId, "turn-9")
  })

  it("creates failure and unexpected exit notifications", () => {
    assert.equal(
      projectAgentNotification(ev({ id: "f", kind: "turn.failed" }), {})
        ?.kind,
      "turn_failed",
    )
    assert.equal(
      projectAgentNotification(
        ev({
          id: "x",
          kind: "process.exited",
          metadata: { exitCode: 1, expectedExit: false },
        }),
        {},
      )?.kind,
      "session_terminated",
    )
    assert.equal(
      projectAgentNotification(
        ev({
          id: "ok",
          kind: "process.exited",
          metadata: { exitCode: 0, expectedExit: true },
        }),
        {},
      ),
      null,
    )
  })

  it("desktop delivery rules", () => {
    assert.equal(
      shouldDeliverDesktopNotification(ev({ id: "t", kind: "turn.completed" }), {
        focusedSessionId: "sess-1",
        appFocused: true,
      }),
      false,
    )
    assert.equal(
      shouldDeliverDesktopNotification(ev({ id: "t", kind: "turn.completed" }), {
        focusedSessionId: "sess-1",
        appFocused: false,
      }),
      true,
    )
  })
})
