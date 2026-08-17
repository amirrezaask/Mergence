import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { Decoder, Encoder } from "@msgpack/msgpack"
import { WebSocket, type RawData } from "ws"
import {
  CreateToolUse,
  MainCheckout,
  NeovimToolInput,
  ProjectTarget,
} from "@yaade/rpc"
import { loadConfig } from "../config.js"
import { startHostServer } from "../server.js"
import { MAX_NEOVIM_MESSAGE_BYTES } from "./ws-proxy.js"

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve())
    socket.once("error", reject)
  })
}

function waitForClose(socket: WebSocket): Promise<{ readonly code: number; readonly reason: string }> {
  return new Promise(resolve => socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") })))
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return Buffer.from(data)
}

function waitForMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once("message", data => {
      try {
        const bytes = rawDataBuffer(data)
        resolve(new Decoder().decode(bytes))
      } catch (error) {
        reject(error)
      }
    })
    socket.once("error", reject)
  })
}

describe("Neovim WebSocket proxy", () => {
  it("gates origin/generation, proxies binary RPC, supersedes leases, and bounds payloads", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-neovim-ws-test-"))
    const previousBinary = process.env.YAADE_NVIM_BIN
    process.env.YAADE_NVIM_BIN = path.resolve("mocks/mock-neovim-server.mjs")
    const config = await loadConfig([
      "--host", "127.0.0.1", "--port", "0",
      "--data-dir", path.join(root, "data"), "--allowed-roots", root, root,
    ])
    const host = await startHostServer(config)
    try {
      const project = host.runtime.db.projects()[0]
      const session = host.runtime.toolSessions.listSessions()[0]
      const service = host.runtime.toolService
      assert.ok(project)
      assert.ok(session)
      assert.ok(service)
      const use = await service.create(CreateToolUse.make({
        sessionId: session.id,
        kind: "neovim",
        project: ProjectTarget.make({
          projectId: project.id,
          projectPath: project.rootPath,
          projectName: project.name,
        }),
        checkout: MainCheckout.make({ kind: "main" }),
        input: NeovimToolInput.make({ kind: "neovim" }),
      }))
      assert.equal(use.output.kind, "neovim")
      if (use.output.kind !== "neovim") throw new Error("missing Neovim output")
      const base = `http://127.0.0.1:${host.port}`
      const url = `ws://127.0.0.1:${host.port}/ws/neovim/${use.id}?generation=${use.output.generation}`

      const rejectedOrigin = new WebSocket(url, { origin: "https://attacker.invalid" })
      const originError = await new Promise<string>(resolve => rejectedOrigin.once("error", error => resolve(error.message)))
      assert.match(originError, /403/)

      const stale = new WebSocket(`${url.slice(0, url.lastIndexOf("="))}=99`, { origin: base })
      const staleClosed = waitForClose(stale)
      await waitForOpen(stale)
      assert.equal((await staleClosed).code, 1008)

      const first = new WebSocket(url, { origin: base })
      await waitForOpen(first)
      const firstClosed = waitForClose(first)
      const second = new WebSocket(url, { origin: base })
      await waitForOpen(second)
      assert.equal((await firstClosed).code, 1005)

      const response = waitForMessage(second)
      second.send(new Encoder().encode([0, 1, "nvim_get_api_info", []]))
      const decoded = await response
      assert.ok(Array.isArray(decoded))
      assert.equal(decoded[0], 1)
      assert.equal(decoded[1], 1)
      second.close()
      await waitForClose(second)
      assert.equal(host.runtime.neovim.get(use.id)?.generation, use.output.generation)

      const overloaded = new WebSocket(url, { origin: base })
      await waitForOpen(overloaded)
      const overloadedClosed = waitForClose(overloaded)
      overloaded.send(new Uint8Array(MAX_NEOVIM_MESSAGE_BYTES + 1))
      assert.equal((await overloadedClosed).code, 1013)
      assert.equal(host.runtime.neovim.get(use.id)?.generation, use.output.generation)
      assert.equal(
        host.runtime.events.replayAfter(0).some(event => event.channel.includes("neovim") || JSON.stringify(event.args).includes("redraw")),
        false,
      )
    } finally {
      await host.close()
      if (previousBinary === undefined) delete process.env.YAADE_NVIM_BIN
      else process.env.YAADE_NVIM_BIN = previousBinary
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
