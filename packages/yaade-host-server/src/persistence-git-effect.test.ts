import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { Effect } from "effect"
import { makeProjectDatabaseScoped } from "./effect/layers.js"
import { GitServiceLive, GitServiceTag, makeGitService } from "./effect/git.js"
import { pathToFileUri } from "@yaade/shared"

test("makeProjectDatabaseScoped closes SQLite when scope ends", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-db-scope-"))
  const dbPath = path.join(dir, "jet.sqlite3")
  let closed = false

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* makeProjectDatabaseScoped(dbPath)
        const original = db.close.bind(db)
        db.close = () => {
          closed = true
          original()
        }
        assert.ok(db.getSessionRoster())
      }),
    ),
  )

  assert.equal(closed, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("GitService isRepo succeeds for this workspace", async () => {
  const rootUri = pathToFileUri(process.cwd())
  const git = makeGitService()
  const isRepo = await Effect.runPromise(git.isRepo(rootUri))
  assert.equal(isRepo, true)
})

test("GitServiceLive provides GitServiceTag", async () => {
  const rootUri = pathToFileUri(process.cwd())
  const branch = await Effect.runPromise(
    Effect.gen(function* () {
      const git = yield* GitServiceTag
      return yield* git.branch(rootUri)
    }).pipe(Effect.provide(GitServiceLive)),
  )
  assert.equal(typeof branch === "string" || branch === null, true)
})
