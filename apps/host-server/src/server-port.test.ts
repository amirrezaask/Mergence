import assert from "node:assert/strict"
import { createServer } from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { loadConfig } from "./config.js"
import { startHostServer } from "./server.js"

async function occupyPort(host: string, port: number): Promise<() => Promise<void>> {
  const blocker = createServer((_req, res) => {
    res.statusCode = 200
    res.end("busy")
  })
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject)
    blocker.listen(port, host, () => resolve())
  })
  return () =>
    new Promise<void>((resolve, reject) => {
      blocker.close(err => (err ? reject(err) : resolve()))
    })
}

async function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, host, () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("no port"))
        return
      }
      const port = address.port
      server.close(err => (err ? reject(err) : resolve(port)))
    })
  })
}

describe("startHostServer port fallback", () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      const stop = cleanups.pop()
      if (stop) await stop()
    }
  })

  it("binds the next port when the preferred port is taken", async () => {
    const host = "127.0.0.1"
    const preferred = await freePort(host)
    const releaseBlocker = await occupyPort(host, preferred)
    cleanups.push(releaseBlocker)

    const dataDir = path.join(
      os.tmpdir(),
      `yaade-host-port-fallback-${process.pid}-${Date.now()}`,
    )
    const config = await loadConfig([
      "--host",
      host,
      "--port",
      String(preferred),
      "--data-dir",
      dataDir,
    ])
    const started = await startHostServer(config)
    cleanups.push(() => started.close())

    // Other test servers may occupy one or more subsequent ports while the
    // test runner executes files concurrently; the contract is to advance,
    // not to use a specific adjacent port.
    assert.ok(started.port > preferred)
    assert.equal(config.port, started.port)

    const health = await fetch(`http://${host}:${started.port}/health`)
    assert.equal(health.ok, true)
  })
})
