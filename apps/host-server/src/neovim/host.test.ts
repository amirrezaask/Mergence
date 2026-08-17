import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { Encoder } from "@msgpack/msgpack"
import { Schema } from "effect"
import { ToolUseId } from "@yaade/rpc"
import { NeovimEndpointStore } from "./endpoint.js"
import { NeovimHost, type NeovimExitEvent } from "./host.js"

const binary = path.resolve("mocks/mock-neovim-server.mjs")

function toolUseId(value: string) {
  return Schema.decodeUnknownSync(ToolUseId)(value)
}

function endpointExists(endpoint: { readonly kind: "unix" | "pipe"; readonly path: string }): boolean {
  return endpoint.kind === "pipe" || fs.existsSync(endpoint.path)
}

function waitForSocketClose(socket: import("node:net").Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve()
  return new Promise(resolve => socket.once("close", () => resolve()))
}

describe("NeovimHost", () => {
  it("owns one process per ToolUse, supersedes UI leases, and cleans restarts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-neovim-host-test-"))
    const host = new NeovimHost({ binary })
    const first = toolUseId("use-neovim-first")
    const second = toolUseId("use-neovim-second")
    try {
      const firstOutput = await host.start(first, 1, root)
      const secondOutput = await host.start(second, 1, root)
      assert.notEqual(firstOutput.serverInstanceId, secondOutput.serverInstanceId)
      const firstEndpoint = host.get(first)?.endpoint
      assert.ok(firstEndpoint)
      assert.equal(endpointExists(firstEndpoint), true)

      const oldLease = await host.acquireUi(first, 1)
      const oldLeaseClosed = waitForSocketClose(oldLease.socket)
      const newLease = await host.acquireUi(first, 1)
      await oldLeaseClosed
      assert.equal(oldLease.socket.destroyed, true)
      newLease.release()
      assert.equal(host.get(first)?.generation, 1, "detaching a UI must retain the process")

      const restarted = await host.restart(first, 2, root)
      assert.equal(restarted.generation, 2)
      assert.notEqual(restarted.serverInstanceId, firstOutput.serverInstanceId)
      if (firstEndpoint.kind === "unix") assert.equal(fs.existsSync(firstEndpoint.path), false)
      await assert.rejects(host.acquireUi(first, 1), /unavailable or stale/)

      const stopped = await host.stop(first)
      assert.equal(stopped?.processState, "exited")
      assert.equal(host.get(first), undefined)
      await host.closeAll()
      assert.equal(host.get(second), undefined)
    } finally {
      await host.closeAll()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("publishes clean and failed process exits without keeping a runtime", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-neovim-exit-test-"))
    const exits: NeovimExitEvent[] = []
    const host = new NeovimHost({ binary, onExit: event => exits.push(event) })
    const clean = toolUseId("use-neovim-clean-exit")
    const failed = toolUseId("use-neovim-failed-exit")
    try {
      await host.start(clean, 1, root)
      const cleanLease = await host.acquireUi(clean, 1)
      cleanLease.socket.write(new Encoder().encode([2, "nvim_input", ["__YAADE_EXIT__"]]))
      await waitForSocketClose(cleanLease.socket)
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(exits.at(-1)?.output.processState, "exited")
      assert.equal(host.get(clean), undefined)

      await host.start(failed, 1, root)
      const failedLease = await host.acquireUi(failed, 1)
      failedLease.socket.write(new Encoder().encode([2, "nvim_input", ["__YAADE_FAIL__"]]))
      await waitForSocketClose(failedLease.socket)
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(exits.at(-1)?.output.processState, "failed")
      assert.equal(exits.at(-1)?.output.exitCode, 17)
      assert.equal(host.get(failed), undefined)
    } finally {
      await host.closeAll()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("reports an actionable missing binary error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-neovim-missing-test-"))
    const host = new NeovimHost({ binary: path.join(root, "missing-nvim") })
    try {
      await assert.rejects(
        host.start(toolUseId("use-neovim-missing"), 1, root),
        /Neovim binary is unavailable/,
      )
    } finally {
      await host.closeAll()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("creates short deterministic private endpoints per generation", () => {
    const store = new NeovimEndpointStore()
    try {
      const first = store.endpoint("use-a-very-long-tool-identity-that-must-not-enter-the-path", 1)
      const same = store.endpoint("use-a-very-long-tool-identity-that-must-not-enter-the-path", 1)
      const next = store.endpoint("use-a-very-long-tool-identity-that-must-not-enter-the-path", 2)
      assert.equal(first.path, same.path)
      assert.notEqual(first.path, next.path)
      if (first.kind === "unix") {
        assert.ok(first.path.length <= 100)
        assert.equal(fs.statSync(path.dirname(first.path)).mode & 0o777, 0o700)
      }
    } finally {
      store.close()
    }
  })
})
