import net from "node:net"
import { randomUUID } from "node:crypto"
import {
  encodeSupervisorFrame,
  ensureTerminalSupervisor,
  SupervisorFrameReader,
  type SupervisorManifest,
  type SupervisorMessage,
} from "./terminal-supervisor.js"
import type {
  TerminalAttachSnapshot,
  TerminalCreateResult,
  TerminalInspectSnapshot,
  TerminalLaunch,
} from "./terminal.js"

type EmitFn = (channel: string, args: unknown[]) => void
type StateListener = (state: SupervisorConnectionState) => void

export type SupervisorConnectionState =
  | "connecting"
  | "healthy"
  | "degraded"
  | "reconnecting"
  | "lost"
  | "incompatible"
  | "closed"

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  op: string
  args: unknown[]
  retryable: boolean
}

const RECONNECT_DELAY_MS = 250
const MAX_RECONNECT_DELAY_MS = 5_000

function isLegacyHandshakeError(error: Error): boolean {
  return error instanceof Error && error.message === "unknown supervisor op: handshake"
}

export class SupervisedTerminalHost {
  private readonly dataDir: string
  private socketPath: string
  private socket: net.Socket | null = null
  private reader = new SupervisorFrameReader()
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private emit: EmitFn = () => {}
  private readonly stateListeners = new Set<StateListener>()
  private state: SupervisorConnectionState = "connecting"
  private supervisorEpoch: string | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private reconnectInFlight: Promise<void> | null = null
  private closed = false

  private constructor(dataDir: string, socketPath: string) {
    this.dataDir = dataDir
    this.socketPath = socketPath
  }

  static async connect(dataDir: string): Promise<SupervisedTerminalHost> {
    const ensured = await ensureTerminalSupervisor(dataDir)
    const client = new SupervisedTerminalHost(dataDir, ensured.socketPath)
    await client.open(ensured.manifest)
    return client
  }

  get connectionState(): SupervisorConnectionState {
    return this.state
  }

  get currentSupervisorEpoch(): string | null {
    return this.supervisorEpoch
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  setEmit(emit: EmitFn): void {
    this.emit = emit
  }

  create(
    cwdUri: string,
    launch: TerminalLaunch | null | undefined,
    clientId: string,
    requestId?: string,
  ): Promise<TerminalCreateResult> {
    const idempotencyKey = requestId ?? `${clientId}:${randomUUID()}`
    return this.rpc(
      "create",
      [cwdUri, launch ?? null, clientId, idempotencyKey],
      true,
    ) as Promise<TerminalCreateResult>
  }

  write(id: string, data: string): Promise<null> {
    return this.rpc("write", [id, data]) as Promise<null>
  }

  writeBinary(id: string, dataBase64: string): Promise<null> {
    return this.rpc("writeBinary", [id, dataBase64]) as Promise<null>
  }

  resize(id: string, cols?: number, rows?: number): Promise<null> {
    return this.rpc("resize", [id, cols, rows]) as Promise<null>
  }

  acknowledgeData(id: string, charCount: number, clientId?: string): Promise<null> {
    return this.rpc("acknowledgeData", [id, charCount, clientId]) as Promise<null>
  }

  clearUnacknowledgedChars(id: string): Promise<null> {
    return this.rpc("clearUnacknowledgedChars", [id]) as Promise<null>
  }

  pauseForBackpressure(ids?: readonly string[]): Promise<null> {
    return this.rpc("pauseForBackpressure", [ids]) as Promise<null>
  }

  armLiveViewer(id: string, clientId: string): Promise<void> {
    return this.rpc("armLiveViewer", [id, clientId]) as Promise<void>
  }

  resumeForClient(clientId: string): Promise<void> {
    return this.rpc("resumeForClient", [clientId]) as Promise<void>
  }

  resumeAllLiveViewers(): Promise<void> {
    return this.rpc("resumeAllLiveViewers", []) as Promise<void>
  }

  attach(id: string, clientId: string, afterSequence?: number): Promise<TerminalAttachSnapshot | null> {
    return this.rpc("attach", [id, clientId, afterSequence]) as Promise<TerminalAttachSnapshot | null>
  }

  markReplayReady(id: string, clientId: string): Promise<null> {
    return this.rpc("markReplayReady", [id, clientId]) as Promise<null>
  }

  hasViewer(id: string, clientId: string): Promise<boolean> {
    return this.rpc("hasViewer", [id, clientId]) as Promise<boolean>
  }

  readOutput(id: string, maxBytes?: number): Promise<{ output: string; truncated: boolean } | null> {
    return this.rpc("readOutput", [id, maxBytes]) as Promise<{
      output: string
      truncated: boolean
    } | null>
  }

  inspect(id: string): Promise<TerminalInspectSnapshot | null> {
    return this.rpc("inspect", [id]) as Promise<TerminalInspectSnapshot | null>
  }

  listRunning(): Promise<TerminalInspectSnapshot[]> {
    return this.rpc("listRunning", []) as Promise<TerminalInspectSnapshot[]>
  }

  getCwd(id: string): Promise<string | null> {
    return this.rpc("getCwd", [id]) as Promise<string | null>
  }

  getForegroundProcess(id: string, fresh = false): Promise<string | null> {
    return this.rpc("getForegroundProcess", [id, fresh]) as Promise<string | null>
  }

  waitForExit(id: string): Promise<{ exitCode: number | null; signal?: string }> {
    return this.rpc("waitForExit", [id]) as Promise<{
      exitCode: number | null
      signal?: string
    }>
  }

  dispose(id: string): Promise<null> {
    return this.rpc("dispose", [id], true) as Promise<null>
  }

  stopAll(): Promise<void> {
    return this.rpc("stopAll", [], true) as Promise<void>
  }

  async disconnect(): Promise<void> {
    this.closed = true
    this.setState("closed")
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.rejectAll(new Error("pty supervisor client closed"))
    const socket = this.socket
    this.socket = null
    if (!socket) return
    await new Promise<void>(resolve => {
      socket.once("close", () => resolve())
      socket.end(() => resolve())
      setTimeout(resolve, 250).unref?.()
    })
  }

  async shutdownSupervisor(): Promise<void> {
    try {
      await this.rpc("shutdown", [], false)
    } catch {
      /* supervisor may exit before the response is fully flushed */
    }
    await this.disconnect()
  }

  private setState(next: SupervisorConnectionState): void {
    if (this.state === next) return
    this.state = next
    for (const listener of this.stateListeners) {
      try {
        listener(next)
      } catch {
        /* observers must not break the supervisor connection */
      }
    }
  }

  private async open(manifest: SupervisorManifest | null): Promise<void> {
    this.setState("connecting")
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const candidate = net.connect({ path: this.socketPath })
      let settled = false
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        candidate.destroy()
        reject(error)
      }
      candidate.once("connect", () => {
        if (settled) return
        settled = true
        resolve(candidate)
      })
      candidate.once("error", fail)
    })
    this.socket = socket
    this.reader = new SupervisorFrameReader()
    socket.on("data", chunk => this.handleData(chunk))
    socket.on("error", () => {
      // `close` performs the single transition and reconnect scheduling.
    })
    socket.on("close", () => this.handleSocketLost(socket))

    let supervisorEpoch: string
    try {
      const handshake = await this.rpc("handshake", [], false) as {
        protocolVersion?: number
        supervisorEpoch?: string
      }
      if (handshake.protocolVersion !== 1 || !handshake.supervisorEpoch) {
        this.setState("incompatible")
        socket.destroy()
        return
      }
      supervisorEpoch = handshake.supervisorEpoch
    } catch (error) {
      // Supervisors created before the durable protocol do not know about
      // handshake yet, but their existing PTYs are still compatible with the
      // request surface. Keep them alive instead of failing every host start.
      if (!(error instanceof Error) || !isLegacyHandshakeError(error)) throw error
      supervisorEpoch = manifest?.supervisorEpoch ?? `legacy:${this.socketPath}`
    }
    const previousEpoch = this.supervisorEpoch
    this.supervisorEpoch = supervisorEpoch
    this.reconnectAttempt = 0
    const epochChanged = Boolean(previousEpoch && previousEpoch !== this.supervisorEpoch)
    if (epochChanged) {
      this.setState("lost")
      this.rejectRetryable(new Error("SUPERVISOR_EPOCH_CHANGED"))
      this.setState("healthy")
    } else {
      this.setState("healthy")
      this.resendPending()
    }
  }

  private handleData(chunk: Buffer): void {
    let messages: SupervisorMessage[]
    try {
      messages = this.reader.push(chunk)
    } catch (error) {
      this.socket?.destroy(error instanceof Error ? error : undefined)
      return
    }
    for (const message of messages) {
      if (message.kind === "event") {
        this.emit(message.channel, message.args)
        continue
      }
      if (message.kind !== "res") continue
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      if (message.ok) pending.resolve(message.value)
      else pending.reject(new Error(message.error ?? "supervisor error"))
    }
  }

  private handleSocketLost(socket: net.Socket): void {
    if (this.socket !== socket) return
    this.socket = null
    const error = new Error("SUPERVISOR_UNAVAILABLE")
    for (const [id, pending] of this.pending) {
      if (pending.retryable) continue
      this.pending.delete(id)
      pending.reject(error)
    }
    if (this.closed || this.state === "incompatible") return
    this.setState("reconnecting")
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || this.reconnectInFlight) return
    const delay = Math.min(
      MAX_RECONNECT_DELAY_MS,
      RECONNECT_DELAY_MS * 2 ** this.reconnectAttempt,
    )
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnect()
    }, delay)
  }

  private async reconnect(): Promise<void> {
    if (this.closed || this.reconnectInFlight) return
    const attempt = (this.reconnectInFlight = (async () => {
      try {
        const ensured = await ensureTerminalSupervisor(this.dataDir)
        this.socketPath = ensured.socketPath
        await this.open(ensured.manifest)
      } catch {
        this.reconnectAttempt += 1
        this.setState("degraded")
        this.scheduleReconnect()
      } finally {
        this.reconnectInFlight = null
      }
    })())
    await attempt
  }

  private resendPending(): void {
    const socket = this.socket
    if (!socket || socket.destroyed || socket.readyState !== "open") return
    for (const [id, pending] of this.pending) {
      if (!pending.retryable) continue
      try {
        socket.write(encodeSupervisorFrame({ kind: "req", id, op: pending.op, args: pending.args }))
      } catch {
        socket.destroy()
        return
      }
    }
  }

  private rejectRetryable(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (!pending.retryable) continue
      this.pending.delete(id)
      pending.reject(error)
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private rpc(op: string, args: unknown[], retryable = false): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("pty supervisor client closed"))
    if (this.state === "incompatible") {
      return Promise.reject(new Error("SUPERVISOR_PROTOCOL_INCOMPATIBLE"))
    }
    const socket = this.socket
    if ((!socket || socket.destroyed) && !retryable) {
      return Promise.reject(new Error("SUPERVISOR_UNAVAILABLE"))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, op, args, retryable })
      if (!socket || socket.destroyed) {
        this.setState("reconnecting")
        this.scheduleReconnect()
        return
      }
      try {
        socket.write(encodeSupervisorFrame({ kind: "req", id, op, args }))
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}
