import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import { pathToFileUri } from "@yaade/shared"
import { NotificationService } from "./notifications/service.js"
import { ProjectDatabase } from "./persistence.js"
import { TerminalInstanceService } from "./terminal-instances.js"
import {
  discoverTerminalAgents,
  type TerminalAgentDiscoveryRuntime,
} from "./terminal-agent-discovery.js"

describe("terminal agent discovery", () => {
  let dir: string
  let db: ProjectDatabase

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-terminal-agents-"))
    db = new ProjectDatabase(path.join(dir, "host.sqlite3"))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("promotes an agent launched inside a shell PTY and removes it when the shell returns", async () => {
    const workspace = path.join(dir, "workspace")
    fs.mkdirSync(workspace)
    const project = db.addProject(workspace)
    db.openProjectCheckout({
      machine: "test-machine",
      projectPath: workspace,
      title: "Main",
    })

    let foreground = "claude"
    const started: string[] = []
    const exited: string[] = []
    const terminalInstances = new TerminalInstanceService(
      db.raw(),
      () => undefined,
    )
    const terminal = {
      listRunning: () => [
        {
          id: "pty-shell",
          title: "fish",
          status: "running" as const,
          exitCode: null,
          signal: null,
          spawnCommand: null,
          spawnCwd: workspace,
        },
      ],
      getForegroundProcess: async () => foreground,
      getCwd: async () => pathToFileUri(workspace),
    }
    const runtime = {
      db,
      machineHostname: "test-machine",
      terminal,
      terminalInstances,
      notifications: new NotificationService(db.raw()),
      agents: {
        onProcessStarted(input) {
          started.push(input.sessionId)
        },
        onProcessExited(input) {
          exited.push(input.sessionId)
        },
      },
    } satisfies TerminalAgentDiscoveryRuntime

    await discoverTerminalAgents(runtime)

    const discovered = terminalInstances.listLive(project.id)
    assert.equal(discovered.length, 1)
    const discoveredInstance = discovered[0]
    if (!discoveredInstance) throw new Error("agent instance was not discovered")
    assert.equal(discoveredInstance.provider, "claude")
    assert.equal(discoveredInstance.title, "Claude")
    assert.deepEqual(started, [discoveredInstance.id])

    foreground = "fish"
    await discoverTerminalAgents(runtime)

    assert.equal(terminalInstances.listLive(project.id).length, 0)
    assert.deepEqual(exited, [discoveredInstance.id])
  })
})
