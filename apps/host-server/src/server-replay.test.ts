import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import WebSocket from "ws"
import { loadConfig } from "./config.js"
import type { HostEvent } from "./events.js"
import { startHostServer } from "./server.js"

test("stale WS reconnect receives replay-gap before retained history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-ws-replay-"))
  let close: (() => Promise<void>) | undefined
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
    const started = await startHostServer(config, { eventHubCapacity: 3 })
    close = started.close

    for (let index = 0; index < 5; index += 1) {
      started.runtime.events.emit("test:retained", [{ index }])
    }
    const replayWindow = started.runtime.events.replayWindow(1)
    assert.equal(replayWindow.historyEvicted, true)

    const messages = await new Promise<HostEvent[]>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${started.port}/ws?since=1`)
      const received: HostEvent[] = []
      const timeout = setTimeout(() => {
        socket.terminate()
        reject(new Error(`timed out after ${received.length} replay messages`))
      }, 5_000)
      socket.on("message", data => {
        received.push(JSON.parse(data.toString()))
        if (received.length === replayWindow.events.length + 1) {
          clearTimeout(timeout)
          socket.close()
          resolve(received)
        }
      })
      socket.on("error", reject)
    })

    const [gap, ...retained] = messages
    assert.equal(gap?.channel, "protocol:replay-gap")
    assert.deepEqual(gap?.args, [replayWindow.replayFloor, replayWindow.lastSequence])
    assert.equal(gap?.sequence, replayWindow.replayFloor - 1)
    assert.deepEqual(retained, replayWindow.events)
    assert.deepEqual(
      retained.map(event => event.sequence),
      Array.from(
        { length: replayWindow.lastSequence - replayWindow.replayFloor + 1 },
        (_, index) => replayWindow.replayFloor + index,
      ),
    )
  } finally {
    if (close) await close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
