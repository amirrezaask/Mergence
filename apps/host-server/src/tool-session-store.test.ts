import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { describe, it } from "node:test"
import { Schema } from "effect"
import {
  ProcessToolOutput,
  ProjectTarget,
  ToolUseId,
  ToolUseConflict,
} from "@yaade/rpc"
import { ToolSessionStore, ToolSessionStorageError } from "./tool-session-store.js"

function database(): DatabaseSync {
  return new DatabaseSync(":memory:")
}

function context() {
  return {
    project: ProjectTarget.make({ projectId: "p1", projectPath: "/tmp/project", projectName: "Project" }),
    checkoutKey: "main",
    checkoutPath: "/tmp/project",
    checkoutLabel: "Main",
    managedWorktree: false,
  }
}

function terminalOutput() {
  return ProcessToolOutput.make({
    kind: "process",
    terminalInstanceId: "terminal-1",
    generation: 1,
    processState: "starting",
    activityState: "starting",
    replayAvailable: true,
    truncated: false,
  })
}

describe("ToolSessionStore", () => {
  it("creates a visible session in a fresh database and preserves ordering", () => {
    const db = database()
    const store = new ToolSessionStore(db, "machine-a")
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
    const second = store.createSession("Review")
    assert.deepEqual(store.listSessions().map(session => session.title), ["Session 1", "Review"])
    assert.deepEqual(store.listTabs(second.id).map(tab => tab.title), ["Window 1"])
    assert.equal(store.renameSession(second.id, "Renamed").title, "Renamed")
    db.close()
  })

  it("creates a window for the replacement session after archiving the last session", () => {
    const db = database()
    const store = new ToolSessionStore(db)
    const session = store.listSessions()[0]
    assert.ok(session)
    store.archiveSession(session.id)
    const replacement = store.listSessions()[0]
    assert.ok(replacement)
    assert.equal(store.listTabs(replacement.id).length, 1)
    assert.equal(replacement.activeTabId, store.listTabs(replacement.id)[0]?.id)
    db.close()
  })

  it("round-trips a process ToolUse and enforces active membership", () => {
    const db = database()
    const store = new ToolSessionStore(db)
    const session = store.listSessions()[0]
    assert.ok(session)
    const use = store.createToolUse({
      sessionId: session.id,
      kind: "terminal",
      title: "Shell",
      position: 0,
      context: context(),
      input: { _tag: "TerminalToolInput", kind: "terminal" },
      output: terminalOutput(),
    })
    assert.equal(store.getToolUse(use.id)?.context.checkoutLabel, "Main")
    assert.equal(store.listToolUses(session.id).length, 1)
    assert.equal(store.setActiveToolUse(session.id, use.id).activeToolUseId, use.id)
    assert.throws(
      () => store.setActiveToolUse(session.id, Schema.decodeUnknownSync(ToolUseId)("use-missing")),
      ToolSessionStorageError,
    )
    db.close()
  })

  it("compare-and-set rejects stale revisions and updates output", () => {
    const db = database()
    const store = new ToolSessionStore(db)
    const session = store.listSessions()[0]
    assert.ok(session)
    const use = store.createToolUse({
      sessionId: session.id,
      kind: "terminal",
      title: "Shell",
      position: 0,
      context: context(),
      input: { _tag: "TerminalToolInput", kind: "terminal" },
      output: terminalOutput(),
    })
    const updated = store.compareAndSetToolUse(use.id, use.revision, { status: "running" })
    assert.equal(updated.status, "running")
    assert.throws(
      () => store.compareAndSetToolUse(use.id, use.revision, { status: "failed" }),
      ToolUseConflict,
    )
    db.close()
  })

  it("persists and pages search results", () => {
    const db = database()
    const store = new ToolSessionStore(db)
    const session = store.listSessions()[0]
    assert.ok(session)
    const use = store.createToolUse({
      sessionId: session.id,
      kind: "search",
      title: "Search",
      position: 0,
      context: context(),
      input: { _tag: "SearchToolInput", kind: "search", query: "needle", options: {} },
      output: {
        _tag: "SearchToolOutput",
        kind: "search",
        resultRevision: 1,
        resultCount: 2,
        truncated: false,
        running: false,
      },
    })
    const rows = [0, 1].map(line => ({ path: `src/${line}.ts`, line, column: 1, preview: "needle", ranges: [] }))
    store.replaceSearchResults(use.id, 1, rows)
    assert.deepEqual(store.listSearchResults(use.id, 1, 1, 1).map(result => result.path), ["src/1.ts"])
    db.close()
  })

  it("migrates legacy project sessions idempotently", () => {
    const db = database()
    db.exec(`
      CREATE TABLE project_sessions(
        id TEXT PRIMARY KEY, machine TEXT NOT NULL, title TEXT NOT NULL,
        project_path TEXT NOT NULL, cwd_path TEXT NOT NULL, payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      );
      INSERT INTO project_sessions VALUES('ses-legacy','machine-a','Legacy','/tmp/p','/tmp/p','{}','2026-01-01','2026-01-02',NULL);
    `)
    const first = new ToolSessionStore(db, "machine-a")
    assert.deepEqual(first.listSessions().map(session => session.id), ["ses-legacy"])
    const second = new ToolSessionStore(db, "machine-a")
    assert.equal(second.listSessions().length, 1)
    assert.equal((db.prepare("SELECT version FROM schema_migrations WHERE version=15").get() as { version: number }).version, 15)
    db.close()
  })

  it("migrates project_surface_state search tabs into SearchTool uses", () => {
    const db = database()
    db.exec(`
      CREATE TABLE projects(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE project_surface_state(
        project_id TEXT NOT NULL,
        machine TEXT NOT NULL,
        surface TEXT NOT NULL,
        state_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id, machine, surface)
      );
    `)
    db.prepare(
      "INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES(?,?,?,?,?)",
    ).run("proj-1", "Fixture", "/tmp/fixture", "2026-01-01", "2026-01-01")
    db.prepare(
      "INSERT INTO project_surface_state(project_id,machine,surface,state_json,revision,updated_at) VALUES(?,?,?,?,?,?)",
    ).run(
      "proj-1",
      "machine-a",
      "search",
      JSON.stringify({
        searchTabs: [{
          id: "srch-1",
          query: "needle",
          options: { caseSensitive: true },
          checkoutPath: "/tmp/fixture",
          checkoutKey: "main",
        }],
      }),
      1,
      "2026-01-01",
    )
    const store = new ToolSessionStore(db, "machine-a")
    const session = store.listSessions()[0]
    assert.ok(session)
    const search = store.listToolUses(session.id).find(use => use.kind === "search")
    assert.ok(search)
    assert.equal(search.input.kind, "search")
    if (search.input.kind === "search") {
      assert.equal(search.input.query, "needle")
      assert.equal(search.input.options.caseSensitive, true)
    }
    assert.equal(search.output.kind, "search")
    if (search.output.kind === "search") assert.equal(search.output.resultCount, 0)
    assert.equal((db.prepare("SELECT version FROM schema_migrations WHERE version=16").get() as { version: number }).version, 16)
    db.close()
  })
})
