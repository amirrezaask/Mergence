import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  TerminalControlError,
  TerminalControlRegistry,
  type TerminalMutationFence,
} from "./terminal-control.js"

class TestClock {
  time = 1_700_000_000_000
  now = (): number => this.time
  advance(ms: number): void {
    this.time += ms
  }
}

function fenceFor(lease: ReturnType<TerminalControlRegistry["acquire"]>, commandId: string): TerminalMutationFence {
  return {
    terminalId: lease.terminalId,
    terminalEpoch: lease.terminalEpoch,
    leaseId: lease.leaseId,
    leaseGeneration: lease.leaseGeneration,
    principalId: lease.principalId,
    connectionId: lease.connectionId,
    commandId,
  }
}

function makeRegistry(clock: TestClock): TerminalControlRegistry {
  return new TerminalControlRegistry({
    clock,
    leaseTtlMs: 100,
    makeId: (() => {
      let counter = 0
      return () => `id-${++counter}`
    })(),
  })
}

test("writer acquisition is explicit and observer leases do not mutate", () => {
  const clock = new TestClock()
  const registry = makeRegistry(clock)
  registry.registerTerminal("terminal-a", "epoch-a")
  const observer = registry.acquire({
    terminalId: "terminal-a",
    terminalEpoch: "epoch-a",
    principalId: "device-a",
    connectionId: "connection-a",
    mode: "observer",
  })
  assert.equal(registry.writer("terminal-a"), null)
  assert.throws(
    () => registry.authorizeMutation(fenceFor(observer, "write-1")),
    (error: unknown) => error instanceof TerminalControlError && error.code === "WRITER_LEASE_REQUIRED",
  )
  const writer = registry.acquire({
    terminalId: "terminal-a",
    terminalEpoch: "epoch-a",
    principalId: "device-b",
    connectionId: "connection-b",
    mode: "writer",
  })
  assert.equal(writer.leaseGeneration, 1)
  assert.equal(registry.authorizeMutation(fenceFor(writer, "write-1")).leaseId, writer.leaseId)
})

test("takeover fences stale lease generations and connections", () => {
  const clock = new TestClock()
  const registry = makeRegistry(clock)
  registry.registerTerminal("terminal-b", "epoch-b")
  const first = registry.acquire({
    terminalId: "terminal-b",
    terminalEpoch: "epoch-b",
    principalId: "device-a",
    connectionId: "connection-a",
    mode: "writer",
  })
  const next = registry.forceTakeover("terminal-b", "epoch-b", "admin", "connection-admin")
  assert.equal(next.leaseGeneration, first.leaseGeneration + 1)
  assert.throws(
    () => registry.authorizeMutation(fenceFor(first, "late")),
    (error: unknown) => error instanceof TerminalControlError && error.code === "WRITER_LEASE_STALE",
  )
  assert.throws(
    () => registry.renew("terminal-b", "old-epoch", next.leaseId, "admin", "connection-admin"),
    (error: unknown) => error instanceof TerminalControlError && error.code === "TERMINAL_EPOCH_STALE",
  )
})

test("expired leases and duplicate destructive command IDs are rejected", () => {
  const clock = new TestClock()
  const registry = makeRegistry(clock)
  registry.registerTerminal("terminal-c", "epoch-c")
  const writer = registry.acquire({
    terminalId: "terminal-c",
    terminalEpoch: "epoch-c",
    principalId: "device-a",
    connectionId: "connection-a",
    mode: "writer",
  })
  registry.authorizeMutation(fenceFor(writer, "dispose-1"))
  assert.throws(
    () => registry.authorizeMutation(fenceFor(writer, "dispose-1")),
    (error: unknown) => error instanceof TerminalControlError && error.code === "COMMAND_DUPLICATE",
  )
  clock.advance(101)
  assert.throws(
    () => registry.authorizeMutation(fenceFor(writer, "late")),
    (error: unknown) => error instanceof TerminalControlError && error.code === "WRITER_LEASE_REQUIRED",
  )
})

test("transfer invalidates the previous writer generation", () => {
  const clock = new TestClock()
  const registry = makeRegistry(clock)
  registry.registerTerminal("terminal-d", "epoch-d")
  const first = registry.acquire({
    terminalId: "terminal-d",
    terminalEpoch: "epoch-d",
    principalId: "device-a",
    connectionId: "connection-a",
    mode: "writer",
  })
  const next = registry.transfer(
    "terminal-d",
    "epoch-d",
    first.leaseId,
    "device-a",
    "connection-a",
    "device-b",
    "connection-b",
  )
  assert.equal(next.connectionId, "connection-b")
  assert.equal(next.leaseGeneration, first.leaseGeneration + 1)
  assert.throws(
    () => registry.authorizeMutation(fenceFor(first, "late-write")),
    (error: unknown) => error instanceof TerminalControlError && error.code === "WRITER_LEASE_STALE",
  )
})
