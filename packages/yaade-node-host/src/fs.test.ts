import assert from "node:assert/strict"
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "vite-plus/test"
import { pathToFileURL } from "node:url"
import {
  exists,
  MAX_READ_BYTES,
  MAX_TEXT_FILE_BYTES,
  MAX_WRITE_BYTES,
  readFile,
  readTextFile,
  writeFile,
  writeTextFile,
  writeTempDrop,
} from "./fs.js"

describe("fs size gates", () => {
  it("rejects reads above MAX_READ_BYTES", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghar-fs-"))
    const path = join(dir, "big.bin")
    // Sparse-ish: write a file just over the limit without filling RAM twice.
    const over = MAX_READ_BYTES + 1
    writeFileSync(path, Buffer.alloc(over, 0x61))
    const uri = pathToFileURL(path).href
    await assert.rejects(() => readFile(uri), /file too large/)
    rmSync(dir, { recursive: true, force: true })
  })

  it("reads files within the limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghar-fs-"))
    const path = join(dir, "ok.txt")
    writeFileSync(path, "hello", "utf8")
    const text = await readFile(pathToFileURL(path).href)
    assert.equal(text, "hello")
    rmSync(dir, { recursive: true, force: true })
  })

  it("probes missing files without rejecting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghar-fs-"))
    const present = join(dir, "present.txt")
    writeFileSync(present, "hello", "utf8")
    assert.equal(await exists(pathToFileURL(present).href), true)
    assert.equal(await exists(pathToFileURL(join(dir, "missing.txt")).href), false)
    rmSync(dir, { recursive: true, force: true })
  })

  it("rejects oversized writeFile and writeTempDrop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghar-fs-"))
    const path = join(dir, "out.txt")
    const big = "x".repeat(MAX_WRITE_BYTES + 1)
    await assert.rejects(
      () => writeFile(pathToFileURL(path).href, big),
      /write too large/,
    )
    const b64 = Buffer.alloc(MAX_WRITE_BYTES + 1, 0x62).toString("base64")
    await assert.rejects(() => writeTempDrop("drop.bin", b64), /temp drop too large/)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("versioned text files", () => {
  it("returns content, byte size, and an opaque disk version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yaade-text-file-"))
    try {
      const path = join(dir, "unicode.txt")
      writeFileSync(path, "hello 🌙", "utf8")
      const result = await readTextFile(pathToFileURL(path).href)
      assert.equal(result.content, "hello 🌙")
      assert.equal(result.size, Buffer.byteLength("hello 🌙", "utf8"))
      assert.match(result.version, /^\d+:\d+:\d+:\d+$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("atomically replaces only the expected version and preserves file mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yaade-text-file-"))
    try {
      const path = join(dir, "script.sh")
      const uri = pathToFileURL(path).href
      writeFileSync(path, "old", "utf8")
      chmodSync(path, 0o755)
      const before = await readTextFile(uri)
      const saved = await writeTextFile(uri, "new text", {
        expectedVersion: before.version,
      })
      assert.equal(saved.size, 8)
      assert.notEqual(saved.version, before.version)
      assert.equal(readFileSync(path, "utf8"), "new text")
      assert.equal(statSync(path).mode & 0o777, 0o755)

      await assert.rejects(
        () => writeTextFile(uri, "stale overwrite", { expectedVersion: before.version }),
        error => {
          assert.equal(
            typeof error === "object" && error !== null && "code" in error
              ? error.code
              : undefined,
            "FILE_CHANGED",
          )
          return true
        },
      )
      assert.equal(readFileSync(path, "utf8"), "new text")
      assert.deepEqual(
        readdirSync(dir).filter(name => name.includes(".yaade-write-")),
        [],
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("creates without overwriting and cleans its temporary file on conflict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yaade-text-file-"))
    try {
      const path = join(dir, "created.txt")
      const uri = pathToFileURL(path).href
      const created = await writeTextFile(uri, "first", { create: true })
      assert.equal(created.size, 5)
      assert.equal(readFileSync(path, "utf8"), "first")

      await assert.rejects(
        () => writeTextFile(uri, "second", { create: true }),
        error => {
          assert.equal(
            typeof error === "object" && error !== null && "code" in error
              ? error.code
              : undefined,
            "FILE_CHANGED",
          )
          return true
        },
      )
      assert.equal(readFileSync(path, "utf8"), "first")
      assert.deepEqual(
        readdirSync(dir).filter(name => name.includes(".yaade-write-")),
        [],
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("serializes concurrent compare-and-swap writes to the same file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yaade-text-file-"))
    try {
      const path = join(dir, "concurrent.txt")
      const uri = pathToFileURL(path).href
      writeFileSync(path, "base", "utf8")
      const before = await readTextFile(uri)
      const writes = await Promise.allSettled([
        writeTextFile(uri, "writer-a", { expectedVersion: before.version }),
        writeTextFile(uri, "writer-b", { expectedVersion: before.version }),
      ])
      assert.equal(writes.filter(result => result.status === "fulfilled").length, 1)
      const rejected = writes.find(result => result.status === "rejected")
      assert.equal(rejected?.status, "rejected")
      if (rejected?.status === "rejected") {
        assert.equal(
          typeof rejected.reason === "object" &&
            rejected.reason !== null &&
            "code" in rejected.reason
            ? rejected.reason.code
            : undefined,
          "FILE_CHANGED",
        )
      }
      assert.ok(["writer-a", "writer-b"].includes(readFileSync(path, "utf8")))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects text-file reads and writes above 16 MiB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yaade-text-file-"))
    try {
      const path = join(dir, "large.txt")
      const uri = pathToFileURL(path).href
      writeFileSync(path, Buffer.alloc(MAX_TEXT_FILE_BYTES + 1, 0x61))
      await assert.rejects(
        () => readTextFile(uri),
        error => {
          assert.equal(
            typeof error === "object" && error !== null && "code" in error
              ? error.code
              : undefined,
            "PAYLOAD_TOO_LARGE",
          )
          return true
        },
      )
      await assert.rejects(
        () => writeTextFile(pathToFileURL(join(dir, "out.txt")).href, "x".repeat(MAX_TEXT_FILE_BYTES + 1), { create: true }),
        /write too large/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
