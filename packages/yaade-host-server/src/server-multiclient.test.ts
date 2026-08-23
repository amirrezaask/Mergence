import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { test } from "vite-plus/test"
import WebSocket from "ws"
import {
  decodeTerminalDataFrame,
  encodeTerminalWsCommand,
  tryDecodeTerminalWsResult,
} from "@yaade/rpc"
import { loadConfig } from "./config.js"
import { startHostServer } from "./server.js"

type IncomingFrame = {
  readonly data: WebSocket.RawData | string
  readonly binary: boolean
}

class SocketInbox {
  private readonly queued: IncomingFrame[] = []
  private readonly waiters: Array<{
    predicate: (frame: IncomingFrame) => boolean
    resolve: (frame: IncomingFrame) => void
  }> = []

  constructor(socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      const frame = { data, binary: isBinary }
      const index = this.waiters.findIndex(waiter => waiter.predicate(frame))
      if (index < 0) {
        this.queued.push(frame)
        return
      }
      this.waiters.splice(index, 1)[0]?.resolve(frame)
    })
  }

  matching(
    predicate: (frame: IncomingFrame) => boolean,
    timeoutMs = 5_000,
  ): Promise<IncomingFrame> {
    const queuedIndex = this.queued.findIndex(predicate)
    if (queuedIndex >= 0) {
      return Promise.resolve(this.queued.splice(queuedIndex, 1)[0]!)
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (frame: IncomingFrame) => {
          clearTimeout(timer)
          resolve(frame)
        },
      }
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error("timed out waiting for websocket frame"))
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  async result(requestId: string): Promise<void> {
    const frame = await this.matching(candidate => {
      if (candidate.binary) return false
      const result = tryDecodeTerminalWsResult(JSON.parse(String(candidate.data)))
      return result?.requestId === requestId
    })
    const result = tryDecodeTerminalWsResult(JSON.parse(String(frame.data)))
    if (!result?.ok) throw new Error(result?.error?.message ?? "terminal command failed")
  }

  async terminalData(terminalId: string, marker: string): Promise<string> {
    const frame = await this.matching(candidate => {
      if (!candidate.binary) return false
      const decoded = decodeTerminalDataFrame(toArrayBufferView(candidate.data))
      return decoded?.id === terminalId && decoded.data.includes(marker)
    })
    return decodeTerminalDataFrame(toArrayBufferView(frame.data))?.data ?? ""
  }
}

function toArrayBufferView(
  data: WebSocket.RawData | string,
): ArrayBuffer | ArrayBufferView {
  if (data instanceof ArrayBuffer) return data
  if (ArrayBuffer.isView(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return new TextEncoder().encode(data)
}

async function connect(origin: string, clientId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin}/ws?clientId=${clientId}`)
    socket.once("open", () => resolve(socket))
    socket.once("error", reject)
  })
}

function sendCommand(
  socket: WebSocket,
  requestId: string,
  op: "terminal:attach" | "terminal:write",
  args: unknown[],
): void {
  socket.send(encodeTerminalWsCommand(requestId, op, args))
}

test("two websocket clients receive the same live PTY and survive one disconnect", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-ws-multiclient-"))
  let started: Awaited<ReturnType<typeof startHostServer>> | undefined
  let clientA: WebSocket | undefined
  let clientB: WebSocket | undefined
  try {
    const workspace = path.join(root, "workspace")
    fs.mkdirSync(workspace, { recursive: true })
    const config = await loadConfig([
      workspace,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--data-dir",
      path.join(root, "data"),
      "--allowed-roots",
      root,
    ])
    started = await startHostServer(config)
    // This test owns a raw PTY, not foreground-process discovery. Disable the
    // background probe so teardown cannot race an in-flight SQLite read.

    const terminal = await Promise.resolve(
      started.runtime.terminal.create(
        pathToFileURL(workspace).href,
        {
          command: process.execPath,
          args: [
            "-e",
            [
              "process.stdin.on('data', chunk => {",
              "  const value = chunk.toString('utf8')",
              "  if (value.includes('one')) process.stdout.write('MULTI_CLIENT_ONE\\n')",
              "  if (value.includes('two')) process.stdout.write('MULTI_CLIENT_TWO\\n')",
              "})",
              "process.stdin.resume()",
              "setInterval(() => {}, 1e9)",
            ].join("\n"),
          ],
        },
        "server-multiclient-test",
      ),
    )
    const origin = `http://127.0.0.1:${started.port}`
    clientA = await connect(origin, "client-a")
    clientB = await connect(origin, "client-b")
    const inboxA = new SocketInbox(clientA)
    const inboxB = new SocketInbox(clientB)

    sendCommand(clientA, "attach-a", "terminal:attach", [terminal.id])
    sendCommand(clientB, "attach-b", "terminal:attach", [terminal.id])
    await Promise.all([inboxA.result("attach-a"), inboxB.result("attach-b")])

    sendCommand(clientA, "write-one", "terminal:write", [terminal.id, "one\n"])
    await Promise.all([
      inboxA.result("write-one"),
      inboxA.terminalData(terminal.id, "MULTI_CLIENT_ONE"),
      inboxB.terminalData(terminal.id, "MULTI_CLIENT_ONE"),
    ])

    // The second attached client is writable while the first is still live.
    sendCommand(clientB, "write-two-live", "terminal:write", [terminal.id, "two\n"])
    await Promise.all([
      inboxB.result("write-two-live"),
      inboxA.terminalData(terminal.id, "MULTI_CLIENT_TWO"),
      inboxB.terminalData(terminal.id, "MULTI_CLIENT_TWO"),
    ])

    await new Promise<void>((resolve, reject) => {
      clientA?.once("close", () => resolve())
      clientA?.once("error", reject)
      clientA?.close()
    })
    clientA = undefined

    sendCommand(clientB, "write-two", "terminal:write", [terminal.id, "two\n"])
    await Promise.all([
      inboxB.result("write-two"),
      inboxB.terminalData(terminal.id, "MULTI_CLIENT_TWO"),
    ])

    assert.equal(
      (await Promise.resolve(started.runtime.terminal.attach(terminal.id, "assertion")))?.status,
      "running",
    )
  } finally {
    clientA?.terminate()
    clientB?.terminate()
    await started?.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
