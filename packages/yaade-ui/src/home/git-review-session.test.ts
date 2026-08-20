import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import type { GitHistoryPage } from "@yaade/shared"
import { GitReviewController } from "./git-review-controller.js"

const page: GitHistoryPage = {
  commits: [
    {
      hash: "abc",
      shortHash: "abc",
      author: "Ada",
      authoredAt: 1,
      subject: "Initial commit",
    },
  ],
  nextCursor: null,
  snapshotHead: "abc",
}

test("GitReviewController owns the repository read snapshot", async () => {
  const controller = new GitReviewController(
    {
      stage: async () => undefined,
      unstage: async () => undefined,
      discard: async () => undefined,
      applyPatch: async () => undefined,
      isRepo: async () => true,
      status: async () => [
        {
          path: "src/app.ts",
          status: "modified",
          staged: false,
          unstaged: true,
        },
      ],
      summary: async () => ({ branch: "main", upstream: null, ahead: 0, behind: 0 }),
      branches: async () => ["main"],
      numstat: async () => [{ path: "src/app.ts", added: 2, deleted: 1 }],
      historyPage: async () => page,
    },
    "file:///repo",
  )

  await controller.refresh()
  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.isRepo, true)
  assert.equal(snapshot.summary.branch, "main")
  assert.equal(snapshot.entries[0]?.path, "src/app.ts")
  assert.equal(snapshot.numstat.get("src/app.ts")?.added, 2)
  assert.equal(snapshot.history[0]?.hash, "abc")
})
