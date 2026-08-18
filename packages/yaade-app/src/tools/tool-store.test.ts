import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Schema } from "effect"
import { AppSession, SessionTab, SessionTabId, SessionId, ToolUseId, type ToolUse } from "@yaade/rpc"
import { ToolSessionStore } from "./tool-store.js"
import {
  nextRuntimeToolTitle,
  toolUseContextCaption,
  toolUseDisplayTitle,
  toolUsePaneTitle,
  toolUseWorkTitle,
} from "./tool-title.js"

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
  it("uses terminal and Git titles with checkout context", () => {
    const terminal = use()
    assert.equal(toolUseWorkTitle(terminal), "Shell")
    assert.equal(toolUseContextCaption(terminal), "p · Main")
    assert.equal(toolUseDisplayTitle(terminal), "p: Shell")

    const git: ToolUse = {
      ...terminal,
      kind: "git",
      title: "Git History",
      input: { _tag: "GitToolInput", kind: "git" },
      output: { _tag: "GitToolOutput", kind: "git" },
    }
    assert.equal(toolUseDisplayTitle(git), "p: Git History")
  })

  it("uses a terminal's live title", () => {
    const terminal = use()
    const live = nextRuntimeToolTitle(terminal, undefined, "fish · ~/dev/yaade", "terminal")
    assert.equal(toolUseDisplayTitle(terminal, live), "p: fish · ~/dev/yaade")
    assert.equal(toolUsePaneTitle(terminal, live), "fish")

    const cwdOnly = nextRuntimeToolTitle(terminal, undefined, "~/dev/yaade", "terminal")
    assert.equal(toolUsePaneTitle(terminal, cwdOnly), "")
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

  it("keeps membership indexes stable for output-only ToolUse updates", () => {
    const store = new ToolSessionStore()
    store.replace([session()], [use()])
    const before = store.getSnapshot()

    store.apply({
      _tag: "ToolUseUpdated",
      eventId: "event-output-only",
      toolUseId: useId,
      toolUse: {
        ...use(),
        status: "running",
        revision: 2,
        updatedAt: "2026-01-02",
      },
      revision: 2,
      occurredAt: "2026-01-02",
    })

    const after = store.getSnapshot()
    assert.equal(after.useIdsBySession, before.useIdsBySession)
    assert.equal(after.useIdsByTab, before.useIdsByTab)
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

  it("notifies session subscribers for realtime session changes", () => {
    const store = new ToolSessionStore()
    store.replace([session()], [use()])
    let notifications = 0
    const dispose = store.subscribeSession(sessionId, () => { notifications += 1 })
    store.apply({
      _tag: "SessionUpdated",
      eventId: "session-update",
      revision: 2,
      occurredAt: "2026-01-02",
      session: { ...session(), title: "Renamed", revision: 2, updatedAt: "2026-01-02" },
    })
    assert.equal(notifications, 1)
    dispose()
  })

  it("does not let an older snapshot overwrite a realtime update", () => {
    const store = new ToolSessionStore()
    store.replace([session()], [use()])
    const baseline = store.captureRevisions()
    store.apply({
      _tag: "ToolUseUpdated",
      eventId: "newer",
      toolUseId: useId,
      toolUse: { ...use(), title: "Newer", revision: 2, updatedAt: "2026-01-02" },
      revision: 2,
      occurredAt: "2026-01-02",
    })
    store.mergeSnapshot([session()], [use()], [], false, baseline)
    assert.equal(store.getSnapshot().usesById.get(useId)?.title, "Newer")
  })

  it("does not resurrect an archived use from a late update", () => {
    const store = new ToolSessionStore()
    store.replace([session()], [use()])
    store.apply({
      _tag: "ToolUseArchived", eventId: "archive", toolUseId: useId,
      revision: 2, occurredAt: "2026-01-02",
    })
    store.apply({
      _tag: "ToolUseUpdated", eventId: "late", toolUseId: useId,
      toolUse: { ...use(), title: "Late", revision: 3, updatedAt: "2026-01-03" },
      revision: 3, occurredAt: "2026-01-03",
    })
    assert.equal(store.getSnapshot().usesById.get(useId)?.archivedAt, "2026-01-02")
    assert.deepEqual(store.getSnapshot().useIdsBySession.get(sessionId), [])
  })

  it("follows authoritative active-tool changes from another client", () => {
    const store = new ToolSessionStore()
    const tabId = Schema.decodeUnknownSync(SessionTabId)("tab-a")
    const otherId = Schema.decodeUnknownSync(ToolUseId)("use-b")
    const first = { ...use(), tabId }
    const second = { ...use(), id: otherId, tabId, position: 1 }
    const tab = SessionTab.make({
      id: tabId,
      sessionId,
      title: "Window 1",
      position: 0,
      activeToolUseId: first.id,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    })
    store.replace([session()], [first, second], [tab])
    store.selectToolUse(first.id)
    store.apply({
      _tag: "SessionTabUpdated",
      eventId: "tab-focus",
      revision: 2,
      occurredAt: "2026-01-02",
      tab: { ...tab, activeToolUseId: second.id, revision: 2, updatedAt: "2026-01-02" },
    })
    assert.equal(store.getSnapshot().activeToolUseId, second.id)
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
