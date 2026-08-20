import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import {
  projectWorktreeSlug,
  resolveWorktreePath,
  sanitizeBranchSegment,
} from "./worktree-path.js"

describe("worktree path derivation", () => {
  it("sanitizes branch segments", () => {
    assert.equal(sanitizeBranchSegment("feat/foo"), "feat-foo")
    assert.equal(sanitizeBranchSegment("  a b  "), "a-b")
    assert.throws(() => sanitizeBranchSegment(".."), /invalid/)
    assert.throws(() => sanitizeBranchSegment("/abs"), /invalid/)
  })

  it("derives a path under ~/.yaade/worktrees", () => {
    const home = os.tmpdir()
    const project = path.join(home, "projects", "my-app")
    const resolved = resolveWorktreePath({
      homeDir: home,
      projectPath: project,
      branch: "feat/cool",
    })
    assert.equal(
      resolved,
      path.join(home, ".yaade", "worktrees", "my-app", "feat-cool"),
    )
  })

  it("suffixes a hash when the candidate path exists", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-wt-"))
    const project = path.join(home, "proj")
    const first = resolveWorktreePath({
      homeDir: home,
      projectPath: project,
      branch: "main",
    })
    fs.mkdirSync(first, { recursive: true })
    const second = resolveWorktreePath({
      homeDir: home,
      projectPath: project,
      branch: "main",
    })
    assert.notEqual(second, first)
    assert.ok(second.startsWith(path.join(home, ".yaade", "worktrees", "proj")))
    fs.rmSync(home, { recursive: true, force: true })
  })

  it("slugs project basenames", () => {
    assert.equal(projectWorktreeSlug("/tmp/My App!"), "My-App")
  })
})
