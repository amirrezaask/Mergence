import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "vite-plus/test"
import { enrichProcessPath } from "./shell-env.js"

describe("shell-env", () => {
  it("enrichProcessPath prepends missing user bins on partial GUI PATH", () => {
    if (process.platform === "win32") return
    const localBin = path.join(os.homedir(), ".local/bin")
    if (!fs.existsSync(localBin)) return

    const previous = process.env.PATH
    const previousForce = process.env.YAADE_SHELL_ENV_FORCE
    try {
      delete process.env.YAADE_SHELL_ENV_FORCE
      process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin"
      const result = enrichProcessPath()
      assert.equal(result.enriched, true)
      assert.ok(result.path.split(":").includes(localBin))
      assert.ok(result.path.startsWith(localBin) || result.path.includes(`${localBin}:`))
    } finally {
      if (previous === undefined) delete process.env.PATH
      else process.env.PATH = previous
      if (previousForce === undefined) delete process.env.YAADE_SHELL_ENV_FORCE
      else process.env.YAADE_SHELL_ENV_FORCE = previousForce
    }
  })
})
