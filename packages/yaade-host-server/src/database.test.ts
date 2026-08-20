import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "vite-plus/test"
import { Schema } from "effect"
import { DatabaseOwner, type DatabaseMigration } from "./database.js"

const CountRow = Schema.Struct({ count: Schema.Number })

test("Project host identity remains stable across database reopen", async () => {
  const { ProjectDatabase } = await import("./persistence.js")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-host-identity-"))
  const file = path.join(dir, "host.sqlite3")
  const first = new ProjectDatabase(file)
  const serverId = first.serverId()
  first.close()
  const second = new ProjectDatabase(file)
  try {
    assert.equal(second.serverId(), serverId)
  } finally {
    second.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("DatabaseOwner applies named migrations once and rolls back failures", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-database-owner-"))
  const owner = new DatabaseOwner(path.join(dir, "host.sqlite3"))
  let applied = 0
  try {
    const migrations: DatabaseMigration[] = [
      {
        id: "test/table-v1",
        apply: db => {
          applied += 1
          db.exec("CREATE TABLE values_for_test(value TEXT NOT NULL)")
          db.prepare("INSERT INTO values_for_test(value) VALUES(?)").run("ok")
        },
      },
    ]
    owner.migrate(migrations)
    owner.migrate(migrations)
    assert.equal(applied, 1)
    assert.equal(
      Schema.decodeUnknownSync(CountRow)(
        owner.session.prepare("SELECT COUNT(*) AS count FROM values_for_test").get(),
      ).count,
      1,
    )
    assert.throws(() =>
      owner.transaction(() => {
        owner.session.prepare("INSERT INTO values_for_test(value) VALUES(?)").run("bad")
        throw new Error("rollback")
      }),
    )
    assert.equal(
      Schema.decodeUnknownSync(CountRow)(
        owner.session.prepare("SELECT COUNT(*) AS count FROM values_for_test").get(),
      ).count,
      1,
    )
  } finally {
    owner.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
