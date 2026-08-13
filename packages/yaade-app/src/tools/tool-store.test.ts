import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Schema } from "effect"
import { AppSession, SessionId, ToolUseId, type ToolUse } from "@yaade/rpc"
import { ToolSessionStore } from "./tool-store.js"
import { nextRuntimeToolTitle, toolUseDisplayTitle } from "./tool-title.js"

const sessionId = Schema.decodeUnknownSync(SessionId)("ses-a")
const useId = Schema.decodeUnknownSync(ToolUseId)("use-a")

function session(): AppSession {
  return AppSession.make({ id: sessionId, title: "A", position: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01" })
}

function use(): ToolUse {
  return {
    id: useId,
    sessionId,
    kind: "terminal",
    title: "Shell",
    position: 0,
    status: "running",
    context: {
      project: { projectId: "p", projectPath: "/tmp/p", projectName: "p" },
      checkoutKey: "main",
      checkoutPath: "/tmp/p",
      checkoutLabel: "Main",
      managedWorktree: false,
    },
    input: { _tag: "TerminalToolInput", kind: "terminal" },
    inputRevision: 1,
    output: {
      _tag: "ProcessToolOutput",
      kind: "process",
      terminalInstanceId: "term",
      generation: 1,
      processState: "running",
      activityState: "idle",
      replayAvailable: true,
      truncated: false,
    },
    revision: 1,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  }
}

describe("smart ToolUse titles", () => {
  it("uses search queries and promotes agent prompts to live terminal titles", () => {
    const search: ToolUse = {
      ...use(),
      kind: "search",
      title: "Search",
      input: {
        _tag: "SearchToolInput",
        kind: "search",
        query: "updateUseContext",
        options: {},
      },
      output: {
        _tag: "SearchToolOutput",
        kind: "search",
        resultRevision: 1,
        resultCount: 0,
        truncated: false,
        running: false,
      },
    }
    assert.equal(toolUseDisplayTitle(search), "p: updateUseContext")

    const agent: ToolUse = {
      ...use(),
      kind: "agent",
      title: "Agent",
      input: { _tag: "AgentToolInput", kind: "agent", provider: "codex" },
    }
    const prompt = nextRuntimeToolTitle(
      agent,
      undefined,
      "Fix the unfinished session sidebar",
      "prompt",
    )
    assert.equal(
      toolUseDisplayTitle(agent, prompt),
      "p: Fix the unfinished session sidebar",
    )
    const generic = nextRuntimeToolTitle(agent, prompt, "Agent", "terminal")
    assert.equal(generic, prompt)
    const live = nextRuntimeToolTitle(agent, prompt, "codex · yaade", "terminal")
    assert.equal(toolUseDisplayTitle(agent, live), "p: codex · yaade")
  })

  it("uses a terminal's live title", () => {
    const terminal = use()
    const live = nextRuntimeToolTitle(terminal, undefined, "fish · ~/dev/yaade", "terminal")
    assert.equal(toolUseDisplayTitle(terminal, live), "p: fish · ~/dev/yaade")
  })
})

describe("ToolSessionStore browser state", () => {
  it("keeps normalized snapshots stable until a mutation", () => {
    const store = new ToolSessionStore()
    const first = store.getSnapshot()
    store.replace([session()], [use()])
    const second = store.getSnapshot()
    assert.notEqual(first, second)
    assert.equal(store.getSnapshot(), second)
    store.setConnection("connected")
    assert.notEqual(store.getSnapshot(), second)
    assert.equal(store.getSnapshot().usesById.get(useId)?.title, "Shell")
  })

  it("notifies only the affected tool use subscription", () => {
    const store = new ToolSessionStore()
    store.replace([session()], [use()])
    let useNotifications = 0
    let otherNotifications = 0
    const otherId = Schema.decodeUnknownSync(ToolUseId)("use-b")
    const disposeUse = store.subscribeToolUse(useId, () => { useNotifications += 1 })
    const disposeOther = store.subscribeToolUse(otherId, () => { otherNotifications += 1 })
    store.apply({
      _tag: "ToolUseUpdated",
      eventId: "event-1",
      toolUseId: useId,
      toolUse: { ...use(), title: "Updated", revision: 2, updatedAt: "2026-01-02" },
      revision: 2,
      occurredAt: "2026-01-02",
    })
    assert.equal(useNotifications, 1)
    assert.equal(otherNotifications, 0)
    disposeUse()
    disposeOther()
  })

  it("ignores duplicate and older revisions", () => {
    const store = new ToolSessionStore()
    store.replace([session()], [use()])
    store.apply({
      _tag: "ToolUseUpdated", eventId: "event-2", toolUseId: useId,
      toolUse: { ...use(), title: "Newest", revision: 4, updatedAt: "2026-01-04" }, revision: 4, occurredAt: "2026-01-04",
    })
    store.apply({
      _tag: "ToolUseUpdated", eventId: "event-1", toolUseId: useId,
      toolUse: { ...use(), title: "Old", revision: 3, updatedAt: "2026-01-03" }, revision: 3, occurredAt: "2026-01-03",
    })
    assert.equal(store.getSnapshot().usesById.get(useId)?.title, "Newest")
  })

  it("removes archived uses from the visible session list", () => {
    const store = new ToolSessionStore()
    store.replace([session()], [use()])
    store.apply({
      _tag: "ToolUseArchived", eventId: "archive-1", toolUseId: useId,
      revision: 2, occurredAt: "2026-01-02",
    })
    assert.deepEqual(store.getSnapshot().useIdsBySession.get(sessionId), [])
    assert.equal(store.getSnapshot().usesById.get(useId)?.archivedAt, "2026-01-02")
  })

  it("reports revision gaps without replacing the newer snapshot", () => {
    const store = new ToolSessionStore()
    store.replace([session()], [use()])
    const gaps: number[] = []
    store.setRevisionGapHandler(gap => gaps.push(gap.actualRevision))
    store.apply({
      _tag: "ToolUseUpdated", eventId: "event-4", toolUseId: useId,
      toolUse: { ...use(), title: "Future", revision: 4, updatedAt: "2026-01-04" }, revision: 4, occurredAt: "2026-01-04",
    })
    assert.deepEqual(gaps, [4])
    assert.equal(store.getSnapshot().usesById.get(useId)?.title, "Future")
  })
})
