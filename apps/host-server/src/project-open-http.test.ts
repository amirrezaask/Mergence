import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import { loadConfig } from "./config.js"
import { startHostServer } from "./server.js"

describe("project open HTTP API", () => {
  let dir: string
  let origin: string
  let close: () => Promise<void>

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-project-open-"))
    const config = await loadConfig([
      dir, "--host", "127.0.0.1", "--port", "0", "--data-dir", path.join(dir, "data"), "--allowed-roots", dir,
    ])
    const started = await startHostServer(config)
    close = started.close
    origin = `http://127.0.0.1:${started.port}`
  })

  afterEach(async () => {
    await close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("opens an existing directory once and returns actionable path errors", async () => {
    const root = path.join(dir, "project")
    const file = path.join(dir, "not-a-directory")
    fs.mkdirSync(root)
    fs.writeFileSync(file, "x")
    const post = (rootPath: string) => fetch(`${origin}/api/v1/projects/open`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rootPath }),
    })
    const first = await post(root)
    const second = await post(path.join(root, "."))
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    const firstBody = await first.json() as { project: { id: string }; created: boolean }
    const secondBody = await second.json() as { project: { id: string }; created: boolean }
    assert.equal(firstBody.created, true)
    assert.equal(secondBody.created, false)
    assert.equal(firstBody.project.id, secondBody.project.id)
    for (const [target, status, code] of [
      [path.join(dir, "missing"), 404, "NOT_FOUND"],
      [file, 400, "NOT_DIRECTORY"],
      [os.tmpdir(), 403, "FORBIDDEN"],
    ] as const) {
      const response = await post(target)
      assert.equal(response.status, status)
      assert.equal((await response.json() as { error: { code: string } }).error.code, code)
    }
  })
})
