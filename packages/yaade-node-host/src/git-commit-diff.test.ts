import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { pathToFileUri } from "@yaade/shared"
import {
  gitCommitFileContents,
  gitCommitFiles,
  gitHistory,
  gitHistoryPage,
} from "./git.js"

describe("gitCommitFileContents", () => {
  let root: string
  let rootUri: string
  let hash: string

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-git-commit-diff-"))
    rootUri = pathToFileUri(root)
    const run = (args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" })
    run(["init"])
    run(["config", "user.email", "t@t"])
    run(["config", "user.name", "t"])
    run(["config", "gc.auto", "0"])
    run(["config", "maintenance.auto", "false"])
    fs.writeFileSync(path.join(root, "a.txt"), "one\n")
    run(["add", "."])
    run(["commit", "-m", "first"])
    fs.writeFileSync(path.join(root, "a.txt"), "one\ntwo\n")
    fs.writeFileSync(path.join(root, "b.txt"), "new\n")
    run(["add", "."])
    run(["commit", "-m", "second"])
    const commits = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim()
    hash = commits
  })

  after(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("returns parent vs commit contents for a modified file", async () => {
    const detail = await gitCommitFiles(rootUri, hash)
    const modified = detail.files.find(f => f.path === "a.txt")
    assert.ok(modified)
    const contents = await gitCommitFileContents(rootUri, hash, modified)
    assert.equal(contents.original, "one\n")
    assert.equal(contents.modified, "one\ntwo\n")
  })

  test("returns empty original for an added file", async () => {
    const detail = await gitCommitFiles(rootUri, hash)
    const added = detail.files.find(f => f.path === "b.txt")
    assert.ok(added)
    assert.equal(added.status, "added")
    const contents = await gitCommitFileContents(rootUri, hash, added)
    assert.equal(contents.original, "")
    assert.equal(contents.modified, "new\n")
  })

  test("history lists the commit", async () => {
    const commits = await gitHistory(rootUri, 5)
    assert.ok(commits.some(c => c.hash === hash))
  })

  test("history pages remain pinned to their initial HEAD", async () => {
    for (let index = 0; index < 251; index += 1) {
      fs.writeFileSync(path.join(root, "page.txt"), `${index}\n`)
      execFileSync("git", ["add", "page.txt"], { cwd: root })
      execFileSync("git", ["commit", "-m", `page ${index}`], { cwd: root })
    }

    const first = await gitHistoryPage(rootUri, undefined, 100)
    assert.equal(first.commits.length, 100)
    assert.ok(first.nextCursor)
    const snapshotHead = first.snapshotHead

    fs.writeFileSync(path.join(root, "page.txt"), "new head\n")
    execFileSync("git", ["add", "page.txt"], { cwd: root })
    execFileSync("git", ["commit", "-m", "new head"], { cwd: root })

    const second = await gitHistoryPage(rootUri, first.nextCursor, 100)
    const third = await gitHistoryPage(rootUri, second.nextCursor ?? undefined, 100)
    const hashes = [...first.commits, ...second.commits, ...third.commits].map(commit => commit.hash)
    assert.equal(new Set(hashes).size, hashes.length)
    assert.equal(second.snapshotHead, snapshotHead)
    assert.equal(third.snapshotHead, snapshotHead)
    assert.ok(third.commits.some(commit => commit.subject === "first"))
  })
})
