import net from "node:net"
import fs from "node:fs"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { TerminalHost, type TerminalLaunch } from "./terminal.js"
import { isProcessAlive } from "./process-identity.js"

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

function applyOp(host: TerminalHost, op: string, args: unknown[]): unknown {
  switch (op) {
    case "create":
      return host.create(
        String(args[0] ?? ""),
        (args[1] as TerminalLaunch | null | undefined) ?? null,
        String(args[2] ?? "supervisor"),
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
    case "shutdown":
      host.stopAll()
      return null
    default:
      throw new Error(`unknown supervisor op: ${op}`)
  }
}

export async function listenTerminalSupervisor(
  socketPath: string,
  options?: { onShutdown?: () => void },
): Promise<{
  host: TerminalHost
  close: () => Promise<void>
}> {
  const host = new TerminalHost()
  const clients = new Set<net.Socket>()
  host.setEmit((channel, args) => {
    const frame = encodeSupervisorFrame({ kind: "event", channel, args })
    for (const client of clients) {
      if (!client.destroyed) client.write(frame)
    }
  })
  if (process.platform !== "win32") {
    try {
      fs.unlinkSync(socketPath)
    } catch {
      /* ignore */
    }
  }
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
          .then(() => applyOp(host, message.op, message.args))
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
  const close = async () => {
    host.stopAll()
    for (const client of clients) client.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return { host, close }
}

export async function ensureTerminalSupervisor(
  dataDir: string,
): Promise<{ socketPath: string; spawned: boolean }> {
  fs.mkdirSync(dataDir, { recursive: true })
  const socketPath = supervisorSocketPath(dataDir)
  const pidPath = supervisorPidPath(dataDir)
  if (await canPingSupervisor(socketPath)) {
    return { socketPath, spawned: false }
  }
  let stalePid: number | null = null
  try {
    const raw = fs.readFileSync(pidPath, "utf8").trim()
    const pid = Number(raw)
    if (Number.isInteger(pid) && pid > 0) stalePid = pid
  } catch {
    /* ignore */
  }
  if (stalePid && !isProcessAlive(stalePid) && process.platform !== "win32") {
    try {
      fs.unlinkSync(socketPath)
    } catch {
      /* ignore */
    }
  }
  spawnSupervisorProcess(dataDir, socketPath, pidPath)
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    if (await canPingSupervisor(socketPath)) {
      return { socketPath, spawned: true }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("pty supervisor did not become ready")
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

function resolveTsxCli(): string | null {
  const specifiers = [import.meta.url, path.join(process.cwd(), "package.json")]
  for (const spec of specifiers) {
    try {
      return createRequire(spec).resolve("tsx/cli")
    } catch {
      /* try the next resolver */
    }
  }
  return null
}

function spawnSupervisorProcess(
  dataDir: string,
  socketPath: string,
  pidPath: string,
): ChildProcess {
  const entry = fileURLToPath(new URL("./pty-supervisor-bin.ts", import.meta.url))
  const compiled = entry.replace(/\.ts$/, ".js")
  const tsxCli = resolveTsxCli()
  const args = tsxCli
    ? [tsxCli, entry, "--socket", socketPath, "--pid-file", pidPath]
    : fs.existsSync(compiled)
      ? [compiled, "--socket", socketPath, "--pid-file", pidPath]
      : null
  if (!args) {
    throw new Error("cannot spawn pty supervisor: tsx is not installed")
  }
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, YAADE_PTY_SUPERVISOR_DATA_DIR: dataDir },
  })
  child.unref()
  return child
}
