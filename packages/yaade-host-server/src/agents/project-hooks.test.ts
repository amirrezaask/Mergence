import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "vite-plus/test"
import {
  installProjectHooksForProvider,
} from "./project-hooks.js"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function tempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-hooks-"))
  tempDirs.push(root)
  return root
}

describe("installProjectHooksForProvider", () => {
  it("writes Codex / Cursor / OpenCode project hooks and no-ops Claude / Grok / Pi", () => {
    const root = tempProject()
    const dataDir = path.join(root, "data")

    assert.deepEqual(installProjectHooksForProvider("claude", root, dataDir), [])
    assert.deepEqual(installProjectHooksForProvider("grok", root, dataDir), [])

    const codex = installProjectHooksForProvider("codex", root, dataDir)
    assert.equal(codex.length, 1)
    assert.ok(fs.existsSync(codex[0]!))
    const codexHooks = JSON.parse(fs.readFileSync(codex[0]!, "utf8")) as {
      hooks: Record<string, unknown>
    }
    assert.ok(codexHooks.hooks.Stop)
    assert.ok(codexHooks.hooks.SessionStart)

    const cursor = installProjectHooksForProvider("cursor", root, dataDir)
    assert.equal(cursor.length, 1)
    const cursorHooks = JSON.parse(fs.readFileSync(cursor[0]!, "utf8")) as {
      hooks: Record<string, unknown[]>
    }
    assert.ok(Array.isArray(cursorHooks.hooks.stop))
    assert.ok(
      cursorHooks.hooks.stop!.some(entry =>
        JSON.stringify(entry).includes("yaade-hook-forward"),
      ),
    )

    const opencode = installProjectHooksForProvider("opencode", root, dataDir)
    assert.equal(opencode.length, 1)
    assert.match(fs.readFileSync(opencode[0]!, "utf8"), /YAADE_INGEST_URL/)
  })

  it("preserves user hook entries and refuses to replace malformed JSON", () => {
    const root = tempProject()
    const dataDir = path.join(root, "data")
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true })
    const file = path.join(root, ".codex", "hooks.json")
    fs.writeFileSync(file, JSON.stringify({
      custom: { keep: true },
      hooks: { Stop: [{ matcher: "user", hooks: [{ command: "user-hook" }] }] },
    }))

    installProjectHooksForProvider("codex", root, dataDir)
    installProjectHooksForProvider("codex", root, dataDir)
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      custom: { keep: boolean }
      hooks: { Stop: unknown[] }
    }
    assert.equal(parsed.custom.keep, true)
    assert.equal(parsed.hooks.Stop.filter(entry => JSON.stringify(entry).includes("user-hook")).length, 1)
    assert.equal(parsed.hooks.Stop.filter(entry => JSON.stringify(entry).includes("yaade-hook-forward")).length, 1)

    fs.writeFileSync(file, "{ malformed")
    assert.throws(
      () => installProjectHooksForProvider("codex", root, dataDir),
      /JSON/,
    )
    assert.equal(fs.readFileSync(file, "utf8"), "{ malformed")
  })
})
