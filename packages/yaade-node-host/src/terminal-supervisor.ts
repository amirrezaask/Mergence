import net from "node:net"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { TerminalHost, type TerminalLaunch } from "./terminal.js"
import {
  captureProcessIdentity,
  matchesProcessIdentity,
  type ProcessIdentity,
} from "./process-identity.js"

export type SupervisorManifest = {
  schemaVersion: 1
  supervisorId: string
  supervisorEpoch: string
  protocolVersion: number
  pid: number
  processIdentity: ProcessIdentity | null
  socketPath: string
  startedAt: string
}

export type SupervisorMessage =
  | {
      kind: "req"
      id: number
      op: string
      args: unknown[]
    }
  | {
      kind: "res"
      id: number
      ok: boolean
      value?: unknown
      error?: string
    }
  | {
      kind: "event"
      channel: string
      args: unknown[]
    }

export function supervisorSocketPath(dataDir: string): string {
  if (process.platform === "win32") {
    const tag = dataDir.replace(/[^a-zA-Z0-9]/g, "").slice(-24) || "yaade"
    return `\\\\.\\pipe\\yaade-pty-${tag}`
  }
  return path.join(dataDir, "pty-supervisor.sock")
}

export function supervisorPidPath(dataDir: string): string {
  return path.join(dataDir, "pty-supervisor.pid")
}

export function supervisorManifestPath(dataDir: string): string {
  return path.join(dataDir, "pty-supervisor.json")
}

export function supervisorLockPath(dataDir: string): string {
  return path.join(dataDir, "pty-supervisor.lock")
}

export function encodeSupervisorFrame(message: SupervisorMessage): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8")
  const header = Buffer.alloc(4)
  header.writeUInt32BE(json.byteLength, 0)
  return Buffer.concat([header, json])
}

export class SupervisorFrameReader {
  private buffer = Buffer.alloc(0)

  push(chunk: Buffer): SupervisorMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const out: SupervisorMessage[] = []
    while (this.buffer.byteLength >= 4) {
      const size = this.buffer.readUInt32BE(0)
      if (size > 16 * 1024 * 1024) {
        this.buffer = Buffer.alloc(0)
        throw new Error("supervisor frame too large")
      }
      if (this.buffer.byteLength < 4 + size) break
      const json = this.buffer.subarray(4, 4 + size).toString("utf8")
      this.buffer = this.buffer.subarray(4 + size)
      out.push(JSON.parse(json) as SupervisorMessage)
    }
    return out
  }
}

function applyOp(
  host: TerminalHost,
  op: string,
  args: unknown[],
  identity: Pick<SupervisorManifest, "supervisorId" | "supervisorEpoch">,
): unknown {
  switch (op) {
    case "create":
      return host.create(
        String(args[0] ?? ""),
        (args[1] as TerminalLaunch | null | undefined) ?? null,
        String(args[2] ?? "supervisor"),
        typeof args[3] === "string" ? args[3] : undefined,
      )
    case "write":
      return host.write(String(args[0] ?? ""), String(args[1] ?? ""))
    case "writeBinary":
      return host.writeBinary(String(args[0] ?? ""), String(args[1] ?? ""))
    case "resize":
      return host.resize(
        String(args[0] ?? ""),
        typeof args[1] === "number" ? args[1] : undefined,
        typeof args[2] === "number" ? args[2] : undefined,
      )
    case "acknowledgeData":
      return host.acknowledgeData(
        String(args[0] ?? ""),
        typeof args[1] === "number" ? args[1] : Number(args[1] ?? 0),
        typeof args[2] === "string" ? args[2] : undefined,
      )
    case "clearUnacknowledgedChars":
      return host.clearUnacknowledgedChars(String(args[0] ?? ""))
    case "pauseForBackpressure":
      host.pauseForBackpressure(
        Array.isArray(args[0]) ? args[0].map(String) : undefined,
      )
      return null
    case "armLiveViewer":
      host.armLiveViewer(String(args[0] ?? ""), String(args[1] ?? ""))
      return null
    case "resumeForClient":
      host.resumeForClient(String(args[0] ?? ""))
      return null
    case "attach":
      return host.attach(
        String(args[0] ?? ""),
        String(args[1] ?? ""),
        typeof args[2] === "number" ? args[2] : undefined,
      )
    case "markReplayReady":
      return host.markReplayReady(String(args[0] ?? ""), String(args[1] ?? ""))
    case "hasViewer":
      return host.hasViewer(String(args[0] ?? ""), String(args[1] ?? ""))
    case "readOutput":
      return host.readOutput(
        String(args[0] ?? ""),
        typeof args[1] === "number" ? args[1] : undefined,
      )
    case "inspect":
      return host.inspect(String(args[0] ?? ""))
    case "listRunning":
      return host.listRunning()
    case "dispose":
      return host.dispose(String(args[0] ?? ""))
    case "stopAll":
      host.stopAll()
      return null
    case "getCwd":
      return host.getCwd(String(args[0] ?? ""))
    case "getForegroundProcess":
      return host.getForegroundProcess(
        String(args[0] ?? ""),
        args[1] === true,
      )
    case "waitForExit":
      return host.waitForExit(String(args[0] ?? ""))
    case "ping":
      return { ok: true, pid: process.pid }
    case "handshake":
      return {
        protocolVersion: 1,
        supervisorId: identity.supervisorId,
        supervisorEpoch: identity.supervisorEpoch,
        pid: process.pid,
        capabilities: {
          checkpoints: false,
          writerLeases: false,
          idempotentCreate: true,
        },
      }
    case "shutdown":
      host.stopAll()
      return null
    default:
      throw new Error(`unknown supervisor op: ${op}`)
  }
}

export async function listenTerminalSupervisor(
  socketPath: string,
  options?: {
    onShutdown?: () => void
    dataDir?: string
    manifestPath?: string
  },
): Promise<{
  host: TerminalHost
  close: () => Promise<void>
  manifest: SupervisorManifest
}> {
  const host = new TerminalHost()
  const clients = new Set<net.Socket>()
  const manifest: SupervisorManifest = {
    schemaVersion: 1,
    supervisorId: randomUUID(),
    supervisorEpoch: randomUUID(),
    protocolVersion: 1,
    pid: process.pid,
    processIdentity: captureProcessIdentity(process.pid),
    socketPath,
    startedAt: new Date().toISOString(),
  }
  host.setEmit((channel, args) => {
    const frame = encodeSupervisorFrame({ kind: "event", channel, args })
    for (const client of clients) {
      if (!client.destroyed) client.write(frame)
    }
  })
  const server = net.createServer((socket) => {
    clients.add(socket)
    const reader = new SupervisorFrameReader()
    const write = (message: SupervisorMessage) => {
      if (socket.destroyed) return
      socket.write(encodeSupervisorFrame(message))
    }
    socket.on("data", (chunk) => {
      let messages: SupervisorMessage[]
      try {
        messages = reader.push(chunk)
      } catch {
        socket.destroy()
        return
      }
      for (const message of messages) {
        if (message.kind !== "req") continue
        void Promise.resolve()
          .then(() =>
            applyOp(host, message.op, message.args, manifest),
          )
          .then((value) => {
            write({ kind: "res", id: message.id, ok: true, value })
            if (message.op === "shutdown") {
              host.stopAll()
              options?.onShutdown?.()
            }
          })
          .catch((error: unknown) => {
            write({
              kind: "res",
              id: message.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          })
      }
    })
    socket.on("close", () => {
      clients.delete(socket)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => resolve())
  })
  if (process.platform !== "win32") {
    try { fs.chmodSync(socketPath, 0o600) } catch { /* best effort */ }
  }
  const manifestPath = options?.manifestPath ??
    (options?.dataDir ? supervisorManifestPath(options.dataDir) : null)
  if (manifestPath) writeSupervisorManifest(manifestPath, manifest)
  const close = async () => {
    host.stopAll()
    for (const client of clients) client.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (manifestPath) removeSupervisorManifest(manifestPath, manifest)
  }
  return { host, close, manifest }
}

function writeSupervisorManifest(
  manifestPath: string,
  manifest: SupervisorManifest,
): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  const temporary = `${manifestPath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(manifest), { mode: 0o600 })
  try {
    fs.chmodSync(temporary, 0o600)
  } catch {
    /* Windows does not expose Unix mode bits. */
  }
  fs.renameSync(temporary, manifestPath)
}

function readSupervisorManifest(manifestPath: string): SupervisorManifest | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    const record = raw as Record<string, unknown>
    if (
      record.schemaVersion !== 1 ||
      typeof record.supervisorId !== "string" ||
      typeof record.supervisorEpoch !== "string" ||
      typeof record.protocolVersion !== "number" ||
      typeof record.pid !== "number" ||
      typeof record.socketPath !== "string" ||
      typeof record.startedAt !== "string"
    ) return null
    const processIdentity = record.processIdentity
    return {
      schemaVersion: 1,
      supervisorId: record.supervisorId,
      supervisorEpoch: record.supervisorEpoch,
      protocolVersion: record.protocolVersion,
      pid: record.pid,
      processIdentity:
        processIdentity && typeof processIdentity === "object"
          ? (processIdentity as ProcessIdentity)
          : null,
      socketPath: record.socketPath,
      startedAt: record.startedAt,
    }
  } catch {
    return null
  }
}

function removeSupervisorManifest(
  manifestPath: string,
  expected: SupervisorManifest,
): void {
  const current = readSupervisorManifest(manifestPath)
  if (!current || current.supervisorEpoch !== expected.supervisorEpoch) return
  try {
    fs.unlinkSync(manifestPath)
  } catch {
    /* already removed */
  }
}

async function acquireSupervisorLock(
  lockPath: string,
): Promise<import("node:fs/promises").FileHandle | null> {
  try {
    const handle = await fs.promises.open(lockPath, "wx", 0o600)
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        processIdentity: captureProcessIdentity(process.pid),
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    )
    return handle
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? error.code
      : undefined
    if (code !== "EEXIST") throw error
    try {
      const stat = await fs.promises.stat(lockPath)
      const raw: unknown = JSON.parse(await fs.promises.readFile(lockPath, "utf8"))
      const record = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : null
      const identity = record?.processIdentity
      const identityRecord = identity && typeof identity === "object" && !Array.isArray(identity)
        ? identity as ProcessIdentity
        : null
      const stale = identityRecord
        ? !matchesProcessIdentity(identityRecord)
        : Date.now() - stat.mtimeMs > 30_000
      if (stale) fs.unlinkSync(lockPath)
    } catch {
      /* Another starter may be writing or removing the lock. */
    }
    return null
  }
}

async function waitForSupervisor(
  socketPath: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await canPingSupervisor(socketPath)) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

export async function ensureTerminalSupervisor(
  dataDir: string,
): Promise<{ socketPath: string; spawned: boolean; manifest: SupervisorManifest | null }> {
  fs.mkdirSync(dataDir, { recursive: true })
  const socketPath = supervisorSocketPath(dataDir)
  const pidPath = supervisorPidPath(dataDir)
  const manifestPath = supervisorManifestPath(dataDir)
  const lockPath = supervisorLockPath(dataDir)

  if (await canPingSupervisor(socketPath)) {
    return { socketPath, spawned: false, manifest: readSupervisorManifest(manifestPath) }
  }

  // A live manifest with a temporarily slow socket is still an owned runtime;
  // do not start a competing supervisor merely because one ping timed out.
  const existing = readSupervisorManifest(manifestPath)
  if (existing) {
    if (
      existing.processIdentity &&
      matchesProcessIdentity(existing.processIdentity)
    ) {
      if (await waitForSupervisor(socketPath, 8_000)) {
        return { socketPath, spawned: false, manifest: readSupervisorManifest(manifestPath) }
      }
      throw new Error("pty supervisor is alive but did not accept a handshake")
    }
    // A legacy/migrated manifest without an OS identity cannot be proven
    // stale. Waiting is safer than unlinking a socket owned by a live process.
    if (!existing.processIdentity) {
      if (await waitForSupervisor(socketPath, 8_000)) {
        return { socketPath, spawned: false, manifest: readSupervisorManifest(manifestPath) }
      }
      throw new Error("pty supervisor identity is unavailable")
    }
  }

  let lock = await acquireSupervisorLock(lockPath)
  while (!lock) {
    if (await canPingSupervisor(socketPath)) {
      return { socketPath, spawned: false, manifest: readSupervisorManifest(manifestPath) }
    }
    await new Promise(resolve => setTimeout(resolve, 50))
    lock = await acquireSupervisorLock(lockPath)
  }

  let spawned = false
  try {
    if (await canPingSupervisor(socketPath)) {
      return { socketPath, spawned: false, manifest: readSupervisorManifest(manifestPath) }
    }
    // The lock closes the stale-owner race. Only remove paths after the
    // manifest has been proved stale or malformed.
    try { fs.unlinkSync(socketPath) } catch { /* no stale Unix socket */ }
    try { fs.unlinkSync(manifestPath) } catch { /* no stale manifest */ }
    spawnSupervisorProcess(dataDir, socketPath, pidPath, manifestPath)
    spawned = true
    if (await waitForSupervisor(socketPath, 8_000)) {
      return { socketPath, spawned, manifest: readSupervisorManifest(manifestPath) }
    }
    throw new Error("pty supervisor did not become ready")
  } finally {
    await lock.close()
    try { fs.unlinkSync(lockPath) } catch { /* another starter may have cleaned it */ }
  }
}

async function canPingSupervisor(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ path: socketPath })
    const reader = new SupervisorFrameReader()
    const timeout = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 400)
    socket.on("connect", () => {
      socket.write(
        encodeSupervisorFrame({ kind: "req", id: 1, op: "ping", args: [] }),
      )
    })
    socket.on("data", (chunk) => {
      try {
        const messages = reader.push(chunk)
        if (messages.some((message) => message.kind === "res" && message.ok)) {
          clearTimeout(timeout)
          socket.end()
          resolve(true)
        }
      } catch {
        clearTimeout(timeout)
        socket.destroy()
        resolve(false)
      }
    })
    socket.on("error", () => {
      clearTimeout(timeout)
      resolve(false)
    })
  })
}

function resolveSupervisorArgs(
  socketPath: string,
  pidPath: string,
  manifestPath: string,
): string[] | null {
  const entry = fileURLToPath(new URL("./pty-supervisor-bin.ts", import.meta.url))
  const compiled = entry.replace(/\.ts$/, ".js")
  const packaged = path.join(path.dirname(fileURLToPath(import.meta.url)), "pty-supervisor.mjs")
  const runTs = path.resolve(path.dirname(entry), "../../../scripts/run-ts.mjs")

  if (fs.existsSync(packaged)) {
    return [
      packaged,
      "--socket",
      socketPath,
      "--pid-file",
      pidPath,
      "--manifest",
      manifestPath,
    ]
  }
  if (fs.existsSync(runTs) && fs.existsSync(entry)) {
    return [
      runTs,
      entry,
      "--socket",
      socketPath,
      "--pid-file",
      pidPath,
      "--manifest",
      manifestPath,
    ]
  }
  if (fs.existsSync(compiled)) {
    return [
      compiled,
      "--socket",
      socketPath,
      "--pid-file",
      pidPath,
      "--manifest",
      manifestPath,
    ]
  }
  return null
}

function spawnSupervisorProcess(
  dataDir: string,
  socketPath: string,
  pidPath: string,
  manifestPath: string,
): ChildProcess {
  const args = resolveSupervisorArgs(socketPath, pidPath, manifestPath)
  if (!args) {
    throw new Error("cannot spawn pty supervisor: Vite+ TypeScript runner is unavailable")
  }
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, YAADE_PTY_SUPERVISOR_DATA_DIR: dataDir },
  })
  child.unref()
  return child
}
