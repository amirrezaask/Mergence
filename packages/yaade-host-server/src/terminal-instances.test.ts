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


})
