import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "vite-plus/test"
import { pathToFileURL } from "node:url"
import { SupervisedTerminalHost } from "./terminal-supervisor-client.js"
import {
  listenTerminalSupervisor,
  supervisorSocketPath,
} from "./terminal-supervisor.js"

test("long data directories still produce a bindable Unix socket path", () => {
  if (process.platform === "win32") return
  const dataDir = path.join(
    os.tmpdir(),
    "yaade-desktop-user-data-host-with-a-very-long-suffix-aaaaaaaaaaaaaaaa",
    "nested",
    "host",
  )
  const socketPath = supervisorSocketPath(dataDir)
  assert.ok(Buffer.byteLength(socketPath) <= 100)
  assert.notEqual(socketPath, path.join(dataDir, "pty-supervisor.sock"))
})

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

test("PTY output produced after the last API disconnect is available on reattach", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-pty-offline-"))
  const socketPath = supervisorSocketPath(dataDir)
  const supervisor = await listenTerminalSupervisor(socketPath)
  let client: SupervisedTerminalHost | null = null
  try {
    client = await SupervisedTerminalHost.connect(dataDir)
    const created = await client.create(
      pathToFileURL(process.cwd()).href,
      {
        command: process.execPath,
        args: [
          "-e",
          "let n=0; setInterval(() => { n += 1; process.stdout.write('YAADE_MOCK_N=' + String(n).padStart(4, '0') + '\\n') }, 20)",
        ],
      },
      "offline-client-a",
    )
    await client.armLiveViewer(created.id, "offline-client-a")
    await client.disconnect()
    client = null
    client = await SupervisedTerminalHost.connect(dataDir)
    let output = ""
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const attached = await client.attach(created.id, "offline-client-b")
      assert.ok(attached)
      assert.equal(attached.status, "running")
      output = (attached.outputChunks ?? []).join("")
      if (/YAADE_MOCK_N=0001/.test(output)) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.match(output, /YAADE_MOCK_N=0001/)
    await client.dispose(created.id)
  } finally {
    await client?.disconnect().catch(() => undefined)
    await supervisor.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
