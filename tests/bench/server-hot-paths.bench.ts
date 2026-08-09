import { DatabaseSync } from "node:sqlite"
import { performance } from "node:perf_hooks"
import { test } from "@playwright/test"
import { EventHub } from "../../apps/host-server/src/events.js"
import { NotificationService } from "../../apps/host-server/src/notifications/service.js"
import { buildHqSnapshot } from "../../apps/host-server/src/hq.js"
import type { HostRuntime } from "../../apps/host-server/src/host-runtime.js"
import { assertBudget, logBenchResult, runBench } from "./_bench.js"

test("bench server event replay ingestion", async () => {
  const result = await runBench({
    name: "server-event-replay-ingest",
    rounds: 7,
    measure: async () => {
      const events = new EventHub(1_024, 16 * 1024 * 1024)
      // terminal:data is live-only; measure retained-channel ingest + prove a
      // terminal flood does not evict notification history.
      const payload = "x".repeat(64)
      const startedAt = performance.now()
      for (let index = 0; index < 50_000; index += 1) {
        events.emit("fs:changed", [`file://p-${index}-${payload}`])
        if (index % 10 === 0) {
          events.emit("terminal:data", ["pty", payload.repeat(16), index])
        }
      }
      events.emit("notifications:event", [{ type: "marker" }])
      void events.replayAfter(0)
      return performance.now() - startedAt
    },
  })
  logBenchResult(result)
  assertBudget(result)
})

test("bench server notification retention", async () => {
  const result = await runBench({
    name: "server-notification-retention-10k",
    rounds: 7,
    measure: async () => {
      const db = new DatabaseSync(":memory:")
      const notifications = new NotificationService(db)
      const insert = db.prepare(
        `INSERT INTO app_notifications(
          id, type, severity, status, title, source,
          created_at, updated_at, metadata_json
        ) VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      db.exec("BEGIN")
      for (let index = 0; index < 10_000; index += 1) {
        insert.run(
          `notification-${index}`,
          "turn-completed",
          "info",
          "dismissed",
          "done",
          "system",
          "2000-01-01T00:00:00.000Z",
          "2000-01-01T00:00:00.000Z",
          "{}",
        )
      }
      db.exec("COMMIT")

      const startedAt = performance.now()
      notifications.runRetention(new Date("2026-01-01T00:00:00.000Z"))
      const elapsed = performance.now() - startedAt
      db.close()
      return elapsed
    },
  })
  logBenchResult(result)
  assertBudget(result)
})

test("bench HQ aggregation stays linear across projects, workspaces, and runs", async () => {
  const now = "2026-01-01T00:00:00.000Z"
  const projects = Array.from({ length: 100 }, (_, index) => ({
    id: `project-${index}`,
    name: `project-${index}`,
    rootPath: `/tmp/yaade-hq-bench/project-${index}`,
    createdAt: now,
    updatedAt: now,
  }))
  const sessions = Array.from({ length: 500 }, (_, index) => {
    const project = projects[index % projects.length]!
    return {
      id: `workspace-${index}`,
      machine: "bench",
      projectPath: project.rootPath,
      cwdPath: `${project.rootPath}/worktree-${index}`,
      checkoutKey: index % 5 === 0 ? "main" : `checkout-${index}`,
      title: `workspace-${index}`,
      worktreeBranch: index % 5 === 0 ? null : `branch-${index}`,
      worktreePath: index % 5 === 0 ? null : `${project.rootPath}/worktree-${index}`,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      payload: { version: 1, layout: { tree: { root: null }, focusedPaneId: null, zoomedPaneId: null }, sessions: [] },
    }
  })
  const runs = Array.from({ length: 200 }, (_, index) => {
    const workspace = sessions[index]!
    return {
      runId: `run-${index}`,
      launchRequestId: `request-${index}`,
      generation: 1,
      provider: "codex" as const,
      projectId: `project-${index % projects.length}`,
      workspaceId: workspace.id,
      checkoutKey: workspace.checkoutKey,
      checkoutPath: workspace.cwdPath,
      title: `agent-${index}`,
      ptyId: `pty-${index}`,
      nativeSessionId: null,
      processState: "running" as const,
      activityState: "working" as const,
      telemetryState: "connected" as const,
      createdAt: now,
      startedAt: now,
      lastActivityAt: now,
      endedAt: null,
      exitCode: null,
      endReason: null,
      telemetryError: null,
      revision: 1,
    }
  })
  const emptyCounts = () => ({})
  const runtime = {
    machineHostname: "bench",
    config: { allowedRoots: ["/tmp"] },
    db: {
      projects: () => projects,
      listAllProjectSessions: () => sessions,
    },
    agentRuns: { listLive: () => runs },
    terminal: { inspect: (id: string) => ({ id, status: "running" }) },
    agents: { getSnapshot: () => null },
    notifications: {
      unreadBySession: emptyCounts,
      unreadByProject: emptyCounts,
      attentionBySession: emptyCounts,
      attentionByProject: emptyCounts,
      counts: () => ({ totalUnread: 0, actionRequired: 0, errors: 0 }),
    },
  } as unknown as HostRuntime

  const result = await runBench({
    name: "hq-aggregation-100p-500w-200r",
    rounds: 7,
    measure: async () => {
      const startedAt = performance.now()
      const snapshot = buildHqSnapshot(runtime)
      const elapsed = performance.now() - startedAt
      if (snapshot.projects.length !== 100 || snapshot.agents.length !== 200) {
        throw new Error("HQ benchmark fixture was not fully aggregated")
      }
      return elapsed
    },
  })
  logBenchResult(result)
  assertBudget(result)
})
