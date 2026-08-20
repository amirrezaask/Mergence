import assert from "node:assert/strict"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "vite-plus/test"
import { pathToFileURL } from "node:url"
import {
  createDirectory,
  createFile,
  emptyTrash,
  listTrash,
  renamePath,
  restoreTrash,
  trashPath,
  TRASH_RETENTION_MS,
  type FsMutationOptions,
} from "./fs-mutations.js"

type TestDirectories = {
  readonly base: string
  readonly workspace: string
  readonly dataDir: string
}

function makeDirectories(): TestDirectories {
  const base = mkdtempSync(path.join(tmpdir(), "yaade-fs-mutations-"))
  const workspace = path.join(base, "workspace")
  const dataDir = path.join(base, "data")
  mkdirSync(workspace)
  mkdirSync(dataDir)
  return { base, workspace, dataDir }
}

function options(directories: TestDirectories, overrides?: Partial<FsMutationOptions>): FsMutationOptions {
  return {
    dataDir: directories.dataDir,
    allowedRoots: [directories.workspace],
    ...overrides,
  }
}

function uri(filePath: string): string {
  return pathToFileURL(filePath).href
}

describe("filesystem mutations", () => {
  it("creates files and directories, renames them, and never overwrites", async () => {
    const directories = makeDirectories()
    try {
      const folderPath = path.join(directories.workspace, "src")
      const sourcePath = path.join(folderPath, "new.ts")
      const targetPath = path.join(folderPath, "renamed.ts")
      const folder = await createDirectory(uri(folderPath), options(directories))
      assert.equal(folder.isDirectory, true)
      const created = await createFile(uri(sourcePath), options(directories))
      assert.equal(created.size, 0)
      const renamed = await renamePath(
        uri(sourcePath),
        uri(targetPath),
        options(directories),
      )
      assert.equal(renamed.uri, uri(targetPath))
      assert.equal(existsSync(sourcePath), false)
      assert.equal(existsSync(targetPath), true)

      await assert.rejects(
        () => createFile(uri(targetPath), options(directories)),
        error => {
          assert.equal(
            typeof error === "object" && error !== null && "code" in error
              ? error.code
              : undefined,
            "CONFLICT",
          )
          return true
        },
      )
      writeFileSync(sourcePath, "source")
      await assert.rejects(
        () => renamePath(uri(sourcePath), uri(targetPath), options(directories)),
        /already exists/,
      )
      assert.equal(readFileSync(sourcePath, "utf8"), "source")
    } finally {
      rmSync(directories.base, { recursive: true, force: true })
    }
  })

  it("rejects missing paths outside the allowed root through symlink ancestors", async () => {
    const directories = makeDirectories()
    try {
      const outside = path.join(directories.base, "outside")
      mkdirSync(outside)
      const link = path.join(directories.workspace, "escape")
      symlinkSync(outside, link, "dir")
      await assert.rejects(
        () => createFile(uri(path.join(link, "escaped.txt")), options(directories)),
        /Path not allowed/,
      )
      assert.equal(existsSync(path.join(outside, "escaped.txt")), false)
    } finally {
      rmSync(directories.base, { recursive: true, force: true })
    }
  })
})

describe("YAADE trash", () => {
  it("round-trips directories with their nested contents", async () => {
    const directories = makeDirectories()
    try {
      const folderPath = path.join(directories.workspace, "folder")
      const nestedPath = path.join(folderPath, "nested.txt")
      mkdirSync(folderPath)
      writeFileSync(nestedPath, "nested")
      const trashed = await trashPath(uri(folderPath), options(directories))
      assert.equal(trashed.isDirectory, true)
      assert.equal(existsSync(folderPath), false)
      await restoreTrash(trashed.id, undefined, options(directories))
      assert.equal(readFileSync(nestedPath, "utf8"), "nested")
    } finally {
      rmSync(directories.base, { recursive: true, force: true })
    }
  })

  it("moves files to host-owned trash and restores original or alternate targets", async () => {
    const directories = makeDirectories()
    try {
      const originalPath = path.join(directories.workspace, "notes.txt")
      const alternatePath = path.join(directories.workspace, "notes-restored.txt")
      writeFileSync(originalPath, "keep me")
      const trashed = await trashPath(uri(originalPath), options(directories))
      assert.equal(existsSync(originalPath), false)
      assert.match(trashed.originalUri, /\/workspace\/notes\.txt$/)
      assert.equal(trashed.size, 7)
      assert.deepEqual((await listTrash(options(directories))).map(item => item.id), [trashed.id])

      writeFileSync(originalPath, "new disk file")
      await assert.rejects(
        () => restoreTrash(trashed.id, undefined, options(directories)),
        error => {
          assert.equal(
            typeof error === "object" && error !== null && "code" in error
              ? error.code
              : undefined,
            "CONFLICT",
          )
          return true
        },
      )
      assert.deepEqual((await listTrash(options(directories))).map(item => item.id), [trashed.id])

      const restored = await restoreTrash(
        trashed.id,
        uri(alternatePath),
        options(directories),
      )
      assert.match(restored.uri, /\/workspace\/notes-restored\.txt$/)
      assert.equal(readFileSync(alternatePath, "utf8"), "keep me")
      assert.equal(readFileSync(originalPath, "utf8"), "new disk file")
      assert.deepEqual(await listTrash(options(directories)), [])
    } finally {
      rmSync(directories.base, { recursive: true, force: true })
    }
  })

  it("rejects capacity overflow without deleting the original", async () => {
    const directories = makeDirectories()
    try {
      const filePath = path.join(directories.workspace, "too-large.txt")
      writeFileSync(filePath, "12345")
      await assert.rejects(
        () => trashPath(uri(filePath), options(directories, { trashMaxBytes: 4 })),
        /capacity exceeded/,
      )
      assert.equal(readFileSync(filePath, "utf8"), "12345")
      assert.deepEqual(
        await listTrash(options(directories, { trashMaxBytes: 4 })),
        [],
      )
    } finally {
      rmSync(directories.base, { recursive: true, force: true })
    }
  })

  it("purges expired entries after 30 days and empties retained entries explicitly", async () => {
    const directories = makeDirectories()
    try {
      let now = 10_000
      const clocked = options(directories, { now: () => now })
      const expiredPath = path.join(directories.workspace, "expired.txt")
      writeFileSync(expiredPath, "old")
      await trashPath(uri(expiredPath), clocked)
      now += TRASH_RETENTION_MS + 1
      assert.deepEqual(await listTrash(clocked), [])

      const firstPath = path.join(directories.workspace, "first.txt")
      const secondPath = path.join(directories.workspace, "second.txt")
      writeFileSync(firstPath, "one")
      writeFileSync(secondPath, "two-two")
      await trashPath(uri(firstPath), clocked)
      await trashPath(uri(secondPath), clocked)
      const emptied = await emptyTrash(clocked)
      assert.deepEqual(emptied, { removed: 2, bytes: 10 })
      assert.deepEqual(await listTrash(clocked), [])
    } finally {
      rmSync(directories.base, { recursive: true, force: true })
    }
  })
})
