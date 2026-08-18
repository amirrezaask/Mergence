import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { SupervisedTerminalHost } from "./terminal-supervisor-client.js"
import {
  listenTerminalSupervisor,
  supervisorSocketPath,
} from "./terminal-supervisor.js"

test("a second supervisor client reattaches to a live PTY after disconnect", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-pty-sup-"))
  const socketPath = supervisorSocketPath(dataDir)
  const supervisor = await listenTerminalSupervisor(socketPath)
  let client: SupervisedTerminalHost | null = null
  try {
    client = await SupervisedTerminalHost.connect(dataDir)
    const created = await client.create(
      pathToFileURL(process.cwd()).href,
      {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1e9)"],
      },
      "supervisor-client-a",
    )
    await client.disconnect()
    client = await SupervisedTerminalHost.connect(dataDir)
    const running = await client.listRunning()
    assert.ok(running.some(item => item.id === created.id))
    const attached = await client.attach(created.id, "supervisor-client-b")
    assert.ok(attached)
    assert.equal(attached.status, "running")
    await client.dispose(created.id)
  } finally {
    await client?.disconnect().catch(() => undefined)
    await supervisor.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
