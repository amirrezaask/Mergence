import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  claimHqAgentLaunch,
  clearHqAgentLaunch,
  peekHqAgentLaunch,
  queueHqAgentLaunch,
} from "./hq-agent-launch.js"

describe("hq-agent-launch", () => {
  it("queues, peeks by project, and clears", () => {
    clearHqAgentLaunch()
    queueHqAgentLaunch({
      id: "hq-1",
      projectId: "proj-a",
      driverId: "cursor",
      useWorktree: true,
      worktreeName: "feat/x",
    })
    assert.equal(peekHqAgentLaunch("proj-b"), null)
    assert.deepEqual(peekHqAgentLaunch("proj-a"), {
      id: "hq-1",
      projectId: "proj-a",
      driverId: "cursor",
      useWorktree: true,
      worktreeName: "feat/x",
    })
    clearHqAgentLaunch("other")
    assert.ok(peekHqAgentLaunch("proj-a"))
    clearHqAgentLaunch("hq-1")
    assert.equal(peekHqAgentLaunch("proj-a"), null)
  })

  it("claims each intent id once until re-queued", () => {
    clearHqAgentLaunch()
    queueHqAgentLaunch({
      id: "hq-2",
      projectId: "proj-a",
      driverId: "codex",
    })
    assert.equal(claimHqAgentLaunch("hq-2"), true)
    assert.equal(claimHqAgentLaunch("hq-2"), false)
    queueHqAgentLaunch({
      id: "hq-2",
      projectId: "proj-a",
      driverId: "codex",
    })
    assert.equal(claimHqAgentLaunch("hq-2"), true)
  })
})
