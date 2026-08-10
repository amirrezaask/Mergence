import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { describe, it } from "node:test"
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
      assert.equal(restarted.get(reserved.id)?.processState, "disconnected")
      assert.equal(restarted.listLiveForCheckout("/tmp/project").length, 0)
    })
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
    } finally {
      db.close()
    }
  })
})
