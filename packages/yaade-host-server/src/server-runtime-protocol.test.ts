import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "vite-plus/test"
import WebSocket from "ws"
import { loadConfig } from "./config.js"
import { startHostServer } from "./server.js"

test("modern realtime connections receive identity, snapshot, and post-snapshot events", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-runtime-protocol-"))
  let started: Awaited<ReturnType<typeof startHostServer>> | undefined
  let socket: WebSocket | undefined
  try {
    const workspace = path.join(root, "workspace")
    fs.mkdirSync(workspace, { recursive: true })
    const config = await loadConfig([
      workspace,
      "--host", "127.0.0.1",
      "--port", "0",
      "--data-dir", path.join(root, "data"),
      "--allowed-roots", root,
    ])
    started = await startHostServer(config)
    socket = new WebSocket(`ws://127.0.0.1:${started.port}/ws?protocol=2&clientId=protocol-test`)
    const frames: unknown[] = []
    socket.on("message", data => frames.push(JSON.parse(data.toString())))
    await new Promise<void>((resolve, reject) => {
      socket?.once("open", () => resolve())
      socket?.once("error", reject)
    })
    assert.match(socket.extensions, /permessage-deflate/)
    const firstFrames = await new Promise<unknown[]>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("snapshot timeout")), 5_000)
      const poll = () => {
        if (frames.length >= 2) {
          clearTimeout(deadline)
          resolve(frames.splice(0))
          return
        }
        setTimeout(poll, 5)
      }
      poll()
    })
    const hello = firstFrames[0] as { type: string; identity: { serverId: string; serverEpoch: string } }
    const snapshot = firstFrames[1] as { type: string; cursor: { serverEpoch: string; sequence: number } }
    assert.equal(hello.type, "protocol:hello")
    assert.equal(snapshot.type, "runtime:snapshot")
    assert.ok(hello.identity.serverId)
    assert.equal(snapshot.cursor.serverEpoch, hello.identity.serverEpoch)

    started.runtime.events.emit("protocol-test:event", [{ ok: true }])
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("event timeout")), 5_000)
      const poll = () => {
        const event = frames.find(value => (value as { channel?: string }).channel === "protocol-test:event")
        if (event) {
          clearTimeout(deadline)
          assert.equal((event as { protocolVersion: number }).protocolVersion, 2)
          assert.equal((event as { serverEpoch: string }).serverEpoch, hello.identity.serverEpoch)
          resolve()
          return
        }
        setTimeout(poll, 5)
      }
      poll()
    })
  } finally {
    socket?.terminate()
    await started?.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("modern websocket authentication does not put the token in the URL", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-runtime-auth-"))
  let started: Awaited<ReturnType<typeof startHostServer>> | undefined
  let socket: WebSocket | undefined
  try {
    const config = await loadConfig([
      root,
      "--host", "127.0.0.1",
      "--port", "0",
      "--data-dir", path.join(root, "data"),
      "--allowed-roots", root,
      "--token", "secret-token",
    ])
    started = await startHostServer(config)
    const url = `ws://127.0.0.1:${started.port}/ws?protocol=2&clientId=auth-test`
    assert.equal(url.includes("secret-token"), false)
    socket = new WebSocket(url)
    const frames: unknown[] = []
    socket.on("message", data => frames.push(JSON.parse(data.toString())))
    await new Promise<void>((resolve, reject) => {
      socket?.once("open", () => resolve())
      socket?.once("error", reject)
    })
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("auth handshake timeout")), 5_000)
      const poll = () => {
        if (frames.some(frame => (frame as { type?: string }).type === "protocol:auth-required")) {
          clearTimeout(deadline)
          resolve()
          return
        }
        setTimeout(poll, 5)
      }
      poll()
    })
    socket.send(JSON.stringify({ type: "protocol:auth", token: "secret-token" }))
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("hello timeout")), 5_000)
      const poll = () => {
        if (frames.some(frame => (frame as { type?: string }).type === "protocol:hello")) {
          clearTimeout(deadline)
          resolve()
          return
        }
        setTimeout(poll, 5)
      }
      poll()
    })
  } finally {
    socket?.terminate()
    await started?.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
