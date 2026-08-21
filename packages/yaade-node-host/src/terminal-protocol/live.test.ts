import assert from "node:assert/strict"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { test } from "vite-plus/test"
import {
  encodeSupervisorProtocolMessage,
  SupervisorProtocolFrameReader,
} from "./codec.js"
import { listenTerminalSupervisor } from "../terminal-supervisor.js"

test("current-generation supervisor rejects expired, oversized, and unknown v2 commands", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-protocol-v2-"))
  const socketPath = path.join(dataDir, "runtime.sock")
  const supervisor = await listenTerminalSupervisor(socketPath, {
    semanticState: true,
    protocolMax: 2,
    ownerId: "owner-test",
  })
  try {
    const expired = await request(socketPath, {
      version: 2,
      kind: "command",
      requestId: "expired",
      deadlineUnixMs: Date.now() - 1,
      operation: "inspect",
      payload: { terminalId: "missing" },
    })
    assert.equal(expired.ok, false)
    assert.equal(expired.error?.code, "DEADLINE_EXPIRED")

    const unknown = await request(socketPath, {
      version: 2,
      kind: "command",
      requestId: "unknown",
      deadlineUnixMs: Date.now() + 5_000,
      operation: "inspect",
      payload: { terminalId: "missing" },
    })
    assert.equal(unknown.ok, true)
    assert.equal(unknown.value, null)

    const oversized = Buffer.alloc(4 + 70 * 1024)
    oversized.writeUInt32BE(70 * 1024, 0)
    const socket = net.connect({ path: socketPath })
    const closed = await new Promise<boolean>(resolve => {
      socket.once("connect", () => socket.write(oversized))
      socket.once("close", () => resolve(true))
      socket.once("error", () => resolve(true))
      setTimeout(() => {
        socket.destroy()
        resolve(true)
      }, 1_000)
    })
    assert.equal(closed, true)
  } finally {
    await supervisor.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test("v2 handshake rejects an incompatible protocol range and fragmented frames assemble", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-protocol-v2-range-"))
  const socketPath = path.join(dataDir, "runtime.sock")
  const supervisor = await listenTerminalSupervisor(socketPath, {
    semanticState: true,
    protocolMax: 2,
    ownerId: "owner-test",
  })
  try {
    const incompatible = await request(socketPath, {
      version: 2,
      kind: "command",
      requestId: "hello-bad",
      deadlineUnixMs: Date.now() + 5_000,
      operation: "handshake",
      payload: {
        protocolMin: 9,
        protocolMax: 9,
        runtimeVersion: "test",
        ownerId: "client",
        ownerEpoch: "epoch",
        capabilities: {
          semanticTerminalState: true,
          authoritativeLeases: true,
          structuredInput: true,
          historyPaging: true,
          subscriptions: true,
          draining: true,
        },
      },
    })
    assert.equal(incompatible.ok, false)
    assert.equal(incompatible.error?.code, "UNSUPPORTED_PROTOCOL")

    const inspect = {
      version: 2 as const,
      kind: "command" as const,
      requestId: "inspect-frag",
      deadlineUnixMs: Date.now() + 5_000,
      operation: "inspect" as const,
      payload: { terminalId: "missing" },
    }
    const frame = encodeSupervisorProtocolMessage(inspect)
    const socket = net.connect({ path: socketPath })
    const reader = new SupervisorProtocolFrameReader()
    const assembled = await new Promise<{ ok: boolean }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy()
        reject(new Error("fragmented inspect timed out"))
      }, 2_000)
      socket.once("connect", () => {
        socket.write(frame.subarray(0, 6))
        setTimeout(() => socket.write(frame.subarray(6)), 10)
      })
      socket.on("data", chunk => {
        const messages = reader.push(chunk)
        const response = messages.find(message => message.kind === "response")
        if (response && response.kind === "response") {
          clearTimeout(timeout)
          socket.end()
          resolve(response)
        }
      })
      socket.once("error", reject)
    })
    assert.equal(assembled.ok, true)
  } finally {
    await supervisor.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

async function request(
  socketPath: string,
  command: Parameters<typeof encodeSupervisorProtocolMessage>[0],
): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> {
  const socket = net.connect({ path: socketPath })
  const reader = new SupervisorProtocolFrameReader()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error("protocol request timed out"))
    }, 2_000)
    socket.once("connect", () => {
      socket.write(encodeSupervisorProtocolMessage(command))
    })
    socket.on("data", chunk => {
      try {
        const messages = reader.push(chunk)
        const response = messages.find(message => message.kind === "response")
        if (response && response.kind === "response") {
          clearTimeout(timeout)
          socket.end()
          resolve(response)
        }
      } catch (error) {
        clearTimeout(timeout)
        socket.destroy()
        reject(error)
      }
    })
    socket.once("error", error => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}
