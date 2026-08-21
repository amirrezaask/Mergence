import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "vite-plus/test"
import WebSocket from "ws"
import { loadConfig } from "./config.js"
import { startHostServer } from "./server.js"

describe("host token gate", () => {
  it("keeps /health public and requires the token for API and WebSocket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-host-auth-"))
    const config = await loadConfig([
      dir,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--data-dir",
      path.join(dir, "data"),
      "--allowed-roots",
      dir,
      "--token",
      "s3cret",
      "--cors-origins",
      "https://client.example",
    ])
    const started = await startHostServer(config)
    const origin = `http://127.0.0.1:${started.port}`
    try {
      const health = await fetch(`${origin}/health`)
      assert.equal(health.status, 200)

      const denied = await fetch(`${origin}/api/v1/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "yaade:getHomeDir", args: [] }),
      })
      assert.equal(denied.status, 401)

      const allowed = await fetch(`${origin}/api/v1/rpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer s3cret",
        },
        body: JSON.stringify({ channel: "yaade:getHomeDir", args: [] }),
      })
      assert.equal(allowed.status, 200)
      const body = (await allowed.json()) as { value: string }
      assert.equal(typeof body.value, "string")

      const crossOrigin = await fetch(`${origin}/api/v1/rpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer s3cret",
          origin: "https://client.example",
        },
        body: JSON.stringify({ channel: "yaade:getHomeDir", args: [] }),
      })
      assert.equal(crossOrigin.status, 200)
      assert.equal(
        crossOrigin.headers.get("access-control-allow-origin"),
        "https://client.example",
      )

      const wsDenied = await new Promise<number | string>(resolve => {
        const socket = new WebSocket(`ws://127.0.0.1:${started.port}/ws`)
        socket.on("unexpected-response", (_req, res) => {
          resolve(res.statusCode ?? "error")
        })
        socket.on("open", () => {
          socket.close()
          resolve("open")
        })
        socket.on("error", () => resolve("error"))
      })
      assert.ok(wsDenied === 401 || wsDenied === "error")

      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${started.port}/ws?token=s3cret`,
        )
        socket.on("open", () => {
          socket.close()
          resolve()
        })
        socket.on("error", reject)
      })
    } finally {
      await started.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
