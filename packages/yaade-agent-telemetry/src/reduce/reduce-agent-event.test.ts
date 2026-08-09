import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  reduceAgentEvent,
  clearAgentSessionUnread,
  publicAgentSnapshot,
} from "../reduce/reduce-agent-event.js"
import type { AgentEvent } from "../types/events.js"
import type { AgentDriverCapabilities } from "../types/driver.js"

const CAPS: AgentDriverCapabilities = {
  sessionLifecycle: true,
  promptLifecycle: true,
  turnLifecycle: "native",
  toolLifecycle: true,
  permissions: true,
  subagents: true,
  compaction: true,
  fileEvents: "native",
}

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

describe("reduceAgentEvent", () => {
  it("starts a session from process.started", () => {
    const snap = reduceAgentEvent(
      undefined,
      ev({ id: "e1", kind: "process.started", nativeProcessId: 42 }),
      { capabilities: CAPS },
    )
    assert.equal(snap.status, "starting")
    assert.equal(snap.process.running, true)
    assert.equal(snap.process.pid, 42)
    assert.equal(snap.capabilities.toolLifecycle, true)
  })

  it("starts a turn and tracks duration timestamps", () => {
    let snap = reduceAgentEvent(
      undefined,
      ev({ id: "e0", kind: "session.started" }),
      { capabilities: CAPS },
    )
    snap = reduceAgentEvent(
      snap,
      ev({
        id: "e1",
        kind: "turn.started",
        turn: { id: "t1" },
        occurredAt: "2026-01-01T00:00:10.000Z",
        receivedAt: "2026-01-01T00:00:10.000Z",
      }),
    )
    assert.equal(snap.status, "working")
    assert.equal(snap.counts.turns, 1)
    assert.equal(snap.currentTurn?.id, "t1")
  })

  it("handles concurrent tools", () => {
    let snap = reduceAgentEvent(
      undefined,
      ev({ id: "s", kind: "session.started" }),
      { capabilities: CAPS },
    )
    snap = reduceAgentEvent(
      snap,
      ev({
        id: "t1s",
        kind: "tool.started",
        tool: {
          id: "tool-a",
          name: "Read",
          category: "file_read",
          status: "running",
          startedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    )
    snap = reduceAgentEvent(
      snap,
      ev({
        id: "t2s",
        kind: "tool.started",
        tool: {
          id: "tool-b",
          name: "Bash",
          category: "shell",
          status: "running",
          startedAt: "2026-01-01T00:00:01.000Z",
        },
      }),
    )
    assert.equal(snap.status, "running_tool")
    assert.equal(snap.counts.runningTools, 2)
    snap = reduceAgentEvent(
      snap,
      ev({
        id: "t1c",
        kind: "tool.completed",
        tool: {
          id: "tool-a",
          name: "Read",
          category: "file_read",
          status: "completed",
        },
      }),
    )
    assert.equal(snap.status, "running_tool")
    assert.equal(snap.counts.runningTools, 1)
    snap = reduceAgentEvent(
      snap,
      ev({
        id: "t2c",
        kind: "tool.completed",
        tool: {
          id: "tool-b",
          name: "Bash",
          category: "shell",
          status: "completed",
        },
      }),
    )
    assert.equal(snap.status, "working")
    assert.equal(snap.counts.runningTools, 0)
  })

  it("increments failed tool count", () => {
    let snap = reduceAgentEvent(
      undefined,
      ev({ id: "s", kind: "session.started" }),
      { capabilities: CAPS },
    )
    snap = reduceAgentEvent(
      snap,
      ev({
        id: "ts",
        kind: "tool.started",
        tool: {
          id: "t",
          name: "Bash",
          category: "shell",
          status: "running",
        },
      }),
    )
    snap = reduceAgentEvent(
      snap,
      ev({
        id: "tf",
        kind: "tool.failed",
        tool: {
          id: "t",
          name: "Bash",
          category: "shell",
          status: "failed",
        },
      }),
    )
    assert.equal(snap.counts.failedTools, 1)
    assert.equal(snap.status, "working")
  })

  it("handles permission request and resolution", () => {
    let snap = reduceAgentEvent(
      undefined,
      ev({ id: "s", kind: "session.started" }),
      { capabilities: CAPS },
    )
    snap = reduceAgentEvent(
      snap,
      ev({
        id: "p1",
        kind: "permission.requested",
        permission: { id: "perm-1", status: "requested", toolName: "Bash" },
      }),
    )
    assert.equal(snap.status, "waiting_for_permission")
    assert.equal(snap.attention?.kind, "permission_required")
    assert.equal(snap.unread.count, 1)
    snap = reduceAgentEvent(
      snap,
      ev({
        id: "p2",
        kind: "permission.resolved",
        permission: { id: "perm-1", status: "allowed" },
      }),
    )
    assert.equal(snap.status, "working")
    assert.equal(snap.attention, undefined)
  })

  it("completes and fails turns with unread", () => {
    let snap = reduceAgentEvent(
      undefined,
      ev({ id: "s", kind: "session.started" }),
      { capabilities: CAPS },
    )
    snap = reduceAgentEvent(
      snap,
      ev({ id: "tc", kind: "turn.completed" }),
    )
    assert.equal(snap.status, "waiting_for_user")
    assert.equal(snap.counts.completedTurns, 1)
    assert.equal(snap.unread.count, 1)
    snap = reduceAgentEvent(
      snap,
      ev({ id: "tf", kind: "turn.failed" }),
    )
    assert.equal(snap.status, "failed")
    assert.equal(snap.counts.failedTurns, 1)
  })

  it("marks unexpected process exit as terminated", () => {
    let snap = reduceAgentEvent(
      undefined,
      ev({ id: "ps", kind: "process.started" }),
      { capabilities: CAPS },
    )
    snap = reduceAgentEvent(
      snap,
      ev({
        id: "pe",
        kind: "process.exited",
        metadata: { exitCode: 1, expectedExit: false },
      }),
    )
    assert.equal(snap.status, "terminated")
    assert.equal(snap.attention?.kind, "session_terminated")
  })

  it("ignores duplicate event ids", () => {
    let snap = reduceAgentEvent(
      undefined,
      ev({ id: "dup", kind: "turn.completed" }),
      { capabilities: CAPS },
    )
    assert.equal(snap.counts.completedTurns, 1)
    assert.equal(snap.unread.count, 1)
    snap = reduceAgentEvent(
      snap,
      ev({ id: "dup", kind: "turn.completed" }),
    )
    assert.equal(snap.counts.completedTurns, 1)
    assert.equal(snap.unread.count, 1)
  })

  it("dedupes touched files by path", () => {
    let snap = reduceAgentEvent(
      undefined,
      ev({ id: "s", kind: "session.started" }),
      { capabilities: CAPS },
    )
    snap = reduceAgentEvent(
      snap,
      ev({
        id: "f1",
        kind: "file.touched",
        file: { path: "a.ts", operation: "modify" },
      }),
    )
    snap = reduceAgentEvent(
      snap,
      ev({
        id: "f2",
        kind: "file.touched",
        file: { path: "a.ts", operation: "read" },
      }),
    )
    assert.equal(snap.files.length, 1)
    assert.equal(snap.files[0]?.lastOperation, "read")
    assert.equal(snap.counts.touchedFiles, 1)
  })

  it("clears unread without dropping permission attention incorrectly", () => {
    let snap = reduceAgentEvent(
      undefined,
      ev({
        id: "p",
        kind: "permission.requested",
        permission: { id: "x", status: "requested" },
      }),
      { capabilities: CAPS },
    )
    snap = clearAgentSessionUnread(snap)
    assert.equal(snap.unread.count, 0)
    assert.equal(snap.attention?.kind, "permission_required")
  })

  it("strips internal state for public snapshots", () => {
    const snap = reduceAgentEvent(
      undefined,
      ev({ id: "s", kind: "session.started" }),
      { capabilities: CAPS },
    )
    const pub = publicAgentSnapshot(snap)
    assert.equal("_internal" in pub, false)
  })

  it("session.ended → completed", () => {
    let snap = reduceAgentEvent(
      undefined,
      ev({ id: "s", kind: "session.started" }),
      { capabilities: CAPS },
    )
    snap = reduceAgentEvent(
      snap,
      ev({ id: "e", kind: "session.ended" }),
    )
    assert.equal(snap.status, "completed")
  })
})
