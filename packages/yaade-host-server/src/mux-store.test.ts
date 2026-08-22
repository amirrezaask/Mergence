import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { describe, it } from "vite-plus/test"
import { Schema } from "effect"
import {
  TerminalOutput,
  SessionTabConflict,
  MuxTerminalId,
  TerminalConflict,
} from "@yaade/rpc"
import { MuxSessionStore, MuxSessionStorageError } from "./mux-store.js"

function database(): DatabaseSync {
  return new DatabaseSync(":memory:")
}


function terminalOutput() {
  return TerminalOutput.make({
    kind: "process",
    terminalInstanceId: "terminal-1",
    generation: 1,
    processState: "starting",
    activityState: "starting",
    replayAvailable: true,
    truncated: false,
  })
}

describe("MuxSessionStore", () => {
  it("creates a visible session in a fresh database and preserves ordering", () => {
    const db = database()
    const store = new MuxSessionStore(db, "machine-a")
    const first = store.listSessions()[0]
    assert.ok(first)
    assert.equal(first.title, "Session 1")
    const firstTab = store.listTabs(first.id)[0]
    assert.ok(firstTab)
    assert.equal(first.activeTabId, firstTab.id)
    const secondTab = store.createTab(first.id, "Logs")
    assert.deepEqual(store.listTabs(first.id).map(tab => tab.title), ["Window 1", "Logs"])
    const renamedTab = store.renameTab(secondTab.id, "Builds")
    assert.equal(renamedTab.title, "Builds")
    assert.equal(renamedTab.revision, (secondTab.revision ?? 1) + 1)
    const layoutJson = JSON.stringify({ version: 1, tree: { root: null } })
    const savedTab = store.saveTabLayout(secondTab.id, layoutJson)
    assert.equal(savedTab.layoutJson, layoutJson)
    assert.equal(savedTab.revision, (renamedTab.revision ?? 1) + 1)
    assert.throws(
      () => store.saveTabLayout(secondTab.id, "stale", renamedTab.revision),
      SessionTabConflict,
    )
    const second = store.createSession("Review")
    assert.deepEqual(store.listSessions().map(session => session.title), ["Session 1", "Review"])
    assert.deepEqual(store.listTabs(second.id).map(tab => tab.title), ["Window 1"])
    assert.equal(store.renameSession(second.id, "Renamed").title, "Renamed")
    db.close()
  })

  it("creates a window for the replacement session after archiving the last session", () => {
    const db = database()
    const store = new MuxSessionStore(db)
    const session = store.listSessions()[0]
    assert.ok(session)
    store.archiveSession(session.id)
    const replacement = store.listSessions()[0]
    assert.ok(replacement)
    assert.equal(store.listTabs(replacement.id).length, 1)
    assert.equal(replacement.activeTabId, store.listTabs(replacement.id)[0]?.id)
    db.close()
  })

  it("round-trips a process MuxTerminal and enforces active membership", () => {
    const db = database()
    const store = new MuxSessionStore(db)
    const session = store.listSessions()[0]
    assert.ok(session)
    const terminal = store.createMuxTerminal({
      sessionId: session.id,
      kind: "terminal",
      title: "Shell",
      position: 0,
      input: { _tag: "TerminalInput", kind: "terminal" },
      output: terminalOutput(),
    })
    assert.equal(store.listMuxTerminals(session.id).length, 1)
    assert.equal(store.setActiveMuxTerminal(session.id, terminal.id).activeMuxTerminalId, terminal.id)
    assert.throws(
      () => store.setActiveMuxTerminal(session.id, Schema.decodeUnknownSync(MuxTerminalId)("term-missing")),
      MuxSessionStorageError,
    )
    db.close()
  })

  it("archives a focused terminal and clears persisted focus pointers", () => {
    const db = database()
    const store = new MuxSessionStore(db)
    const session = store.listSessions()[0]
    assert.ok(session)
    const terminal = store.createMuxTerminal({
      sessionId: session.id,
      kind: "terminal",
      title: "Shell",
      position: 0,
      input: { _tag: "TerminalInput", kind: "terminal" },
      output: terminalOutput(),
    })
    store.setActiveMuxTerminal(session.id, terminal.id)
    store.archiveMuxTerminal(terminal.id)
    assert.equal(store.getSession(session.id)?.activeMuxTerminalId, undefined)
    const tab = store.listTabs(session.id)[0]
    assert.equal(tab?.activeMuxTerminalId, undefined)
    db.close()
  })

  it("rejects incomplete reorder commands and versions accepted reorders", () => {
    const db = database()
    const store = new MuxSessionStore(db)
    const session = store.listSessions()[0]
    assert.ok(session)
    const first = store.createMuxTerminal({
      sessionId: session.id,
      kind: "terminal",
      title: "First",
      position: 0,
      input: { _tag: "TerminalInput", kind: "terminal" },
      output: terminalOutput(),
    })
    const second = store.createMuxTerminal({
      sessionId: session.id,
      kind: "terminal",
      title: "Second",
      position: 1,
      input: { _tag: "TerminalInput", kind: "terminal" },
      output: terminalOutput(),
    })
    assert.throws(
      () => store.reorderMuxTerminals(session.id, [first.id]),
      MuxSessionStorageError,
    )
    const reordered = store.reorderMuxTerminals(session.id, [second.id, first.id])
    assert.deepEqual(reordered.map(terminal => terminal.id), [second.id, first.id])
    assert.equal(reordered[0]?.revision, 2)
    db.close()
  })

  it("compare-and-set rejects stale revisions and updates output", () => {
    const db = database()
    const store = new MuxSessionStore(db)
    const session = store.listSessions()[0]
    assert.ok(session)
    const terminal = store.createMuxTerminal({
      sessionId: session.id,
      kind: "terminal",
      title: "Shell",
      position: 0,
      input: { _tag: "TerminalInput", kind: "terminal" },
      output: terminalOutput(),
    })
    const updated = store.compareAndSetMuxTerminal(terminal.id, terminal.revision, { status: "running" })
    assert.equal(updated.status, "running")
    assert.throws(
      () => store.compareAndSetMuxTerminal(terminal.id, terminal.revision, { status: "failed" }),
      TerminalConflict,
    )
    db.close()
  })

})
