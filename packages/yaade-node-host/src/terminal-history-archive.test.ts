import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "vite-plus/test"
import { TerminalHistoryArchive } from "./terminal-history-archive.js"

function temporaryRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "yaade-terminal-history-"))
}

test("history is compressed into sequence-indexed blocks and replayed in bounded pages", async () => {
  const root = temporaryRoot()
  try {
    const commits: number[] = []
    const archive = new TerminalHistoryArchive({
      rootDir: root,
      blockBytes: 8,
      pageBytes: 7,
      onCommit: (_terminalId, sequence) => commits.push(sequence),
    })
    archive.append("term-a", 1, "aaaa")
    archive.append("term-a", 2, "bbbb")
    archive.append("term-a", 3, "cccc")
    await archive.flushAll()

    assert.deepEqual(commits, [2, 3])
    assert.equal(archive.committedThrough("term-a"), 3)
    const terminalDir = path.join(root, Buffer.from("term-a").toString("base64url"))
    const manifest = JSON.parse(fs.readFileSync(path.join(terminalDir, "index.json"), "utf8"))
    assert.deepEqual(
      manifest.blocks.map((block: { firstSequence: number; lastSequence: number }) => [
        block.firstSequence,
        block.lastSequence,
      ]),
      [[1, 2], [3, 3]],
    )
    assert.ok(manifest.blocks.every((block: { file: string }) => block.file.endsWith(".json.gz")))

    const first = await archive.readPage("term-a", 0)
    assert.deepEqual(first.chunks, ["aaaa"])
    assert.equal(first.nextSequence, 1)
    assert.equal(first.complete, false)
    const second = await archive.readPage("term-a", first.nextSequence)
    assert.deepEqual(second.chunks, ["bbbb"])
    const third = await archive.readPage("term-a", second.nextSequence)
    assert.deepEqual(third.chunks, ["cccc"])
    assert.equal(third.complete, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("global retention trims active terminals without deleting their live archive", async () => {
  const root = temporaryRoot()
  try {
    const archive = new TerminalHistoryArchive({
      rootDir: root,
      blockBytes: 1,
      pageBytes: 1024,
      maxTerminalBytes: 1024 * 1024,
      maxTotalBytes: 1,
    })
    archive.append("active", 1, "first")
    archive.append("active", 2, "second")
    archive.append("active", 3, "third")
    await archive.flushAll()

    const terminalDir = path.join(
      root,
      Buffer.from("active").toString("base64url"),
    )
    const manifest = JSON.parse(
      fs.readFileSync(path.join(terminalDir, "index.json"), "utf8"),
    )
    assert.equal(manifest.blocks.length, 1)
    assert.equal(manifest.blocks[0].firstSequence, 3)
    const page = await archive.readPage("active", 0)
    assert.deepEqual(page.chunks, ["third"])
    assert.equal(page.firstSequence, 3)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("closed archives expire and total retention evicts oldest closed terminals", async () => {
  const root = temporaryRoot()
  try {
    const archive = new TerminalHistoryArchive({
      rootDir: root,
      blockBytes: 1,
      maxTerminalBytes: 1024,
      maxTotalBytes: 1,
      closedRetentionMs: 10,
    })
    archive.append("old", 1, "old output")
    archive.closeTerminal("old")
    await archive.flushAll()
    // A live archive object keeps one minimal block so concurrent readers and
    // queued manifest writes never race directory deletion.
    assert.equal(fs.readdirSync(root).length, 1)
    await archive.close()

    const retained = new TerminalHistoryArchive({
      rootDir: root,
      blockBytes: 1,
      maxTotalBytes: 1024,
      closedRetentionMs: 10,
    })
    retained.append("expired", 1, "x")
    retained.closeTerminal("expired")
    await retained.flushAll()
    retained.cleanupExpired(Date.now() + 20)
    assert.equal(fs.readdirSync(root).length, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
