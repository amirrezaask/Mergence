import fs from "node:fs"
import net from "node:net"
import {
  encodeSupervisorFrame,
  SupervisorFrameReader,
  supervisorManifestPath,
  supervisorSocketPath,
  type SupervisorManifest,
} from "../../../packages/yaade-node-host/src/terminal-supervisor.js"
import { waitUntil } from "./wait.js"
import type { SupervisorHandle } from "./types.js"

export function readSupervisorHandle(dataDir: string): SupervisorHandle | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(supervisorManifestPath(dataDir), "utf8"))
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    const record = raw as SupervisorManifest
    if (!record.supervisorId || !record.supervisorEpoch || !record.pid) return null
    return {
      supervisorId: record.supervisorId,
      supervisorEpoch: record.supervisorEpoch,
      pid: record.pid,
      socketPath: record.socketPath || supervisorSocketPath(dataDir),
      processIdentity: record.processIdentity,
    }
  } catch {
    return null
  }
}

export async function waitForSupervisor(dataDir: string, timeoutMs = 15_000): Promise<SupervisorHandle> {
  await waitUntil(() => readSupervisorHandle(dataDir) != null, timeoutMs, "supervisor manifest")
  const handle = readSupervisorHandle(dataDir)
  if (!handle) throw new Error("supervisor manifest missing")
  return handle
}

function supervisorRpc(socketPath: string, op: string, args: unknown[] = []): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath })
    const reader = new SupervisorFrameReader()
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error(`supervisor ${op} timed out`))
    }, 5_000)
    socket.on("connect", () => {
      socket.write(encodeSupervisorFrame({ kind: "req", id: 1, op, args }))
    })
    socket.on("data", chunk => {
      try {
        for (const message of reader.push(chunk)) {
          if (message.kind !== "res" || message.id !== 1) continue
          clearTimeout(timeout)
          socket.end()
          if (message.ok) resolve(message.value)
          else reject(new Error(message.error ?? `supervisor ${op} failed`))
        }
      } catch (error) {
        clearTimeout(timeout)
        socket.destroy()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.on("error", error => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

export async function pingSupervisor(dataDir: string): Promise<{
  ok: boolean
  pid?: number
  persistenceDegraded?: boolean
}> {
  const handle = readSupervisorHandle(dataDir)
  if (!handle) throw new Error("supervisor is not running")
  return (await supervisorRpc(handle.socketPath, "ping")) as {
    ok: boolean
    pid?: number
    persistenceDegraded?: boolean
  }
}

export async function dropSupervisorClients(dataDir: string): Promise<void> {
  const handle = readSupervisorHandle(dataDir)
  if (!handle) throw new Error("supervisor is not running")
  await supervisorRpc(handle.socketPath, "dropClients").catch(() => {
    /* The drop may close this probe connection before the response arrives. */
  })
}

export async function forceSupervisorCheckpoint(dataDir: string, ptyId: string): Promise<void> {
  const handle = readSupervisorHandle(dataDir)
  if (!handle) throw new Error("supervisor is not running")
  await supervisorRpc(handle.socketPath, "forceCheckpoint", [ptyId])
}

export async function injectSupervisorCheckpoint(
  dataDir: string,
  ptyId: string,
  checkpoint: unknown,
): Promise<void> {
  const handle = readSupervisorHandle(dataDir)
  if (!handle) throw new Error("supervisor is not running")
  await supervisorRpc(handle.socketPath, "injectCheckpoint", [ptyId, checkpoint])
}

export async function listSupervisorPtys(dataDir: string): Promise<Array<{ id: string }>> {
  const handle = readSupervisorHandle(dataDir)
  if (!handle) throw new Error("supervisor is not running")
  const value = await supervisorRpc(handle.socketPath, "listRunning")
  return Array.isArray(value) ? (value as Array<{ id: string }>) : []
}

export async function startIncompatibleSupervisor(dataDir: string): Promise<{
  close: () => Promise<void>
  socketPath: string
}> {
  fs.mkdirSync(dataDir, { recursive: true })
  const socketPath = supervisorSocketPath(dataDir)
  try { fs.unlinkSync(socketPath) } catch { /* no stale socket */ }
  const server = net.createServer(socket => {
    const reader = new SupervisorFrameReader()
    socket.on("data", chunk => {
      try {
        for (const message of reader.push(chunk)) {
          if (message.kind !== "req") continue
          if (message.op === "ping") {
            socket.write(encodeSupervisorFrame({
              kind: "res",
              id: message.id,
              ok: true,
              value: { ok: true, pid: process.pid },
            }))
            continue
          }
          if (message.op === "handshake") {
            socket.write(encodeSupervisorFrame({
              kind: "res",
              id: message.id,
              ok: true,
              value: {
                protocolVersion: 99,
                supervisorId: "incompatible",
                supervisorEpoch: "incompatible-epoch",
                pid: process.pid,
              },
            }))
            continue
          }
          socket.write(encodeSupervisorFrame({
            kind: "res",
            id: message.id,
            ok: false,
            error: "SUPERVISOR_PROTOCOL_INCOMPATIBLE",
          }))
        }
      } catch {
        socket.destroy()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => resolve())
  })
  return {
    socketPath,
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
      try { fs.unlinkSync(socketPath) } catch { /* already gone */ }
    },
  }
}
