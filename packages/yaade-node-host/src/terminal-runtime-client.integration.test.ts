import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { test } from "vite-plus/test"
import { MultiGenerationTerminalHost } from "./terminal-runtime-client.js"
import { SupervisedTerminalHost } from "./terminal-supervisor-client.js"
import {
  ensureTerminalSupervisor,
  listenTerminalSupervisor,
  supervisorSocketPath,
} from "./terminal-supervisor.js"

test("multi-generation host attaches to a pingable legacy supervisor without a manifest", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-legacy-supervisor-no-manifest-"))
  const supervisor = await listenTerminalSupervisor(supervisorSocketPath(dataDir))
  let host: MultiGenerationTerminalHost | null = null
  try {
    host = await MultiGenerationTerminalHost.connect(dataDir)
    const created = await host.create(
      pathToFileURL(process.cwd()).href,
      { command: process.execPath, args: ["-e", "setInterval(() => {}, 1e9)"] },
      "legacy-no-manifest",
    )
    assert.ok(created.id)
    await host.dispose(created.id)
  } finally {
    await host?.disconnect().catch(() => undefined)
    await supervisor.close().catch(() => undefined)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test("multi-generation host routes old terminals and creates on the newest owner", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-multi-generation-host-"))
  let oldClient: SupervisedTerminalHost | null = null
  let host: MultiGenerationTerminalHost | null = null
  try {
    oldClient = await SupervisedTerminalHost.connect(dataDir)
    const oldTerminal = await oldClient.create(
      pathToFileURL(process.cwd()).href,
      { command: process.execPath, args: ["-e", "setInterval(() => {}, 1e9)"] },
      "old-client",
    )
    const ensured = await ensureTerminalSupervisor(dataDir)
    assert.ok(ensured.manifest)

    host = await MultiGenerationTerminalHost.connect(dataDir, {
      ensureCurrentGeneration: true,
    })
    const currentTerminal = await host.create(
      pathToFileURL(process.cwd()).href,
      { command: process.execPath, args: ["-e", "setInterval(() => {}, 1e9)"] },
      "current-client",
    )
    assert.match(currentTerminal.id, /^pty-runtime-/u)
    const running = await host.listRunning()
    assert.ok(running.some(item => item.id === oldTerminal.id))
    assert.ok(running.some(item => item.id === currentTerminal.id))
    assert.equal((await host.inspect(oldTerminal.id))?.id, oldTerminal.id)
    assert.equal((await host.inspect(currentTerminal.id))?.id, currentTerminal.id)

    await host.dispose(oldTerminal.id)
    await host.dispose(currentTerminal.id)
  } finally {
    await host?.shutdownSupervisor().catch(() => undefined)
    await oldClient?.shutdownSupervisor().catch(() => undefined)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test("multi-generation host recovers routes for exited persisted terminals", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-multi-generation-exited-"))
  let firstHost: MultiGenerationTerminalHost | null = null
  let reconnectedHost: MultiGenerationTerminalHost | null = null
  try {
    firstHost = await MultiGenerationTerminalHost.connect(dataDir, {
      ensureCurrentGeneration: true,
    })
    const exited = await firstHost.create(
      pathToFileURL(process.cwd()).href,
      { command: process.execPath, args: ["-e", "process.exit(7)"] },
      "exited-client",
    )
    await firstHost.waitForExit(exited.id)
    await firstHost.disconnect()

    reconnectedHost = await MultiGenerationTerminalHost.connect(dataDir, {
      ensureCurrentGeneration: true,
    })
    await reconnectedHost.armLiveViewer(exited.id, "reconnected-client")
    const snapshot = await reconnectedHost.attach(exited.id, "reconnected-client")
    assert.equal(snapshot?.id, exited.id)
    assert.equal(snapshot?.status, "exited")
    await reconnectedHost.dispose(exited.id)
  } finally {
    await reconnectedHost?.shutdownSupervisor().catch(() => undefined)
    await firstHost?.shutdownSupervisor().catch(() => undefined)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
