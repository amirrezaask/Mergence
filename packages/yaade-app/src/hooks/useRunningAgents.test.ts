import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Schema } from "effect"
import { ToolUseId } from "@yaade/rpc"
import type { AgentRunInfo } from "@yaade/workspace"
import { toRunningAgentSidebarItems } from "./useRunningAgents.js"

const toolUseId = Schema.decodeUnknownSync(ToolUseId)("use-claude")

function run(overrides: Partial<AgentRunInfo> = {}): AgentRunInfo {
  return {
    runId: "run-1",
    launchRequestId: "launch-1",
    generation: 1,
    provider: "claude",
    projectId: "proj-1",
    workspaceId: "ws-1",
    checkoutKey: "main",
    checkoutPath: "/Users/me/dev/yaade",
    title: "  Investigate tiling  ",
    toolUseId: null,
    ptyId: "pty-1",
    nativeSessionId: null,
    processState: "running",
    activityState: "working",
    telemetryState: "connected",
    createdAt: "2026-08-18T10:00:00.000Z",
    startedAt: "2026-08-18T10:00:01.000Z",
    lastActivityAt: null,
    endedAt: null,
    exitCode: null,
    endReason: null,
    telemetryError: null,
    revision: 1,
    ...overrides,
  }
}

describe("toRunningAgentSidebarItems", () => {
  it("maps host runs onto sidebar rows and resolves ToolUse from the PTY", () => {
    const items = toRunningAgentSidebarItems(
      [run()],
      new Map([["pty-1", toolUseId]]),
      new Map([["proj-1", "yaade"]]),
    )

    assert.equal(items.length, 1)
    assert.equal(items[0]?.title, "Investigate tiling")
    assert.equal(items[0]?.toolUseId, toolUseId)
    assert.equal(items[0]?.projectName, "yaade")
    assert.equal(items[0]?.checkoutLabel, "yaade")
    assert.equal(items[0]?.activity, "Working")
    assert.equal(items[0]?.status, "working")
  })

  it("prefers the host ToolUse id over the PTY lookup", () => {
    const bound = Schema.decodeUnknownSync(ToolUseId)("use-bound")
    const items = toRunningAgentSidebarItems(
      [run({ toolUseId: bound })],
      new Map([["pty-1", toolUseId]]),
      new Map(),
    )

    assert.equal(items[0]?.toolUseId, bound)
    assert.equal(items[0]?.projectName, "proj-1")
  })
})
