import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "vite-plus/test"
import type { ProcessIdentity } from "./process-identity.js"
import {
  parseRuntimeManifest,
  runtimeManifestPath,
  runtimeSocketPath,
  runtimeSupports,
  TerminalRuntimeRegistry,
  type TerminalRuntimeManifest,
} from "./terminal-runtime-registry.js"

function manifest(
  ownerId: string,
  state: "active" | "draining" = "active",
  pid = process.pid,
): TerminalRuntimeManifest {
  return {
    schemaVersion: 2,
    ownerId,
    ownerEpoch: `epoch-${ownerId}`,
    runtimeVersion: "test",
    protocolMin: 1,
    protocolMax: 2,
    state,
    pid,
    processIdentity: null,
    socketPath: runtimeSocketPath("/tmp/yaade-runtime", ownerId),
    startedAt: new Date().toISOString(),
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

test("generation manifests are independent and active selection excludes draining owners", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-runtime-registry-"))
  try {
    const registry = new TerminalRuntimeRegistry(root)
    registry.writeManifest(manifest("old", "draining"))
    registry.writeManifest(manifest("current"))
    assert.equal(registry.chooseCreateRuntime(2)?.ownerId, "current")
    assert.equal(registry.updateState("current", "epoch-current", "draining")?.state, "draining")
    assert.equal(registry.chooseCreateRuntime(2), null)
    assert.equal(registry.updateState("current", "epoch-current", "active")?.state, "active")
    assert.equal(
      registry.chooseCreateRuntime(2, { semanticTerminalState: true })?.ownerId,
      "current",
    )
    assert.equal(registry.listManifests().length, 2)
    assert.equal(fs.existsSync(runtimeManifestPath(root, "old")), true)
    registry.removeManifest("old", "wrong-epoch")
    assert.equal(fs.existsSync(runtimeManifestPath(root, "old")), true)
    assert.equal(registry.removeManifest("old", "epoch-old"), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("legacy supervisor manifests are discovered as non-semantic owners", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-runtime-registry-legacy-"))
  try {
    fs.writeFileSync(path.join(root, "pty-supervisor.json"), JSON.stringify({
      schemaVersion: 1,
      supervisorId: "legacy-supervisor",
      supervisorEpoch: "legacy-epoch",
      protocolVersion: 1,
      pid: process.pid,
      processIdentity: null,
      socketPath: "/tmp/legacy.sock",
      startedAt: new Date().toISOString(),
    }))
    const legacy = new TerminalRuntimeRegistry(root).listManifests()[0]
    assert.equal(legacy?.ownerId, "legacy-legacy-supervisor")
    assert.equal(legacy?.capabilities.semanticTerminalState, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("stale generation manifests are pruned only after identity failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-runtime-registry-stale-"))
  try {
    const registry = new TerminalRuntimeRegistry(root)
    const processIdentity: ProcessIdentity = {
      pid: 9_999_999,
      platform: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux",
      startToken: "never",
    }
    registry.writeManifest({ ...manifest("dead", "active", 9_999_999), processIdentity })
    assert.deepEqual(registry.pruneStale(), [])
    assert.equal(fs.existsSync(runtimeManifestPath(root, "dead")), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("registry reconstruction ignores corrupt cache and validates manifests", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-runtime-registry-rebuild-"))
  try {
    const registry = new TerminalRuntimeRegistry(root)
    registry.writeManifest(manifest("owner-a"))
    fs.writeFileSync(path.join(root, "pty-runtimes", "registry.json"), "not-json")
    const rebuilt = registry.rebuild()
    assert.deepEqual(rebuilt.map(item => item.ownerId), ["owner-a"])
    assert.equal(parseRuntimeManifest({ schemaVersion: 2 }), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("generation socket paths are distinct", () => {
  assert.notEqual(
    runtimeSocketPath("/tmp/yaade-runtime", "owner-a"),
    runtimeSocketPath("/tmp/yaade-runtime", "owner-b"),
  )
})

test("runtime compatibility requires the requested protocol and capabilities", () => {
  const current = manifest("current")
  assert.equal(runtimeSupports(current, 2, { subscriptions: true }), true)
  assert.equal(runtimeSupports(current, 3), false)
  assert.equal(runtimeSupports({ ...current, state: "draining" }, 2), false)
})
