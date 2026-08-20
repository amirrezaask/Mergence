import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, it } from "vite-plus/test"
import { AgentRunService } from "./runs.js"

function event(runId: string, processId: string) {
  return {
    schemaVersion: 1 as const,
    id: `event-${processId}`,
    kind: "session.started" as const,
    provider: "codex" as const,
    occurredAt: "2026-08-09T00:00:00.000Z",
    receivedAt: "2026-08-09T00:00:00.000Z",
    processId,
    sessionId: runId,
    nativeSessionId: "native-session",
    source: { nativeEventName: "session.started" },
  }
}

function withService(test: (service: AgentRunService, db: DatabaseSync) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "yaade-runs-"))
  const db = new DatabaseSync(join(dir, "runs.sqlite"))
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)")
  try {
    test(new AgentRunService(db, () => undefined), db)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("AgentRunService", () => {
  it("reserves launches idempotently and rejects a stale PTY lifecycle", () => {
    withService(service => {
      const first = service.reserve({
        launchRequestId: "request-1",
        provider: "codex",
        projectId: "project-1",
        workspaceId: "workspace-1",
        checkoutKey: "main",
        checkoutPath: "/tmp/project",
        title: "Codex",
      })
      const duplicate = service.reserve({
        ...first.run,
        launchRequestId: "request-1",
      })
      assert.equal(first.created, true)
      assert.equal(duplicate.created, false)
      assert.equal(duplicate.run.runId, first.run.runId)

      const started = service.begin(first.run.runId, first.run.generation)
      assert.equal(started?.processState, "starting")
      const live = service.bindPty(first.run.runId, first.run.generation, "pty-new")
      assert.equal(live?.processState, "running")

      assert.equal(service.onPtyExit("pty-old", 1), null)
      assert.equal(service.get(first.run.runId)?.processState, "running")
      service.onTelemetry(event(first.run.runId, "pty-old"))
      assert.equal(service.get(first.run.runId)?.telemetryState, "connecting")

      service.onTelemetry(event(first.run.runId, "pty-new"))
      assert.equal(service.get(first.run.runId)?.telemetryState, "connected")
      const ended = service.onPtyExit("pty-new", 0, true)
      assert.equal(ended?.processState, "exited")

      // Late telemetry enriches native history but cannot resurrect the run.
      service.onTelemetry(event(first.run.runId, "pty-new"))
      assert.equal(service.get(first.run.runId)?.processState, "exited")
    })
  })

  it("uses process-only telemetry for providers without hooks and disconnects live rows on restart", () => {
    withService((service, db) => {
      const reserved = service.reserve({
        launchRequestId: "request-grok",
        provider: "grok",
        projectId: "project-1",
        workspaceId: "workspace-1",
        checkoutKey: "main",
        checkoutPath: "/tmp/project",
        title: "Grok",
      }).run
      service.begin(reserved.runId, reserved.generation)
      const live = service.bindPty(reserved.runId, reserved.generation, "pty-grok")
      assert.equal(live?.telemetryState, "process_only")
      assert.equal(service.listLive().length, 1)

      const restarted = new AgentRunService(db, () => undefined)
      assert.equal(restarted.get(reserved.runId)?.processState, "disconnected")
      assert.equal(restarted.listLive().length, 0)
    })
  })

  it("lists every non-removed project run and persists its final transcript", () => {
    withService(service => {
      const run = service.reserve({
        launchRequestId: "request-project-list",
        provider: "codex",
        projectId: "project-1",
        workspaceId: "workspace-1",
        checkoutKey: "main",
        checkoutPath: "/tmp/project",
        title: "Codex",
      }).run
      service.begin(run.runId, run.generation)
      service.bindPty(run.runId, run.generation, "pty-project-list")
      service.storeTranscript("pty-project-list", "durable output")
      service.onPtyExit("pty-project-list", 0, true)

      assert.equal(service.listProject("project-1").length, 1)
      assert.deepEqual(service.transcript(run.runId), {
        output: "durable output",
        truncated: false,
      })

      service.close(run.runId, run.generation)
      assert.equal(service.listProject("project-1").length, 0)
    })
  })
})
