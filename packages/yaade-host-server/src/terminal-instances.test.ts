import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { describe, it } from "vite-plus/test"
import { TerminalInstanceService } from "./terminal-instances.js"

function withService(test: (service: TerminalInstanceService, db: DatabaseSync) => void): void {
  const db = new DatabaseSync(":memory:")
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)")
  try {
    test(new TerminalInstanceService(db, () => undefined), db)
  } finally {
    db.close()
  }
}

describe("TerminalInstanceService", () => {
  it("keeps a stable instance id across PTY generations and ignores stale exits", () => {
    withService(service => {
      const reserved = service.reserve({
        projectId: "project-1",
        checkoutKey: "main",
        checkoutPath: "/tmp/project",
        title: "Terminal",
      })
      const live = service.bindPty(reserved.id, reserved.generation, "pty-1", "zsh")
      assert.equal(live?.processState, "running")
      assert.equal(live?.provider, null)

      service.onPtyExit("pty-1", 0, "first output")
      const restarting = service.beginRestart(reserved.id, reserved.generation)
      assert.equal(restarting?.id, reserved.id)
      assert.equal(restarting?.generation, 2)
      service.bindPty(reserved.id, 2, "pty-2", "zsh")

      service.onPtyExit("pty-1", 1, "stale output")
      assert.equal(service.get(reserved.id)?.processState, "running")
      assert.equal(service.get(reserved.id)?.ptyId, "pty-2")
    })
  })

  it("persists bounded final output and retains exited rows until close", () => {
    withService(service => {
      const reserved = service.reserve({
        projectId: "project-1",
        checkoutKey: "main",
        checkoutPath: "/tmp/project",
        title: "Terminal",
      })
      service.bindPty(reserved.id, 1, "pty-1")
      service.onPtyExit("pty-1", 7, `${"x".repeat(300 * 1024)}tail`)

      assert.equal(service.listProject("project-1").length, 1)
      assert.equal(service.get(reserved.id)?.exitCode, 7)
      const transcript = service.transcript(reserved.id)
      assert.equal(transcript?.truncated, true)
      assert.equal(transcript?.output.endsWith("tail"), true)
      assert.ok(Buffer.byteLength(transcript?.output ?? "", "utf8") <= 256 * 1024)

      service.close(reserved.id, 1, transcript?.output ?? "")
      assert.equal(service.listProject("project-1").length, 0)
      assert.equal(service.transcript(reserved.id), null)
    })
  })

  it("dispose clears telemetry timers without closing instance rows", () => {
    withService(service => {
      const reserved = service.reserve({
        projectId: "project-1",
        checkoutKey: "main",
        checkoutPath: "/tmp/project",
        title: "Terminal",
      })
      service.bindPty(reserved.id, 1, "pty-1")
      service.dispose()
      assert.equal(service.get(reserved.id)?.processState, "running")
      assert.equal(service.get(reserved.id)?.ptyId, "pty-1")
    })
  })

  it("marks live rows disconnected when the host is reconstructed", () => {
    withService((service, db) => {
      const reserved = service.reserve({
        projectId: "project-1",
        checkoutKey: "main",
        checkoutPath: "/tmp/project",
        title: "Terminal",
      })
      service.bindPty(reserved.id, 1, "pty-1")
      const restarted = new TerminalInstanceService(db, () => undefined)
      restarted.reconcileHostStart(new Set())
      assert.equal(restarted.get(reserved.id)?.processState, "disconnected")
      assert.equal(restarted.listLiveForCheckout("/tmp/project").length, 0)
    })
  })

  it("reserves provider-backed processes with workspace identity", () => {
    withService(service => {
      const reserved = service.reserve({
        projectId: "project-1",
        workspaceId: "ses-1",
        checkoutKey: "main",
        checkoutPath: "/tmp/project",
        title: "Claude",
        provider: "claude",
        launchRequestId: "launch-1",
      })
      assert.equal(reserved.provider, "claude")
      assert.equal(reserved.workspaceId, "ses-1")
      assert.equal(reserved.activityState, "starting")
      const again = service.reserve({
        projectId: "project-1",
        workspaceId: "ses-1",
        checkoutKey: "main",
        checkoutPath: "/tmp/project",
        title: "Claude",
        provider: "claude",
        launchRequestId: "launch-1",
      })
      assert.equal(again.id, reserved.id)
      const live = service.bindPty(reserved.id, 1, "pty-agent", "claude", "process_only")
      assert.equal(live?.processState, "running")
      assert.equal(service.listLiveForWorkspace("ses-1").length, 1)
      const failed = service.onPtyExit("pty-agent", 1, "resume failed")
      assert.equal(failed?.processState, "failed")
      assert.equal(failed?.activityState, "failed")
      service.close(reserved.id, 1, "")
    })
  })

  it("reopens a disconnected reservation so a retry can bind the PTY", () => {
    withService(service => {
      const reserved = service.reserve({
        projectId: "project-1",
        checkoutKey: "main",
        checkoutPath: "/tmp/project",
        title: "Terminal",
        launchRequestId: "retry-1",
      })
      service.markSupervisorDisconnected("supervisor_unavailable")
      assert.equal(service.get(reserved.id)?.processState, "disconnected")
      const reopened = service.reopenForLaunch(reserved.id, reserved.generation)
      assert.equal(reopened?.processState, "starting")
      const live = service.bindPty(reserved.id, reserved.generation, "pty-retry")
      assert.equal(live?.processState, "running")
      assert.equal(live?.ptyId, "pty-retry")
    })
  })

  it("migrates agent_runs into terminal_instances", () => {
    const db = new DatabaseSync(":memory:")
    db.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE agent_runs(
        run_id TEXT PRIMARY KEY,
        launch_request_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        provider TEXT NOT NULL,
        project_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        checkout_key TEXT NOT NULL,
        checkout_path TEXT NOT NULL,
        title TEXT NOT NULL,
        pty_id TEXT,
        native_session_id TEXT,
        process_state TEXT NOT NULL,
        activity_state TEXT NOT NULL,
        telemetry_state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        last_activity_at TEXT,
        ended_at TEXT,
        exit_code INTEGER,
        end_reason TEXT,
        telemetry_error TEXT,
        transcript TEXT NOT NULL DEFAULT '',
        transcript_truncated INTEGER NOT NULL DEFAULT 0,
        removed_at TEXT,
        revision INTEGER NOT NULL
      );
      INSERT INTO agent_runs(
        run_id,launch_request_id,generation,provider,project_id,workspace_id,
        checkout_key,checkout_path,title,pty_id,native_session_id,process_state,
        activity_state,telemetry_state,created_at,started_at,revision
      ) VALUES(
        'run-1','launch-1',1,'codex','project-1','ses-1','main','/tmp/project',
        'Codex','pty-1',NULL,'running','working','connected',
        '2026-08-01T00:00:00.000Z','2026-08-01T00:00:01.000Z',3
      );
    `)
    try {
      const service = new TerminalInstanceService(db, () => undefined)
      service.reconcileHostStart(new Set())
      const row = service.get("run-1")
      assert.equal(row?.provider, "codex")
      assert.equal(row?.workspaceId, "ses-1")
      assert.equal(row?.title, "Codex")
      assert.equal(row?.processState, "disconnected")
    } finally {
      db.close()
    }
  })

  it("backfills legacy non-agent mux leaves as disconnected instances", () => {
    const db = new DatabaseSync(":memory:")
    db.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE projects(id TEXT PRIMARY KEY, root_path TEXT NOT NULL);
      CREATE TABLE project_sessions(
        id TEXT PRIMARY KEY, project_path TEXT NOT NULL, created_at TEXT NOT NULL,
        archived_at TEXT, payload_json TEXT NOT NULL
      );
      INSERT INTO projects(id,root_path) VALUES('project-1','/tmp/project');
    `)
    const payload = {
      version: 2,
      layout: { tree: { type: "leaf", pane: "terminal-tab" }, focusedPaneId: null, zoomedPaneId: null },
      sessions: [
        { ptyTabId: "terminal-tab", cwdRootUri: "file:///tmp/project", label: "Old shell" },
        { ptyTabId: "agent-tab", cwdRootUri: "file:///tmp/project", agentProvider: "codex" },
      ],
    }
    db.prepare(
      `INSERT INTO project_sessions(id,project_path,created_at,archived_at,payload_json)
       VALUES('session-1','/tmp/project','2026-08-01T00:00:00.000Z',NULL,?)`,
    ).run(JSON.stringify(payload))
    try {
      const service = new TerminalInstanceService(db, () => undefined)
      const rows = service.listProject("project-1")
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.title, "Old shell")
      assert.equal(rows[0]?.processState, "disconnected")
      assert.equal(rows[0]?.ptyId, null)
      assert.equal(rows[0]?.provider, null)
    } finally {
      db.close()
    }
  })
})
