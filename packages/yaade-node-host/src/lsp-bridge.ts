import { spawn, type ChildProcess } from "node:child_process"
import { createServer, type Server as HttpServer } from "node:http"
import { WebSocketServer, type WebSocket } from "ws"
import type { LanguageServerDefinition } from "@yaade/rpc"
import { assertAllowedPath } from "./sandbox.js"
import { getLanguageServerDefinition, resolveLanguageServerCommand } from "./lsp-registry.js"
import { redactConfiguredEnvironment } from "./lsp-config.js"
import { uriToPath } from "./paths.js"

const MAX_WS_MESSAGE_BYTES = 10 * 1024 * 1024
const MAX_STDERR_BYTES = 32 * 1024
const MAX_PENDING_SERVER_MESSAGES = 256
/** Cap framing decoder buffer / Content-Length so malformed streams cannot grow forever. */
const MAX_LSP_FRAME_BYTES = MAX_WS_MESSAGE_BYTES

class StderrRingBuffer {
  private chunks: Buffer[] = []
  private size = 0

  append(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size > MAX_STDERR_BYTES && this.chunks.length > 0) {
      const removed = this.chunks.shift()!
      this.size -= removed.length
    }
  }

  snippet(): string {
    if (this.chunks.length === 0) return ""
    return Buffer.concat(this.chunks).toString("utf8")
  }
}

/** Decode LSP stdio Content-Length framing into raw JSON strings. */
export class LspFramingDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  feed(chunk: Buffer): string[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.length > MAX_LSP_FRAME_BYTES * 2) {
      // No complete frame and buffer already oversized — reset to avoid OOM.
      this.buffer = Buffer.alloc(0)
      return []
    }
    const messages: string[] = []
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n")
      if (headerEnd < 0) {
        if (this.buffer.length > MAX_LSP_FRAME_BYTES) {
          this.buffer = Buffer.alloc(0)
        }
        break
      }
      const header = this.buffer.subarray(0, headerEnd).toString("latin1")
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number.parseInt(match[1]!, 10)
      if (!Number.isFinite(length) || length < 0 || length > MAX_LSP_FRAME_BYTES) {
        this.buffer = Buffer.alloc(0)
        break
      }
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + length) break
      messages.push(this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8"))
      this.buffer = this.buffer.subarray(bodyStart + length)
    }
    return messages
  }
}

/** Encode raw JSON string to LSP stdio Content-Length framing. */
export function encodeLspMessage(json: string): string {
  const bytes = Buffer.byteLength(json, "utf8")
  return `Content-Length: ${bytes}\r\n\r\n${json}`
}

export type LspSession = {
  id: string
  serverId: string
  process: ChildProcess
  server: HttpServer
  wss: WebSocketServer
  port: number
  command: string
  rootUri: string
  definition: LanguageServerDefinition
  getStderrSnippet: () => string
  stopping: boolean
}

export type StartLspSessionOptions = {
  rootUri: string
  serverId: string
  definition?: LanguageServerDefinition
  allowedRoots?: string[]
  onSpawnError?: (id: string) => void
}

export type LspBridgeOptions = {
  allowedRoots?: readonly string[]
  resolveDefinition?: (serverId: string) => LanguageServerDefinition | undefined
  onCrash?: (id: string, stderrSnippet?: string) => void
  onClientDisconnected?: (id: string) => void
  onLog?: (id: string, stream: "host" | "stderr", message: string) => void
}

export type StartLspSessionResult = {
  id: string
  transportUrl: string
  error?: string
}

function closeSessionBridge(session: LspSession): void {
  for (const client of session.wss.clients) client.terminate()
  try {
    session.wss.close()
  } catch {
    /* already closed */
  }
  try {
    session.server.close()
  } catch {
    /* already closed */
  }
}

function attachSessionBridge(
  session: LspSession,
  proc: ChildProcess,
  stderrBuffer: StderrRingBuffer,
  onFinished: (crashed: boolean) => void,
  onClientDisconnected: () => void,
  onStderr: (message: string) => void,
  onSpawnError?: (id: string) => void,
): void {
  const decoder = new LspFramingDecoder()
  let activeWs: WebSocket | null = null
  const pendingServerMessages: string[] = []
  let finished = false

  const finish = (crashed: boolean) => {
    if (finished) return
    finished = true
    onFinished(crashed)
    pendingServerMessages.length = 0
    if (activeWs && activeWs.readyState === activeWs.OPEN) activeWs.close()
    closeSessionBridge(session)
  }

  proc.stdout?.on("data", (chunk: Buffer) => {
    for (const msg of decoder.feed(chunk)) {
      if (activeWs && activeWs.readyState === activeWs.OPEN) {
        activeWs.send(msg)
      } else {
        if (pendingServerMessages.length >= MAX_PENDING_SERVER_MESSAGES) {
          pendingServerMessages.shift()
        }
        pendingServerMessages.push(msg)
      }
    }
  })

  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer.append(chunk)
    onStderr(chunk.toString("utf8"))
  })

  session.wss.on("connection", (ws: WebSocket) => {
    if (activeWs && activeWs.readyState === activeWs.OPEN) {
      activeWs.close()
    }
    activeWs = ws

    for (const msg of pendingServerMessages) {
      if (ws.readyState === ws.OPEN) ws.send(msg)
    }
    pendingServerMessages.length = 0

    ws.on("message", (data: WebSocket.RawData) => {
      const buf =
        typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data as ArrayBuffer)
      if (buf.byteLength > MAX_WS_MESSAGE_BYTES) {
        ws.close(1009, "message too large")
        return
      }
      const json = buf.toString("utf8")
      proc.stdin?.write(encodeLspMessage(json))
    })

    ws.on("close", () => {
      if (activeWs === ws) {
        activeWs = null
        if (!session.stopping) onClientDisconnected()
      }
    })
  })

  proc.on("exit", () => {
    finish(!session.stopping)
  })

  proc.on("error", err => {
    onStderr(`LSP spawn error: ${err.message}`)
    finish(!session.stopping)
    onSpawnError?.(session.id)
  })
}

export class LspBridge {
  private readonly sessions = new Map<string, LspSession>()

  constructor(private readonly options: LspBridgeOptions = {}) {}

  async start(opts: StartLspSessionOptions): Promise<StartLspSessionResult> {
    const def = opts.definition ?? this.options.resolveDefinition?.(opts.serverId) ?? getLanguageServerDefinition(opts.serverId)
    if (!def || !def.enabled) {
      return { id: "", transportUrl: "", error: `Unknown language server: ${opts.serverId}` }
    }

    const resolved = resolveLanguageServerCommand(def)
    if ("error" in resolved) {
      return { id: "", transportUrl: "", error: resolved.error }
    }

    let cwd: string
    try {
      cwd = uriToPath(opts.rootUri)
      const allowedRoots = opts.allowedRoots ?? this.options.allowedRoots
      if (allowedRoots?.length) {
        cwd = await assertAllowedPath(cwd, [...allowedRoots])
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { id: "", transportUrl: "", error: message }
    }

    const server = createServer()
    const wss = new WebSocketServer({ server })

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve())
      server.on("error", reject)
    })

    const addr = server.address()
    const port = typeof addr === "object" && addr ? addr.port : 0
    const id = `lsp-${opts.serverId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const stderrBuffer = new StderrRingBuffer()
    const proc = spawn(resolved.command, resolved.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: { ...process.env, ...def.environment },
    })
    const spawned = new Promise<void>((resolve, reject) => {
      proc.once("spawn", resolve)
      proc.once("error", reject)
    })

    const session: LspSession = {
      id,
      serverId: opts.serverId,
      process: proc,
      server,
      wss,
      port,
      command: resolved.command,
      rootUri: opts.rootUri,
      definition: def,
      getStderrSnippet: () => stderrBuffer.snippet(),
      stopping: false,
    }

    this.sessions.set(id, session)
    const redact = (message: string) => redactConfiguredEnvironment(message, def.environment)
    attachSessionBridge(
      session,
      proc,
      stderrBuffer,
      crashed => {
        this.sessions.delete(session.id)
        if (crashed) this.options.onCrash?.(session.id, redact(stderrBuffer.snippet()))
      },
      () => this.options.onClientDisconnected?.(session.id),
      message => this.options.onLog?.(session.id, "stderr", redact(message)),
      opts.onSpawnError,
    )
    try {
      await spawned
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        id: "",
        transportUrl: "",
        error: `Could not start ${def.id}: ${message}`,
      }
    }
    this.options.onLog?.(session.id, "host", `Started ${def.id}`)

    return { id, transportUrl: `ws://127.0.0.1:${port}` }
  }

  async stop(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    session.stopping = true
    this.sessions.delete(id)
    session.process.kill()
    closeSessionBridge(session)
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      session.stopping = true
      session.process.kill()
      closeSessionBridge(session)
    }
    this.sessions.clear()
  }

  getSession(id: string): LspSession | undefined {
    return this.sessions.get(id)
  }
}
