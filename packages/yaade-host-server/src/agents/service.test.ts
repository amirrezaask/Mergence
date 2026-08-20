import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { NotificationService } from "../notifications/service.js"
import { AgentTelemetryService } from "./service.js"
import { ensureNotificationSchema } from "../notifications/schema.js"

describe("AgentTelemetryService", () => {
  it("normalizes Claude SessionStart and persists native session id", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghar-ade-"))
    const db = new DatabaseSync(join(dir, "t.sqlite"))
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)`)
    ensureNotificationSchema(db)
    const emitted: unknown[] = []
    const notifications = new NotificationService(db, (e) => emitted.push(e))
    const agents = new AgentTelemetryService(db, notifications, (e) =>
      emitted.push(e),
    )

    const result = agents.ingestNative(
      {
        hook_event_name: "SessionStart",
        session_id: "claude-native-99",
        source: "startup",
      },
      {
        provider: "claude",
        sessionId: "ghar-tab-1",
        processId: "pty-1",
      },
    )

    assert.ok(result.events.some((e) => e.kind === "session.started"))
    assert.equal(result.snapshot?.nativeSessionId, "claude-native-99")
    assert.equal(result.snapshot?.status, "starting")

    const snap = agents.getSnapshot("ghar-tab-1")
    assert.equal(snap?.nativeSessionId, "claude-native-99")

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("projects permission notifications from normalized events", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghar-ade-"))
    const db = new DatabaseSync(join(dir, "t.sqlite"))
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)`)
    ensureNotificationSchema(db)
    const notifications = new NotificationService(db, () => undefined)
    const agents = new AgentTelemetryService(db, notifications, () => undefined)

    agents.ingestNative(
      {
        hook_event_name: "PermissionRequest",
        session_id: "s1",
        permission_id: "p1",
        tool_name: "Bash",
      },
      { provider: "claude", sessionId: "tab-1", processId: "pty" },
    )

    const snap = agents.getSnapshot("tab-1")
    assert.equal(snap?.status, "waiting_for_permission")
    assert.equal(snap?.attention?.kind, "permission_required")

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("disposeSession drops snapshot and pruneEvents caps per-session rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghar-ade-"))
    const db = new DatabaseSync(join(dir, "t.sqlite"))
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)`)
    ensureNotificationSchema(db)
    const notifications = new NotificationService(db, () => undefined)
    const agents = new AgentTelemetryService(db, notifications, () => undefined)

    agents.ingestNative(
      {
        hook_event_name: "SessionStart",
        session_id: "native-1",
        source: "startup",
      },
      { provider: "claude", sessionId: "tab-dispose", processId: "pty-d" },
    )
    assert.ok(agents.getSnapshot("tab-dispose"))

    agents.disposeSession("tab-dispose")
    assert.equal(agents.getSnapshot("tab-dispose"), null)

    const snapRow = db
      .prepare(`SELECT COUNT(*) AS n FROM agent_session_snapshots WHERE session_id=?`)
      .get("tab-dispose") as { n: number }
    assert.equal(snapRow.n, 0)

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
