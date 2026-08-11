import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { probeFffAvailable } from "./fff-service.js"
import { pathToUri } from "./paths.js"
import {
  disposeSearchRoot,
  fileSearch,
  invalidateProjectFileCache,
  projectSearch,
} from "./search.js"

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..")
const sampleRootUri = pathToUri(path.join(repoRoot, "fixtures/sample-workspace"))

describe("search", { concurrency: false }, () => {
  it("returns paged file and project results with match ranges", async () => {
    const files = await fileSearch(sampleRootUri, "index", { pageSize: 10 })
    assert.ok(files.items.length > 0)
    assert.equal(typeof files.truncated, "boolean")

    const matches = await projectSearch(sampleRootUri, "export", { fuzzy: false })
    assert.ok(matches.items.length > 0)
    assert.equal(typeof matches.truncated, "boolean")
    assert.ok(matches.items.every(item => item.ranges.length > 0))
  })

  it("indexes and refreshes Quick Open files outside git", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yaade-nogit-search-"))
    const rootUri = pathToUri(dir)
    try {
      await fs.mkdir(path.join(dir, "src"))
      await fs.writeFile(path.join(dir, "src", "index.ts"), "export const ready = true\n")

      const initial = await fileSearch(rootUri, "index", { pageSize: 10 })
      assert.deepEqual(initial, { items: ["src/index.ts"], truncated: false })
      assert.deepEqual(await fileSearch(rootUri, "idxts", { pageSize: 10 }), {
        items: ["src/index.ts"],
        truncated: false,
      })

      await fs.writeFile(path.join(dir, "src", "later.ts"), "export const later = true\n")
      assert.deepEqual(await fileSearch(rootUri, "later", { pageSize: 10 }), {
        items: [],
        truncated: false,
      })

      invalidateProjectFileCache(rootUri)
      assert.deepEqual(await fileSearch(rootUri, "later", { pageSize: 10 }), {
        items: ["src/later.ts"],
        truncated: false,
      })
    } finally {
      disposeSearchRoot(rootUri)
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("applies whole-word, include, and exclude filters with UTF-16 ranges", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yaade-search-options-"))
    const rootUri = pathToUri(dir)
    try {
      await fs.mkdir(path.join(dir, "src"))
      await fs.mkdir(path.join(dir, "docs"))
      await fs.writeFile(path.join(dir, "src", "keep.ts"), "const café = exportValue\n")
      await fs.writeFile(path.join(dir, "src", "skip.ts"), "exportValue\n")
      await fs.writeFile(path.join(dir, "docs", "keep.md"), "exportValue\n")

      const result = await projectSearch(rootUri, "exportValue", {
        caseSensitive: true,
        wholeWord: true,
        include: ["src/**"],
        exclude: ["**/skip.ts"],
      })

      assert.equal(result.truncated, false)
      assert.equal(result.items.length, 1)
      assert.equal(result.items[0]?.path, "src/keep.ts")
      const expectedColumn = "const café = ".length + 1
      assert.deepEqual(result.items[0]?.ranges, [{
        startLine: 1,
        startColumn: expectedColumn,
        endLine: 1,
        endColumn: expectedColumn + "exportValue".length,
      }])
      assert.equal(result.items[0]?.column, expectedColumn)
    } finally {
      disposeSearchRoot(rootUri)
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("pages project results with limit/cursor and marks truncated", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yaade-search-cap-"))
    const rootUri = pathToUri(dir)
    try {
      const content = Array.from({ length: 205 }, (_, index) => `needle ${index}`).join("\n")
      await fs.writeFile(path.join(dir, "many.txt"), content)
      const first = await projectSearch(rootUri, "needle", {
        caseSensitive: true,
        limit: 200,
      })
      assert.equal(first.items.length, 200)
      assert.equal(first.truncated, true)
      assert.ok(first.nextCursor)

      const second = await projectSearch(rootUri, "needle", {
        caseSensitive: true,
        limit: 200,
        cursor: first.nextCursor,
      })
      assert.equal(second.items.length, 5)
      assert.equal(second.truncated, false)
      assert.equal(second.items[0]?.line, 201)
    } finally {
      disposeSearchRoot(rootUri)
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("kills a superseded ripgrep process before starting the latest query", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yaade-search-cancel-"))
    const rootUri = pathToUri(dir)
    const logPath = path.join(dir, "rg.log")
    const fakeRgPath = path.join(dir, "fake-rg")
    const previousRgPath = process.env.YAADE_RG_PATH
    const script = `#!/usr/bin/env node
const fs = require("node:fs")
const query = process.argv.at(-2) || "unknown"
const log = ${JSON.stringify(logPath)}
fs.appendFileSync(log, "start:" + query + "\\n")
process.on("SIGTERM", () => {
  fs.appendFileSync(log, "killed:" + query + "\\n")
  process.exit(0)
})
setTimeout(() => {
  const data = { type: "match", data: { path: { text: query + ".ts" }, line_number: 1, lines: { text: query + "\\n" }, submatches: [{ start: 0, end: Buffer.byteLength(query), match: { text: query } }] } }
  process.stdout.write(JSON.stringify(data) + "\\n")
  fs.appendFileSync(log, "done:" + query + "\\n")
}, query === "first" ? 1000 : 10)
`
    try {
      await fs.writeFile(fakeRgPath, script, { mode: 0o755 })
      process.env.YAADE_RG_PATH = fakeRgPath

      const first = projectSearch(rootUri, "first", { caseSensitive: true })
      await waitFor(async () => (await readIfPresent(logPath)).includes("start:first"))
      const second = projectSearch(rootUri, "second", { caseSensitive: true })

      await assert.rejects(first, error => error instanceof Error && error.name === "AbortError")
      const latest = await second
      assert.equal(latest.items[0]?.path, "second.ts")

      const events = (await fs.readFile(logPath, "utf8")).trim().split("\n")
      assert.deepEqual(events.slice(0, 3), ["start:first", "killed:first", "start:second"])
    } finally {
      if (previousRgPath === undefined) delete process.env.YAADE_RG_PATH
      else process.env.YAADE_RG_PATH = previousRgPath
      disposeSearchRoot(rootUri)
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("probeFffAvailable reports native module load", async () => {
    assert.equal(await probeFffAvailable(), true)
  })
})

async function readIfPresent(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch {
    return ""
  }
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
