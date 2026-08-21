import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { TerminalLeaseError } from "@yaade/rpc"
import { TerminalLeaseService } from "./terminal-leases.js"

test("writer leases serialize input while observers remain independent", () => {
  const leases = new TerminalLeaseService()
  const writer = leases.acquire("term-1", "laptop", "writer")
  const observer = leases.acquire("term-1", "phone", "observer")
  assert.equal(writer.mode, "writer")
  assert.equal(observer.mode, "observer")
  assert.deepEqual(leases.listViewers("term-1").sort(), ["laptop", "phone"])
  assert.throws(
    () => leases.authorizeWrite("term-1", "phone"),
    (error: unknown) => error instanceof TerminalLeaseError && error.code === "LEASE_NOT_HELD",
  )
  leases.release("term-1", writer.leaseId, "laptop")
  assert.throws(
    () => leases.authorizeWrite("term-1", "phone"),
    (error: unknown) => error instanceof TerminalLeaseError && error.code === "WRITER_LEASE_REQUIRED",
  )
  const next = leases.acquire("term-1", "phone", "writer")
  assert.equal(next.clientId, "phone")
})

test("writes require an explicit writer lease", () => {
  const leases = new TerminalLeaseService()
  assert.throws(
    () => leases.authorizeWrite("term-explicit", "client"),
    (error: unknown) => error instanceof TerminalLeaseError && error.code === "WRITER_LEASE_REQUIRED",
  )
})

test("mutation fences reject stale generations and duplicate command IDs", () => {
  const leases = new TerminalLeaseService()
  const writer = leases.acquire("term-fence", "connection-a", "writer")
  const fence = {
    terminalId: "term-fence",
    terminalEpoch: writer.terminalEpoch,
    leaseId: writer.leaseId,
    leaseGeneration: writer.leaseGeneration ?? writer.revision,
    principalId: "device-a",
    connectionId: "connection-a",
    commandId: "command-1",
  }
  assert.equal(
    leases.authorizeMutationFence("term-fence", fence, {
      principalId: "device-a",
      connectionId: "connection-a",
    }).leaseId,
    writer.leaseId,
  )
  assert.throws(() => leases.authorizeMutationFence("term-fence", fence, {
    principalId: "device-a",
    connectionId: "connection-a",
  }), TerminalLeaseError)
  assert.throws(() => leases.authorizeMutationFence("term-fence", {
    ...fence,
    leaseGeneration: fence.leaseGeneration + 1,
    commandId: "command-2",
  }, { principalId: "device-a", connectionId: "connection-a" }), TerminalLeaseError)
})

test("control transfer invalidates the old writer atomically", () => {
  const leases = new TerminalLeaseService()
  const writer = leases.acquire("term-2", "a")
  const next = leases.transfer("term-2", writer.leaseId, "a", "b")
  assert.equal(next.clientId, "b")
  assert.throws(() => leases.renew("term-2", writer.leaseId, "a"), TerminalLeaseError)
})

test("first attach becomes writer and later attachers are observers", () => {
  const leases = new TerminalLeaseService()
  const first = leases.attachClient("term-4", "desktop")
  const second = leases.attachClient("term-4", "phone")
  assert.equal(first.mode, "writer")
  assert.equal(second.mode, "observer")
  const mobile = leases.attachClient("term-4", "mobile", "observer")
  assert.equal(mobile.mode, "observer")
})

test("disconnect grace keeps the writer until the client returns", () => {
  const leases = new TerminalLeaseService()
  leases.acquire("term-5", "laptop", "writer")
  leases.releaseClient("laptop")
  assert.equal(leases.currentWriter("term-5")?.clientId, "laptop")
  assert.throws(
    () => leases.acquire("term-5", "phone", "writer"),
    TerminalLeaseError,
  )
  const restored = leases.authorizeWrite("term-5", "laptop")
  assert.equal(restored.clientId, "laptop")
  assert.equal(restored.mode, "writer")
})

test("legacy compatibility release promotes an existing observer", () => {
  const leases = new TerminalLeaseService()
  leases.acquire("term-promote", "a", "writer")
  leases.acquire("term-promote", "b", "observer")
  leases.releaseClient("a", { preserveWriter: false })
  assert.equal(leases.currentWriter("term-promote")?.clientId, "b")
})
