import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { test } from "vite-plus/test"
import { SupervisedTerminalHost } from "./terminal-supervisor-client.js"
import { supervisorManifestPath } from "./terminal-supervisor.js"

test("concurrent supervisor clients converge on one manifest and owner", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-supervisor-singleton-"))
  let first: SupervisedTerminalHost | undefined
  let second: SupervisedTerminalHost | undefined
  try {
    ;[first, second] = await Promise.all([
      SupervisedTerminalHost.connect(dataDir),
      SupervisedTerminalHost.connect(dataDir),
    ])
    const manifest = JSON.parse(fs.readFileSync(supervisorManifestPath(dataDir), "utf8")) as {
      supervisorId: string
      supervisorEpoch: string
    }
    assert.ok(manifest.supervisorId)
    assert.ok(manifest.supervisorEpoch)
    const created = await first.create(
      pathToFileURL(process.cwd()).href,
      { command: process.execPath, args: ["-e", "setInterval(() => {}, 1e9)"] },
      "singleton-test",
    )
    assert.ok((await second.listRunning()).some(item => item.id === created.id))
    await first.dispose(created.id)
  } finally {
    await second?.disconnect().catch(() => undefined)
    await first?.shutdownSupervisor().catch(() => undefined)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
