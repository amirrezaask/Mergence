import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, it, beforeEach, afterEach } from "node:test"
import {
  MAX_EDITOR_RECOVERY_BUFFER_BYTES,
  MAX_EDITOR_RECOVERY_SESSION_BYTES,
} from "@yaade/rpc"
import {
  EditorRecoveryQuotaError,
  ProjectDatabase,
  type SessionRoster,
} from "./persistence.js"

function tempDbPath(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-persist-"))
  return { dir, dbPath: path.join(dir, "jet.sqlite3") }
}

describe("ProjectDatabase session roster", () => {
  let dir: string
  let dbPath: string
  let db: ProjectDatabase

  beforeEach(() => {
    ;({ dir, dbPath } = tempDbPath())
    db = new ProjectDatabase(dbPath)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("round-trips replace + get", () => {
    const project = db.addProject(dir, "fixture")
    const roster: SessionRoster = {
      version: 2,
      sessions: [
        {
          tabId: "yaade:terminal:a",
          cwdRootUri: `file://${dir}`,
          label: "Codex",
          launchCommand: "codex",
          launchArgs: ["-c", "notify=[\"bridge\"]"],
          ptyId: "term-1",
          status: "running",
          customLabel: "Codex",
          agentId: "codex",
          agentTitle: "Review session persistence",
          agentDriverId: "codex:cli",
          hasUserInput: true,
          hasMeaningfulOutput: true,
          lastActivityAt: "2026-07-28T00:00:00.000Z",
        },
      ],
      modal: { tabId: "yaade:terminal:a", sessionMode: "terminal" },
    }
    const saved = db.replaceSessionRoster(roster)
    assert.equal(saved.sessions.length, 1)
    assert.equal(saved.sessions[0]?.tabId, "yaade:terminal:a")
    assert.equal(saved.sessions[0]?.ptyId, undefined)
    assert.equal(saved.sessions[0]?.hasUserInput, true)
    assert.equal(saved.sessions[0]?.hasMeaningfulOutput, true)
    assert.equal(saved.modal?.sessionMode, "terminal")
    assert.deepEqual(db.getSessionRoster(), saved)

    const row = db.raw()
      .prepare(
        "SELECT project_id, agent_title, has_user_input, has_meaningful_output FROM session_roster_entries WHERE tab_id=?",
      )
      .get("yaade:terminal:a") as {
        project_id: string | null
        agent_title: string | null
        has_user_input: number
        has_meaningful_output: number
      }
    assert.equal(row.project_id, project.id)
    assert.equal(row.agent_title, "Review session persistence")
    assert.equal(row.has_user_input, 1)
    assert.equal(row.has_meaningful_output, 1)
  })

  it("replace clears previous entries and modal", () => {
    db.replaceSessionRoster({
      version: 2,
      sessions: [
        {
          tabId: "yaade:terminal:old",
          cwdRootUri: "file:///tmp/old",
          label: "Old Codex",
          status: "running",
          launchCommand: "codex",
          agentId: "codex",
        },
      ],
      modal: { tabId: "yaade:terminal:old", sessionMode: "agent" },
    })
    const next = db.replaceSessionRoster({
      version: 2,
      sessions: [
        {
          tabId: "yaade:terminal:new",
          cwdRootUri: "file:///tmp/new",
          label: "New Claude",
          status: "exited",
          exitCode: 0,
          launchCommand: "claude",
          agentId: "claude",
        },
      ],
      modal: null,
    })
    assert.equal(next.sessions.length, 1)
    assert.equal(next.sessions[0]?.tabId, "yaade:terminal:new")
    assert.equal(next.modal, null)
  })

  it("persists archived transcript and drops it for active sessions", () => {
    const marker = "ARCHIVED_TRANSCRIPT_MARKER"
    const base = {
      tabId: "yaade:terminal:archive-output",
      cwdRootUri: `file://${dir}`,
      label: "Codex archive",
      launchCommand: "codex",
      status: "exited" as const,
      agentId: "codex",
      transcript: marker,
    }
    const archived = db.replaceSessionRoster({
      version: 2,
      sessions: [{ ...base, doneAt: "2026-08-01T00:00:00.000Z" }],
      modal: null,
    })
    assert.equal(archived.sessions[0]?.transcript, marker)

    const active = db.replaceSessionRoster({
      version: 2,
      sessions: [{ ...base, status: "starting" }],
      modal: null,
    })
    assert.equal(active.sessions[0]?.transcript, undefined)
  })

  it("accepts blank shells alongside agent sessions on replace", () => {
    const saved = db.replaceSessionRoster({
      version: 2,
      sessions: [
        {
          tabId: "yaade:terminal:shell",
          cwdRootUri: "file:///tmp/shell",
          label: "Shell",
          status: "running",
          ptyId: "term-shell",
        },
        {
          tabId: "yaade:terminal:agent",
          cwdRootUri: "file:///tmp/agent",
          label: "Codex",
          status: "running",
          launchCommand: "codex",
          agentId: "codex",
        },
      ],
      modal: null,
    })
    assert.equal(saved.sessions.length, 2)
    assert.equal(
      saved.sessions.some(s => s.tabId === "yaade:terminal:shell"),
      true,
    )
    assert.equal(
      saved.sessions.some(s => s.tabId === "yaade:terminal:agent"),
      true,
    )
  })

  it("marks open sessions as starting after reopen (host restart)", () => {
    db.replaceSessionRoster({
      version: 2,
      sessions: [
        {
          tabId: "yaade:terminal:live",
          cwdRootUri: "file:///tmp/live",
          label: "Live",
          status: "running",
          ptyId: "term-live",
        },
        {
          tabId: "yaade:terminal:agent",
          cwdRootUri: "file:///tmp/agent",
          label: "Codex",
          status: "running",
          launchCommand: "codex",
          agentId: "codex",
          agentCliSessionId: "11111111-1111-4111-8111-111111111111",
        },
      ],
      modal: null,
    })
    db.close()

    db = new ProjectDatabase(dbPath)
    const roster = db.getSessionRoster()
    const live = roster.sessions.find(s => s.tabId === "yaade:terminal:live")
    const agent = roster.sessions.find(s => s.tabId === "yaade:terminal:agent")
    assert.equal(roster.sessions.length, 2)
    assert.equal(live?.status, "starting")
    assert.equal(live?.ptyId, undefined)
    assert.equal(agent?.status, "starting")
    assert.equal(agent?.ptyId, undefined)
    assert.equal(agent?.agentCliSessionId, "11111111-1111-4111-8111-111111111111")
  })

  it("round-trips archive time, provider session id, and stable agent title", () => {
    db.replaceSessionRoster({
      version: 2,
      sessions: [
        {
          tabId: "yaade:terminal:archived",
          cwdRootUri: "file:///tmp/archived",
          label: "Archived",
          status: "exited",
          launchCommand: "claude",
          doneAt: "2026-07-30T00:00:00.000Z",
          agentId: "claude",
          agentTitle: "Implement robust archive restore",
          agentCliSessionId: "22222222-2222-4222-8222-222222222222",
        },
      ],
      modal: null,
    })
    const roster = db.getSessionRoster()
    assert.equal(roster.sessions[0]?.doneAt, "2026-07-30T00:00:00.000Z")
    assert.equal(
      roster.sessions[0]?.agentCliSessionId,
      "22222222-2222-4222-8222-222222222222",
    )
    assert.equal(
      roster.sessions[0]?.agentTitle,
      "Implement robust archive restore",
    )
  })

  it("migrates pre-usage-evidence roster tables with safe false defaults", () => {
    db.close()
    fs.rmSync(dbPath, { force: true })
    const legacy = new DatabaseSync(dbPath)
    legacy.exec(`
      CREATE TABLE session_roster_entries(
        tab_id TEXT PRIMARY KEY,
        cwd_root_uri TEXT NOT NULL,
        label TEXT NOT NULL,
        launch_command TEXT,
        launch_args_json TEXT,
        pty_id TEXT,
        status TEXT NOT NULL,
        exit_code INTEGER,
        custom_label TEXT,
        agent_id TEXT,
        agent_driver_id TEXT,
        agent_thread_id TEXT,
        last_activity_at TEXT,
        project_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO session_roster_entries(
        tab_id, cwd_root_uri, label, launch_command, agent_id, status, created_at, updated_at
      ) VALUES(
        'yaade:terminal:legacy', 'file:///tmp/legacy', 'Legacy agent title',
        'codex', 'codex', 'exited',
        '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z'
      );
    `)
    legacy.close()

    db = new ProjectDatabase(dbPath)
    const columns = db
      .raw()
      .prepare("PRAGMA table_info(session_roster_entries)")
      .all() as unknown as Array<{ name: string }>
    assert.equal(columns.some(column => column.name === "has_user_input"), true)
    assert.equal(columns.some(column => column.name === "agent_title"), true)
    assert.equal(
      columns.some(column => column.name === "has_meaningful_output"),
      true,
    )
    const restored = db.getSessionRoster().sessions[0]
    // Blank shells survive host reopen; only incomplete agent stubs are stripped.
    assert.equal(restored?.tabId, "yaade:terminal:legacy")
    assert.equal(restored?.label, "Legacy agent title")
    assert.equal(restored?.agentTitle, "Legacy agent title")
    assert.equal(restored?.status, "exited")
  })

  it("persists blank shell sessions without agentId", () => {
    const saved = db.replaceSessionRoster({
      version: 2,
      sessions: [
        {
          tabId: "yaade:terminal:blank",
          cwdRootUri: "file:///tmp/blank",
          label: "Terminal",
          status: "running",
        },
      ],
      modal: { tabId: "yaade:terminal:blank", sessionMode: "terminal" },
    })
    assert.equal(saved.sessions.length, 1)
    assert.equal(saved.sessions[0]?.agentId, undefined)
    assert.equal(saved.sessions[0]?.launchCommand, undefined)
    assert.deepEqual(db.getSessionRoster(), saved)
  })

  it("round-trips workspace sessions keyed by machine + root", () => {
    const root = path.join(dir, "project")
    fs.mkdirSync(root, { recursive: true })
    const saved = db.replaceWorkspaceSession({
      version: 1,
      machine: "test-host",
      rootPath: root,
      layout: {
        tree: { kind: "leaf", id: 1 },
        focusedPaneId: 1,
        zoomedPaneId: null,
      },
      sessions: [
        {
          ptyTabId: "yaade:terminal:session-1",
          cwdRootUri: `file://${root}`,
          ptyId: "term-stale",
          label: "Shell",
        },
      ],
    })
    assert.equal(saved.machine, "test-host")
    assert.equal(saved.sessions.length, 1)
    assert.equal(saved.sessions[0]?.ptyId, "term-stale")
    assert.deepEqual(db.getWorkspaceSession("test-host", root), saved)
    assert.equal(
      db.getWorkspaceSession("other-host", root).sessions.length,
      0,
    )
  })

  it("round-trips project sessions", () => {
    const root = path.join(dir, "project-sessions")
    fs.mkdirSync(root, { recursive: true })

    const created = db.createProjectSession({
      machine: "test-host",
      projectPath: root,
      cwdPath: root,
      title: "Feature work",
      worktreeBranch: "feat/x",
      worktreePath: path.join(root, ".worktrees", "feat-x"),
    })
    assert.equal(created.title, "Feature work")
    assert.equal(created.worktreeBranch, "feat/x")

    const listed = db.listProjectSessions("test-host", root)
    assert.ok(listed.some(s => s.id === created.id))

    const updated = db.updateProjectSessionPayload(created.id, {
      version: 2,
      layout: {
        tree: { kind: "leaf", id: 2 },
        focusedPaneId: 2,
        zoomedPaneId: null,
      },
      sessions: [
        {
          ptyTabId: "yaade:terminal:session-2",
          cwdRootUri: `file://${root}`,
          label: "nvim",
          launchCommand: "nvim",
        },
      ],
      editorViewStates: {
        "mux-editor-2\0file:///workspace/index.ts": {
          cursorState: [{ position: { lineNumber: 7, column: 3 } }],
        },
      },
    })
    assert.equal(updated.payload.sessions.length, 1)
    assert.equal(updated.payload.sessions[0]?.launchCommand, "nvim")
    assert.deepEqual(updated.payload.editorViewStates, {
      "mux-editor-2\0file:///workspace/index.ts": {
        cursorState: [{ position: { lineNumber: 7, column: 3 } }],
      },
    })

    const renamed = db.renameProjectSession(created.id, "Renamed")
    assert.equal(renamed.title, "Renamed")
    assert.equal(db.deleteProjectSession(created.id), true)
    assert.equal(db.getProjectSession(created.id), null)
  })

  it("stores bounded recovery buffers and accounts for UTF-8 bytes", () => {
    assert.equal(MAX_EDITOR_RECOVERY_BUFFER_BYTES, 16 * 1024 * 1024)
    assert.equal(MAX_EDITOR_RECOVERY_SESSION_BYTES, 64 * 1024 * 1024)

    db.close()
    db = new ProjectDatabase(dbPath, {
      maxEditorRecoveryBufferBytes: 12,
      maxEditorRecoverySessionBytes: 16,
    })
    const root = path.join(dir, "recovery-project")
    fs.mkdirSync(root, { recursive: true })
    const session = db.createProjectSession({
      machine: "test-host",
      projectPath: root,
      cwdPath: root,
      title: "Recovery",
    })
    const firstUri = `file://${root}/src/../index.ts`
    const saved = db.upsertEditorRecoveryBuffer({
      sessionId: session.id,
      uri: firstUri,
      content: "åååå",
      baseVersion: "100:8",
      languageId: "typescript",
    })
    assert.equal(saved.contentBytes, 8)
    assert.equal(saved.uri, `file://${root}/index.ts`)
    assert.match(saved.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.deepEqual(db.getEditorRecoveryBuffer(session.id, firstUri), {
      ...saved,
      content: "åååå",
    })

    db.upsertEditorRecoveryBuffer({
      sessionId: session.id,
      uri: "untitled:buffer-1",
      content: "12345678",
      baseVersion: null,
      languageId: "plaintext",
    })
    assert.equal(db.listEditorRecoveryBuffers(session.id).length, 2)

    assert.throws(
      () =>
        db.upsertEditorRecoveryBuffer({
          sessionId: session.id,
          uri: "untitled:session-overflow",
          content: "x",
          baseVersion: null,
          languageId: "plaintext",
        }),
      error =>
        error instanceof EditorRecoveryQuotaError && error.quota === "session",
    )
    assert.throws(
      () =>
        db.upsertEditorRecoveryBuffer({
          sessionId: session.id,
          uri: "untitled:buffer-overflow",
          content: "1234567890123",
          baseVersion: null,
          languageId: "plaintext",
        }),
      error =>
        error instanceof EditorRecoveryQuotaError && error.quota === "buffer",
    )

    // Replacing an existing buffer subtracts its previous bytes from the quota.
    db.upsertEditorRecoveryBuffer({
      sessionId: session.id,
      uri: firstUri,
      content: "x",
      baseVersion: "101:1",
      languageId: "typescript",
    })
    db.upsertEditorRecoveryBuffer({
      sessionId: session.id,
      uri: "untitled:session-overflow",
      content: "1234567",
      baseVersion: null,
      languageId: "plaintext",
    })
    assert.equal(db.listEditorRecoveryBuffers(session.id).length, 3)
  })

  it("clears recovery after buffer discard and project-session deletion", () => {
    const root = path.join(dir, "recovery-cleanup")
    fs.mkdirSync(root, { recursive: true })
    const session = db.createProjectSession({
      machine: "test-host",
      projectPath: root,
      cwdPath: root,
      title: "Recovery cleanup",
    })
    db.upsertEditorRecoveryBuffer({
      sessionId: session.id,
      uri: "untitled:first",
      content: "first",
      baseVersion: null,
      languageId: "plaintext",
    })
    db.upsertEditorRecoveryBuffer({
      sessionId: session.id,
      uri: "untitled:second",
      content: "second",
      baseVersion: null,
      languageId: "plaintext",
    })

    assert.equal(
      db.deleteEditorRecoveryBuffer(session.id, "untitled:first"),
      true,
    )
    assert.equal(db.getEditorRecoveryBuffer(session.id, "untitled:first"), null)
    assert.equal(db.listEditorRecoveryBuffers(session.id).length, 1)
    assert.equal(db.deleteEditorRecoverySession(session.id), 1)
    assert.deepEqual(db.listEditorRecoveryBuffers(session.id), [])
    db.upsertEditorRecoveryBuffer({
      sessionId: session.id,
      uri: "untitled:before-session-delete",
      content: "still dirty",
      baseVersion: null,
      languageId: "plaintext",
    })
    assert.equal(db.deleteProjectSession(session.id), true)
    const rows = db
      .raw()
      .prepare("SELECT COUNT(*) AS count FROM editor_recovery_buffers")
      .get() as { count: number }
    assert.equal(rows.count, 0)
  })

  it("migrates workspace_sessions into project_sessions once", () => {
    const root = path.join(dir, "migrate-root")
    fs.mkdirSync(root, { recursive: true })
    const migrateDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-migrate-"))
    const migrateDbPath = path.join(migrateDir, "jet.sqlite3")
    fs.mkdirSync(path.dirname(migrateDbPath), { recursive: true })
    const raw = new DatabaseSync(migrateDbPath)
    raw.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE workspace_sessions(
        machine TEXT NOT NULL,
        root_path TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (machine, root_path)
      );
    `)
    const payload = JSON.stringify({
      version: 1,
      machine: "mig-host",
      rootPath: root,
      layout: { tree: { root: null }, focusedPaneId: null, zoomedPaneId: null },
      sessions: [
        {
          ptyTabId: "yaade:terminal:session-legacy",
          cwdRootUri: `file://${root}`,
          label: "Shell",
        },
      ],
    })
    raw
      .prepare(
        `INSERT INTO workspace_sessions(machine, root_path, payload_json, updated_at)
         VALUES(?,?,?,?)`,
      )
      .run("mig-host", root, payload, new Date().toISOString())
    raw.close()

    const migratedDb = new ProjectDatabase(migrateDbPath)
    const rows = migratedDb.listProjectSessions("mig-host", root)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.title, "Session 1")
    const full = migratedDb.getProjectSession(rows[0]!.id)
    assert.equal(full?.payload.sessions[0]?.ptyTabId, "yaade:terminal:session-legacy")
    migratedDb.close()
    fs.rmSync(migrateDir, { recursive: true, force: true })
  })

  it("backfills the project catalog from session roots without scanning", () => {
    db.close()
    fs.rmSync(dbPath, { force: true })
    const missingRoot = path.join(dir, "formerly-present-project")
    const raw = new DatabaseSync(dbPath)
    raw.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE project_sessions(
        id TEXT PRIMARY KEY, machine TEXT NOT NULL, project_path TEXT NOT NULL,
        cwd_path TEXT NOT NULL, title TEXT NOT NULL, worktree_branch TEXT,
        worktree_path TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, archived_at TEXT
      );
    `)
    raw.prepare(
      `INSERT INTO project_sessions(
        id, machine, project_path, cwd_path, title, payload_json, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?)`,
    ).run(
      "ses-backfill",
      "host",
      missingRoot,
      missingRoot,
      "Old session",
      JSON.stringify({
        version: 1,
        layout: { tree: { root: null }, focusedPaneId: null, zoomedPaneId: null },
        sessions: [],
      }),
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    )
    raw.close()

    db = new ProjectDatabase(dbPath)
    const projects = db.projects()
    assert.equal(projects.length, 1)
    assert.equal(projects[0]?.rootPath, missingRoot)
    assert.equal(projects[0]?.name, "formerly-present-project")
  })
})
