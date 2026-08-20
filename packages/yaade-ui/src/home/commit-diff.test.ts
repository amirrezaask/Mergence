import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"

import { loadWorkingTreeDiffContents } from "./commit-diff.js"

describe("loadWorkingTreeDiffContents", () => {
  it("loads the conflicted working-tree blob for Pierre UnresolvedFile", async () => {
    const conflicted = [
      "line\n",
      "<<<<<<< HEAD\n",
      "ours\n",
      "=======\n",
      "theirs\n",
      ">>>>>>> branch\n",
    ].join("")
    const api = {
      show: async () => {
        throw new Error("show should not be used for conflicts")
      },
    }
    const fsApi = {
      readFile: async () => conflicted,
    }
    const contents = await loadWorkingTreeDiffContents(
      api as never,
      fsApi as never,
      "file:///tmp/repo",
      { path: "src/a.ts", status: "conflict" },
    )
    assert.equal(contents.original, "")
    assert.equal(contents.modified, conflicted)
  })
})
