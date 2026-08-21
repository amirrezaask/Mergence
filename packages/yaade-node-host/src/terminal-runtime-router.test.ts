import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  TerminalRuntimeRouter,
  type RuntimeConnection,
} from "./terminal-runtime-router.js"
import type { TerminalRuntimeManifest } from "./terminal-runtime-registry.js"

function manifest(
  ownerId: string,
  state: "active" | "draining" = "active",
): TerminalRuntimeManifest {
  return {
    schemaVersion: 2,
    ownerId,
    ownerEpoch: `epoch-${ownerId}`,
    runtimeVersion: "test",
    protocolMin: 1,
    protocolMax: 2,
    state,
    pid: process.pid,
    processIdentity: null,
    socketPath: `/tmp/${ownerId}.sock`,
    startedAt: ownerId === "old" ? "2026-01-01T00:00:00.000Z" : "2026-01-02T00:00:00.000Z",
    capabilities: {
      semanticTerminalState: true,
      authoritativeLeases: true,
      structuredInput: true,
      historyPaging: true,
      subscriptions: true,
      draining: true,
    },
  }
}

test("new creates select the newest active compatible owner while old terminals stay routed", () => {
  const router = new TerminalRuntimeRouter<string>()
  const old: RuntimeConnection<string> = { manifest: manifest("old"), runtime: "old-runtime" }
  const current: RuntimeConnection<string> = { manifest: manifest("current"), runtime: "current-runtime" }
  router.register(old)
  router.register(current)
  router.register({ manifest: manifest("draining", "draining"), runtime: "draining-runtime" })
  assert.equal(router.chooseCreateOwner(2)?.runtime, "current-runtime")
  router.registerTerminal({
    id: "pty-old-1",
    ownerId: "old",
    ownerEpoch: "epoch-old",
    terminalEpoch: "terminal-old",
  })
  assert.equal(router.routeOrThrow("pty-old-1").runtime, "old-runtime")
  router.unregister("epoch-current")
  assert.equal(router.routeOrThrow("pty-old-1").runtime, "old-runtime")
})

test("owner-scoped running reconciliation does not mix generations", () => {
  const router = new TerminalRuntimeRouter<string>()
  router.register({ manifest: manifest("old"), runtime: "old" })
  router.register({ manifest: manifest("current"), runtime: "current" })
  const running = router.listRunning(runtime =>
    runtime === "old"
      ? [{ id: "old-terminal", terminalEpoch: "old-epoch", status: "running" }]
      : [{ id: "current-terminal", terminalEpoch: "current-epoch", status: "running" }],
  )
  assert.deepEqual(
    running.map(item => `${item.ownerId}:${item.id}`).sort(),
    ["current:current-terminal", "old:old-terminal"],
  )
  router.unregister("epoch-old")
  assert.equal(router.route("old-terminal"), null)
  assert.notEqual(router.route("current-terminal"), null)
})
