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
    (error: unknown) => error instanceof TerminalLeaseError && error.code === "WRITER_LEASE_REQUIRED",
  )
  leases.release("term-1", writer.leaseId, "laptop")
  const next = leases.authorizeWrite("term-1", "phone")
  assert.equal(next.clientId, "phone")
})

test("control transfer invalidates the old writer atomically", () => {
  const leases = new TerminalLeaseService()
  const writer = leases.acquire("term-2", "a")
  const next = leases.transfer("term-2", writer.leaseId, "a", "b")
  assert.equal(next.clientId, "b")
  assert.throws(() => leases.renew("term-2", writer.leaseId, "a"), TerminalLeaseError)
})
