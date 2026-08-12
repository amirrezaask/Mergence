import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { pathToFileUri } from "@yaade/shared"

import { gitApplyPatch, gitDiff, gitStatus } from "./git.js"

describe("gitApplyPatch", () => {
  let root: string
  let rootUri: string

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-git-apply-"))
    rootUri = pathToFileUri(root)
    const run = (args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" })
    run(["init"])
    run(["config", "user.email", "t@t"])
    run(["config", "user.name", "t"])
    fs.writeFileSync(path.join(root, "a.txt"), "one\ntwo\nthree\n")
    run(["add", "."])
    run(["commit", "-m", "init"])
  })

  after(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("stages a hunk into the index with cached:true", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "one\nTWO\nthree\n")
    const patch = await gitDiff(rootUri, { path: "a.txt", staged: false })
    assert.match(patch, /TWO/)
    await gitApplyPatch(rootUri, patch, { cached: true })
    const status = await gitStatus(rootUri)
    const entry = status.find(row => row.path === "a.txt")
    assert.ok(entry?.staged)
    // Reset for next test
    execFileSync("git", ["restore", "--staged", "a.txt"], { cwd: root })
    execFileSync("git", ["restore", "a.txt"], { cwd: root })
  })

  test("discards a hunk from the worktree with cached:false + reverse", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "one\nTWO\nthree\n")
    const patch = await gitDiff(rootUri, { path: "a.txt", staged: false })
    await gitApplyPatch(rootUri, patch, { reverse: true, cached: false })
    const text = fs.readFileSync(path.join(root, "a.txt"), "utf8")
    assert.equal(text, "one\ntwo\nthree\n")
    const status = await gitStatus(rootUri)
    assert.equal(status.find(row => row.path === "a.txt"), undefined)
  })
})
