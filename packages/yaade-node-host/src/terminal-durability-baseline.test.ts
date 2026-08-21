import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { test } from "vite-plus/test"
import { TerminalHost } from "./terminal.js"
import { TerminalRecoveryStore } from "./terminal-recovery-store.js"
import { fixtureLaunch, RuntimeHarness } from "./test-support/runtime-harness.js"

test("baseline: raw replay is bounded after output exceeds the compatibility cap", async () => {
  const terminal = new TerminalHost({ flowControl: false })
  try {
    const launch = fixtureLaunch("output-flood.mjs", [
      "--bytes",
      String(3 * 1024 * 1024),
      "--marker",
      "BASELINE_FLOOD_COMPLETE",
    ])
    const created = terminal.create(
      pathToFileURL(process.cwd()).href,
      launch,
      "baseline-client",
    )
    await terminal.waitForExit(created.id)
    const attached = terminal.attach(created.id, "baseline-client")
    assert.ok(attached)
    assert.equal(attached.replayTruncated, true)
    assert.ok(attached.outputChunks.join("").length < 3 * 1024 * 1024)
  } finally {
    terminal.stopAll()
  }
})

test("baseline: host restart preserves the child while the supervisor stays connected", async () => {
  const harness = await RuntimeHarness.start()
  try {
    const created = await harness.connectedClient.create(
      pathToFileURL(process.cwd()).href,
      {
        command: process.execPath,
        args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1e9)"],
      },
      "restart-client",
    )
    const inspected = await harness.connectedClient.inspect(created.id)
    assert.ok(inspected?.processIdentity)
    const pid = inspected.osPid
    const lease = await harness.connectedClient.acquireLease(
      created.id,
      created.terminalEpoch,
      "compat:restart-client",
      "restart-client",
      "writer",
    )
    await harness.disconnectClient()
    assert.equal(harness.manifestProcessIsAlive(), true)
    const client = await harness.connectClient()
    const again = await client.inspect(created.id)
    assert.equal(again?.osPid, pid)
    const writer = await client.currentWriterLease(created.id)
    assert.notEqual(writer?.leaseId, lease.leaseId)
    const renewed = await client.acquireLease(
      created.id,
      created.terminalEpoch,
      "compat:restart-client",
      "restart-client",
      "writer",
    )
    await assert.rejects(
      () => client.writeFenced(created.id, "stale", {
        terminalId: created.id,
        terminalEpoch: lease.terminalEpoch,
        leaseId: lease.leaseId,
        leaseGeneration: lease.leaseGeneration,
        principalId: lease.principalId,
        connectionId: lease.connectionId,
        commandId: "stale-after-restart",
      }),
    )
    await client.writeFenced(created.id, "x", {
      terminalId: created.id,
      terminalEpoch: renewed.terminalEpoch,
      leaseId: renewed.leaseId,
      leaseGeneration: renewed.leaseGeneration,
      principalId: renewed.principalId,
      connectionId: renewed.connectionId,
      commandId: "after-restart",
    })
  } finally {
    await harness.close()
  }
})

test("a flooding PTY does not stop a second PTY", async () => {
  const terminal = new TerminalHost({ flowControl: false })
  try {
    const flood = terminal.create(
      pathToFileURL(process.cwd()).href,
      fixtureLaunch("output-flood.mjs", ["--bytes", String(2 * 1024 * 1024), "--marker", "FLOOD_DONE"]),
      "flood-client",
    )
    const quiet = terminal.create(
      pathToFileURL(process.cwd()).href,
      {
        command: process.execPath,
        args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1e9)"],
      },
      "quiet-client",
    )
    await terminal.waitForExit(flood.id)
    const quietInspect = terminal.inspect(quiet.id)
    assert.equal(quietInspect?.status, "running")
    assert.ok(quietInspect?.osPid)
  } finally {
    terminal.stopAll()
  }
})

test("recovery snapshots are written off the PTY path and are not live processes", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-semantic-recovery-"))
  const terminal = new TerminalHost({
    semanticState: true,
    flowControl: false,
    recovery: {
      dataDir,
      ownerId: "owner-recovery",
      ownerEpoch: "epoch-recovery",
      persistence: "screen-only",
    },
  })
  try {
    const created = terminal.create(
      pathToFileURL(process.cwd()).href,
      fixtureLaunch("alternate-screen.mjs"),
      "recovery-client",
    )
    await terminal.waitForSemantic(created.id)
    const deadline = Date.now() + 3_000
    const store = new TerminalRecoveryStore({ dataDir, persistence: "screen-only" })
    let record = await store.read(created.terminalEpoch)
    while (Date.now() < deadline && !record.record) {
      await new Promise(resolve => setTimeout(resolve, 50))
      record = await store.read(created.terminalEpoch)
    }
    assert.ok(record.record)
    assert.equal(record.record.metadata.ownerId, "owner-recovery")
    assert.equal(terminal.inspect(created.id)?.status, "running")
  } finally {
    terminal.stopAll()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
