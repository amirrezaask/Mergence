import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { test } from "vite-plus/test"
import { SupervisedTerminalHost } from "./terminal-supervisor-client.js"
import {
  ensureTerminalSupervisorGeneration,
  listenTerminalSupervisor,
  supervisorSocketPath,
} from "./terminal-supervisor.js"

test("generation upgrade keeps old and new PTYs alive on separate owners", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-runtime-upgrade-"))
  const oldSocket = supervisorSocketPath(dataDir)
  const oldSupervisor = await listenTerminalSupervisor(oldSocket)
  let oldClient: SupervisedTerminalHost | null = null
  let currentClient: SupervisedTerminalHost | null = null
  try {
    oldClient = await SupervisedTerminalHost.connect(dataDir)
    const oldTerminal = await oldClient.create(
      pathToFileURL(process.cwd()).href,
      { command: process.execPath, args: ["-e", "setInterval(() => {}, 1e9)"] },
      "old-owner",
    )

    const generation = await ensureTerminalSupervisorGeneration(dataDir, {
      runtimeVersion: "generation-v1",
    })
    assert.equal(generation.spawned, true)
    currentClient = await SupervisedTerminalHost.connectGeneration(
      dataDir,
      generation.socketPath,
    )
    const currentTerminal = await currentClient.create(
      pathToFileURL(process.cwd()).href,
      { command: process.execPath, args: ["-e", "setInterval(() => {}, 1e9)"] },
      "current-owner",
    )
    assert.notEqual(oldTerminal.id, currentTerminal.id)
    assert.ok((await oldClient.listRunning()).some(item => item.id === oldTerminal.id))
    assert.ok((await currentClient.listRunning()).some(item => item.id === currentTerminal.id))

    await oldClient.dispose(oldTerminal.id)
    await currentClient.dispose(currentTerminal.id)
  } finally {
    await oldClient?.disconnect().catch(() => undefined)
    await currentClient?.shutdownSupervisor().catch(() => undefined)
    await oldSupervisor.close().catch(() => undefined)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await fs.promises.rm(dataDir, { recursive: true, force: true })
        break
      } catch {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
  }
})
