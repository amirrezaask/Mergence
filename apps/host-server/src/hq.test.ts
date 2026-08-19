import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import { pathToFileUri } from "@yaade/shared"
import { NotificationService } from "./notifications/service.js"
import { ProjectDatabase } from "./persistence.js"
import { buildHqSnapshot, inferAgentProvider } from "./hq.js"
import type { HostRuntime } from "./host-runtime.js"

describe("HQ aggregation", () => {
  let dir: string
  let db: ProjectDatabase

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-hq-"))
    db = new ProjectDatabase(path.join(dir, "hq.sqlite3"))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("infers providers from persisted metadata and legacy command basenames", () => {
    assert.equal(inferAgentProvider("codex", undefined), "codex")
    assert.equal(inferAgentProvider(undefined, "/opt/bin/claude"), "claude")
    assert.equal(inferAgentProvider(undefined, "cursor-agent.exe"), "cursor")
    assert.equal(inferAgentProvider(undefined, "bash"), null)
  })

  it("includes running agent PTYs only, dedupes newest mappings, and keeps pending telemetry", async () => {
    const alpha = path.join(dir, "alpha")
    const beta = path.join(dir, "beta")
    fs.mkdirSync(alpha)
    fs.mkdirSync(beta)
    const emptyLayout = {
      tree: { root: null },
      focusedPaneId: null,
      zoomedPaneId: null,
    }

    const old = db.createProjectSession({
      machine: "test-machine", projectPath: alpha, cwdPath: alpha, title: "Old mapping",
    })
    db.updateProjectSessionPayload(old.id, {
      version: 2,
      layout: emptyLayout,
      sessions: [{ ptyTabId: "agent-old", ptyId: "pty-shared", cwdRootUri: pathToFileUri(alpha), launchCommand: "codex" }],
    })
    const newest = db.createProjectSession({
      machine: "test-machine", projectPath: alpha, cwdPath: alpha, title: "New mapping",
    })
    db.updateProjectSessionPayload(newest.id, {
      version: 2,
      layout: emptyLayout,
      sessions: [{ ptyTabId: "agent-new", ptyId: "pty-shared", cwdRootUri: pathToFileUri(alpha), agentProvider: "codex", agentTitle: "Implement HQ" }],
    })
    db.session().prepare("UPDATE project_sessions SET updated_at=? WHERE id=?").run("2026-08-08T10:00:00.000Z", newest.id)
    db.session().prepare("UPDATE project_sessions SET updated_at=? WHERE id=?").run("2026-08-08T09:00:00.000Z", old.id)

    const pending = db.createProjectSession({
      machine: "test-machine", projectPath: beta, cwdPath: beta, title: "Beta main",
    })
    db.updateProjectSessionPayload(pending.id, {
      version: 2,
      layout: emptyLayout,
      sessions: [
        { ptyTabId: "agent-pending", ptyId: "pty-pending", cwdRootUri: pathToFileUri(beta), launchCommand: "/usr/local/bin/claude" },
        { ptyTabId: "agent-exited", ptyId: "pty-exited", cwdRootUri: pathToFileUri(beta), launchCommand: "grok" },
      ],
    })

    const notifications = new NotificationService(db.session())
    const alphaProject = db.projects().find(project => project.name === "alpha")!
    notifications.bindSession({
      sessionId: "agent-new", projectId: alphaProject.id, projectName: alphaProject.name,
      sessionTitle: "Implement HQ", provider: "codex", ptyId: "pty-shared",
    })
    notifications.ingest({
      source: "provider-hook", type: "permission-required", title: "Codex needs permission", sessionId: "agent-new",
    })

    const runtime = {
      db,
      machineHostname: "test-machine",
      notifications,
      config: { allowedRoots: [dir] },
      terminal: {
        inspect(id: string) {
          return id === "pty-exited"
            ? { id, title: null, status: "exited", exitCode: 0, signal: null }
            : { id, title: null, status: "running", exitCode: null, signal: null }
        },
      },
      agents: {
        getSnapshot(sessionId: string) {
          if (sessionId !== "agent-new") return null
          return {
            id: sessionId, nativeSessionId: "native-1", provider: "codex",
            status: "waiting_for_permission", startedAt: "2026-08-08T09:30:00.000Z",
            lastActivityAt: "2026-08-08T09:59:00.000Z",
            process: { id: "pty-shared", running: true },
            runtime: { processRuntimeMs: 1_800_000, activeRuntimeMs: 900_000 },
            counts: { turns: 1, completedTurns: 0, failedTurns: 0, tools: 0, runningTools: 0, failedTools: 0, touchedFiles: 0, compactions: 0 },
            files: [], unread: { count: 0 }, capabilities: {},
          }
        },
      },
    } as unknown as HostRuntime

    const snapshot = await buildHqSnapshot(runtime)
    assert.equal(snapshot.agents.length, 2)
    assert.equal(snapshot.agents.some(agent => agent.sessionId === "agent-old"), false)
    assert.equal(snapshot.agents.some(agent => agent.sessionId === "agent-exited"), false)
    const live = snapshot.agents.find(agent => agent.sessionId === "agent-new")
    assert.equal(live?.projectSessionTitle, "New mapping")
    assert.equal(live?.attention, "permission_required")
    assert.equal(live?.unreadCount, 1)
    const connecting = snapshot.agents.find(agent => agent.sessionId === "agent-pending")
    assert.equal(connecting?.telemetry, "pending")
    assert.equal(connecting?.activity, "Telemetry connecting")
    const alphaHealth = snapshot.projects.find(project => project.id === alphaProject.id)
    assert.equal(alphaHealth?.sessionCount, 1)
    assert.equal(alphaHealth?.liveAgentCount, 1)
    assert.equal(alphaHealth?.attentionCount, 1)
    assert.equal(alphaHealth?.unreadCount, 1)
  })

  it("lists running agent PTYs even when session payload has not persisted yet", async () => {
    const alpha = path.join(dir, "alpha-live")
    fs.mkdirSync(alpha)
    const emptyLayout = {
      tree: { root: null },
      focusedPaneId: null,
      zoomedPaneId: null,
    }
    const main = db.createProjectSession({
      machine: "test-machine",
      projectPath: alpha,
      cwdPath: alpha,
      title: "Main",
    })
    db.updateProjectSessionPayload(main.id, {
      version: 2,
      layout: emptyLayout,
      sessions: [],
    })
    const alphaProject = db.projects().find(project => project.name === "alpha-live")!
    assert.ok(alphaProject)
    const notifications = new NotificationService(db.session())
    notifications.bindSession({
      sessionId: "term-cursor-1",
      projectId: alphaProject.id,
      projectName: alphaProject.name,
      sessionTitle: "Cursor",
      provider: "cursor",
      ptyId: "pty-orphan-cursor",
    })

    const runtime = {
      db,
      machineHostname: "test-machine",
      notifications,
      config: { allowedRoots: [dir] },
      terminal: {
        inspect() {
          return null
        },
        listRunning() {
          return [
            {
              id: "pty-orphan-cursor",
              title: "Cursor",
              status: "running",
              exitCode: null,
              signal: null,
              spawnCommand: "cursor-agent",
              spawnCwd: alpha,
            },
          ]
        },
      },
      agents: { getSnapshot() { return null } },
    } as unknown as HostRuntime

    const snapshot = await buildHqSnapshot(runtime)
    assert.equal(snapshot.agents.length, 1)
    assert.equal(snapshot.agents[0]?.provider, "cursor")
    assert.equal(snapshot.agents[0]?.sessionId, "term-cursor-1")
    assert.equal(snapshot.agents[0]?.ptyId, "pty-orphan-cursor")
    assert.equal(snapshot.agents[0]?.projectSessionId, main.id)
  })
})
