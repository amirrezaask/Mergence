import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"
import { test } from "vite-plus/test"
import { TerminalLeaseError } from "@yaade/rpc"
import { dispatchPromise } from "./dispatch.js"
import { makePairedDevicePrincipal } from "./principal.js"
import { startHostHarness } from "./test-support/host-harness.js"

function leaseFailure(error: unknown, codes: readonly string[]): boolean {
  if (!error || typeof error !== "object") return false
  const record = error as { _tag?: unknown; code?: unknown; message?: unknown }
  if (typeof record.code === "string" && codes.includes(record.code)) return true
  const message = typeof record.message === "string" ? record.message : String(error)
  return codes.some(code =>
    (code === "WRITER_LEASE_REQUIRED" && message.includes("writer lease is required")) ||
    (code === "WRITER_LEASE_STALE" && (
      message.includes("stale") ||
      message.includes("already accepted") ||
      message.includes("epoch") ||
      message.includes("does not match")
    )) ||
    (code === "LEASE_NOT_HELD" && message.includes("not held")),
  )
}

test("owner-fenced writes reject stale writers, observers, and duplicate commands", async () => {
  const harness = await startHostHarness({ ptySupervisor: false })
  try {
    const created = await dispatchPromise(
      harness.server.runtime,
      "terminal:create",
      [
        pathToFileURL(harness.root).href,
        {
          command: process.execPath,
          args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1e9)"],
        },
      ],
      "writer-a",
    ) as { id: string; terminalEpoch: string }
    const writer = await dispatchPromise(
      harness.server.runtime,
      "terminal:acquireLease",
      [created.id, "writer"],
      "writer-a",
    ) as {
      leaseId: string
      leaseGeneration: number
      terminalEpoch: string
      principalId?: string
      connectionId?: string
    }
    const observer = await dispatchPromise(
      harness.server.runtime,
      "terminal:acquireLease",
      [created.id, "observer"],
      "observer-b",
    ) as { leaseId: string; leaseGeneration: number; terminalEpoch: string }

    await dispatchPromise(
      harness.server.runtime,
      "terminal:write",
      [created.id, "ok\n", {
        terminalId: created.id,
        terminalEpoch: writer.terminalEpoch,
        leaseId: writer.leaseId,
        leaseGeneration: writer.leaseGeneration,
        principalId: writer.principalId ?? "compat:writer-a",
        connectionId: writer.connectionId ?? "writer-a",
        commandId: "write-1",
      }],
      "writer-a",
    )

    await assert.rejects(
      () => dispatchPromise(
        harness.server.runtime,
        "terminal:write",
        [created.id, "nope\n"],
        "observer-b",
      ),
      (error: unknown) => leaseFailure(error, ["WRITER_LEASE_REQUIRED", "WRITER_LEASE_STALE"]),
    )

    await assert.rejects(
      () => dispatchPromise(
        harness.server.runtime,
        "terminal:write",
        [created.id, "stale\n", {
          terminalId: created.id,
          terminalEpoch: observer.terminalEpoch,
          leaseId: observer.leaseId,
          leaseGeneration: observer.leaseGeneration,
          principalId: "compat:observer-b",
          connectionId: "observer-b",
          commandId: "obs-1",
        }],
        "observer-b",
      ),
      (error: unknown) => leaseFailure(error, ["WRITER_LEASE_STALE", "WRITER_LEASE_REQUIRED"]),
    )

    await assert.rejects(
      () => dispatchPromise(
        harness.server.runtime,
        "terminal:resize",
        [created.id, 80, 24, {
          terminalId: created.id,
          terminalEpoch: "missing-epoch",
          leaseId: writer.leaseId,
          leaseGeneration: writer.leaseGeneration,
          principalId: writer.principalId ?? "compat:writer-a",
          connectionId: writer.connectionId ?? "writer-a",
          commandId: "resize-stale",
        }],
        "writer-a",
      ),
      (error: unknown) => leaseFailure(error, ["WRITER_LEASE_STALE"]),
    )

    const taken = await dispatchPromise(
      harness.server.runtime,
      "terminal:requestControl",
      [created.id],
      "admin-c",
    ) as { leaseId: string; leaseGeneration: number; terminalEpoch: string }

    await assert.rejects(
      () => dispatchPromise(
        harness.server.runtime,
        "terminal:write",
        [created.id, "late\n", {
          terminalId: created.id,
          terminalEpoch: writer.terminalEpoch,
          leaseId: writer.leaseId,
          leaseGeneration: writer.leaseGeneration,
          principalId: writer.principalId ?? "compat:writer-a",
          connectionId: writer.connectionId ?? "writer-a",
          commandId: "late-1",
        }],
        "writer-a",
      ),
      (error: unknown) => leaseFailure(error, ["WRITER_LEASE_STALE"]),
    )

    await dispatchPromise(
      harness.server.runtime,
      "terminal:write",
      [created.id, "takeover\n", {
        terminalId: created.id,
        terminalEpoch: taken.terminalEpoch,
        leaseId: taken.leaseId,
        leaseGeneration: taken.leaseGeneration,
        principalId: "compat:admin-c",
        connectionId: "admin-c",
        commandId: "take-1",
      }],
      "admin-c",
    )

    await assert.rejects(
      () => dispatchPromise(
        harness.server.runtime,
        "terminal:write",
        [created.id, "dup\n", {
          terminalId: created.id,
          terminalEpoch: taken.terminalEpoch,
          leaseId: taken.leaseId,
          leaseGeneration: taken.leaseGeneration,
          principalId: "compat:admin-c",
          connectionId: "admin-c",
          commandId: "take-1",
        }],
        "admin-c",
      ),
      (error: unknown) => leaseFailure(error, ["WRITER_LEASE_STALE"]),
    )
  } finally {
    await harness.close({ killPtys: true })
  }
})

test("observe-only devices cannot mutate a terminal", async () => {
  const harness = await startHostHarness({ ptySupervisor: false })
  try {
    const created = await dispatchPromise(
      harness.server.runtime,
      "terminal:create",
      [
        pathToFileURL(harness.root).href,
        {
          command: process.execPath,
          args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1e9)"],
        },
      ],
      "writer-a",
    ) as { id: string }
    await assert.rejects(
      () => dispatchPromise(
        harness.server.runtime,
        "terminal:write",
        [created.id, "nope\n"],
        makePairedDevicePrincipal("phone", ["observe"], "observer-device"),
      ),
    )
  } finally {
    await harness.close({ killPtys: true })
  }
})
