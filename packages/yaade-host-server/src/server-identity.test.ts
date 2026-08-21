import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "vite-plus/test"
import { loadConfig } from "./config.js"
import { startHostServer } from "./server.js"

test("server identity survives API restart while epoch changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-server-identity-"))
  try {
    const args = [
      root,
      "--host", "127.0.0.1",
      "--port", "0",
      "--data-dir", path.join(root, "data"),
      "--allowed-roots", root,
    ]
    const first = await startHostServer(await loadConfig(args))
    const firstIdentity = first.runtime.identity
    await first.close()
    const second = await startHostServer(await loadConfig(args))
    try {
      assert.equal(second.runtime.identity.serverId, firstIdentity.serverId)
      assert.notEqual(second.runtime.identity.serverEpoch, firstIdentity.serverEpoch)
    } finally {
      await second.close()
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
