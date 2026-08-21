import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "vite-plus/test"
import { TerminalRecoveryStore } from "./terminal-recovery-store.js"

const input = {
  terminalEpoch: "terminal-epoch-1",
  ownerId: "owner-1",
  ownerEpoch: "owner-epoch-1",
  stateRevision: 7,
  activeScreen: "alternate" as const,
  snapshot: {
    cols: 80,
    rows: 24,
    activeScreen: "alternate",
    screenRows: [{ rowId: "row-1", text: "screen" }],
    scrollback: [{ rowId: "history-1", text: "secret-history" }],
  },
}

test("recovery store writes atomically and falls back to the previous valid snapshot", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "yaade-recovery-"))
  try {
    const store = new TerminalRecoveryStore({
      dataDir: root,
      persistence: "screen-and-scrollback",
    })
    assert.equal((await store.write(input)).written, true)
    assert.equal((await store.write({ ...input, stateRevision: 8, snapshot: { value: "next" } })).written, true)
    const currentPath = path.join(root, "terminal-recovery", input.terminalEpoch, "current.snapshot")
    await fs.promises.writeFile(currentPath, "corrupt")
    const recovered = await store.read(input.terminalEpoch)
    assert.ok(recovered.record)
    assert.equal(recovered.record.metadata.stateRevision, 7)
    if (recovered.record) assert.equal(recovered.source, "previous")
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test("screen-only persistence removes scrollback and disabled persistence writes no files", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "yaade-recovery-privacy-"))
  try {
    const screenOnly = new TerminalRecoveryStore({ dataDir: root, persistence: "screen-only" })
    assert.equal((await screenOnly.write(input)).written, true)
    const record = await screenOnly.read(input.terminalEpoch)
    assert.ok(record.record)
    if (!record.record || typeof record.record.snapshot !== "object" || record.record.snapshot === null) {
      throw new Error("recovery snapshot is not an object")
    }
    assert.equal("scrollback" in record.record.snapshot, false)

    const disabled = new TerminalRecoveryStore({ dataDir: root, persistence: "disabled" })
    assert.deepEqual(await disabled.write(input), { written: false, reason: "disabled" })
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test("oversized snapshots are rejected without replacing the current file", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "yaade-recovery-limit-"))
  try {
    const store = new TerminalRecoveryStore({ dataDir: root, persistence: "screen-only", maxSnapshotBytes: 4 })
    const result = await store.write(input)
    assert.deepEqual(result, { written: false, reason: "too-large" })
    assert.deepEqual(await store.read(input.terminalEpoch), { record: null, reason: "missing" })
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})
