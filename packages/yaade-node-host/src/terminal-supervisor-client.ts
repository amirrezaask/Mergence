import net from "node:net"
import { randomUUID } from "node:crypto"
import type { GhosttyMouseInput } from "@yaade/ghostty-core"
import {
  encodeSupervisorFrame,
  ensureTerminalSupervisor,
  SupervisorFrameReader,
  type SupervisorManifest,
  type SupervisorRpcError,
} from "./terminal-supervisor.js"
import type {
  TerminalAttachSnapshot,
  TerminalCreateResult,
  TerminalInspectSnapshot,
  TerminalLaunch,
} from "./terminal.js"
import {
  TerminalControlError,
  type TerminalControlErrorCode,
  type TerminalLease as RuntimeTerminalLease,
  type TerminalMutationFence,
} from "./terminal-control.js"
import { encodeSupervisorProtocolMessage } from "./terminal-protocol/codec.js"
import {
  isRecord,
  isRuntimeCapabilities,
  isSupervisorEvent,
  type RuntimeCapabilities,
  type SupervisorEvent,
} from "./terminal-protocol/schema.js"
import { encodeClientCommand } from "./terminal-protocol/client-encode.js"
import { MAX_PENDING_REQUESTS } from "./terminal-protocol/limits.js"

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
  deadlineUnixMs: number
  timeout: ReturnType<typeof setTimeout>
}

const RECONNECT_DELAY_MS = 250
const MAX_RECONNECT_DELAY_MS = 5_000
const SUPERVISOR_REQUEST_TIMEOUT_MS = (() => {
  const value = Number(process.env.YAADE_SUPERVISOR_REQUEST_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 10_000
})()

function isLegacyHandshakeError(error: Error): boolean {
  return error instanceof Error && error.message === "unknown supervisor op: handshake"
}

const CONTROL_ERROR_CODES = new Set<TerminalControlErrorCode>([
  "TERMINAL_NOT_FOUND",
  "TERMINAL_EPOCH_STALE",
  "WRITER_LEASE_REQUIRED",
  "WRITER_LEASE_STALE",
  "LEASE_NOT_HELD",
  "COMMAND_DUPLICATE",
])

function isSupervisorRpcError(value: unknown): value is SupervisorRpcError {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.code === "string" &&
    typeof record.terminalId === "string" &&
    typeof record.message === "string"
  )
}

function decodeSupervisorError(error: unknown): Error {
  if (isSupervisorRpcError(error) && CONTROL_ERROR_CODES.has(error.code as TerminalControlErrorCode)) {
    return new TerminalControlError(
      error.code as TerminalControlErrorCode,
      error.terminalId,
      error.message,
      error.leaseId,
    )
  }
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const record = error as Record<string, unknown>
    if (typeof record.code === "string" && typeof record.message === "string") {
      if (CONTROL_ERROR_CODES.has(record.code as TerminalControlErrorCode)) {
        return new TerminalControlError(
          record.code as TerminalControlErrorCode,
          typeof record.terminalId === "string" ? record.terminalId : "",
          record.message,
          typeof record.leaseId === "string" ? record.leaseId : undefined,
        )
      }
      return new Error(record.message)
    }
  }
  if (typeof error === "string") return new Error(error)
  return new Error("supervisor error")
}

export class SupervisedTerminalHost {
  private readonly dataDir: string
  private socketPath: string
  private readonly ensureSupervisorOnReconnect: boolean
  private reconnectManifest: SupervisorManifest | null = null
  private socket: net.Socket | null = null
  private reader = new SupervisorFrameReader()
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private emit: EmitFn = () => {}
  private readonly stateListeners = new Set<StateListener>()
  private state: SupervisorConnectionState = "connecting"
  private supervisorEpoch: string | null = null
  private capabilities: RuntimeCapabilities | null = null
  private negotiatedProtocol = 1
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private reconnectInFlight: Promise<void> | null = null
  private closed = false

  private constructor(
    dataDir: string,
    socketPath: string,
    ensureSupervisorOnReconnect = true,
  ) {
    this.dataDir = dataDir
    this.socketPath = socketPath
    this.ensureSupervisorOnReconnect = ensureSupervisorOnReconnect
  }

  static async connect(dataDir: string): Promise<SupervisedTerminalHost> {
    const ensured = await ensureTerminalSupervisor(dataDir)
    const client = new SupervisedTerminalHost(dataDir, ensured.socketPath)
    await client.open(ensured.manifest)
    return client
  }

  /** Connect to one already-discovered generation without spawning another. */
  static async connectGeneration(
    dataDir: string,
    socketPath: string,
  ): Promise<SupervisedTerminalHost> {
    const client = new SupervisedTerminalHost(dataDir, socketPath, false)
    await client.open(null)
    return client
  }

  get connectionState(): SupervisorConnectionState {
    return this.state
  }

  get currentSupervisorEpoch(): string | null {
    return this.supervisorEpoch
  }

  get negotiatedCapabilities(): RuntimeCapabilities | null {
    return this.capabilities
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

  acquireLease(
    terminalId: string,
    terminalEpoch: string,
    principalId: string,
    connectionId: string,
    mode: "writer" | "observer",
  ): Promise<RuntimeTerminalLease> {
    return this.rpc("acquireLease", [
      terminalId,
      terminalEpoch,
      principalId,
      connectionId,
      mode,
    ]) as Promise<RuntimeTerminalLease>
  }

  renewLease(
    terminalId: string,
    terminalEpoch: string,
    leaseId: string,
    principalId: string,
    connectionId: string,
  ): Promise<RuntimeTerminalLease> {
    return this.rpc("renewLease", [
      terminalId,
      terminalEpoch,
      leaseId,
      principalId,
      connectionId,
    ]) as Promise<RuntimeTerminalLease>
  }

  releaseLease(
    terminalId: string,
    terminalEpoch: string,
    leaseId: string,
    principalId: string,
    connectionId: string,
  ): Promise<null> {
    return this.rpc("releaseLease", [
      terminalId,
      terminalEpoch,
      leaseId,
      principalId,
      connectionId,
    ]) as Promise<null>
  }

  releaseConnection(connectionId: string): Promise<null> {
    return this.rpc("releaseConnection", [connectionId]) as Promise<null>
  }

  forceTakeover(
    terminalId: string,
    terminalEpoch: string,
    principalId: string,
    connectionId: string,
  ): Promise<RuntimeTerminalLease> {
    return this.rpc("forceTakeover", [
      terminalId,
      terminalEpoch,
      principalId,
      connectionId,
    ]) as Promise<RuntimeTerminalLease>
  }

  listLeases(terminalId: string): Promise<RuntimeTerminalLease[]> {
    return this.rpc("listLeases", [terminalId]) as Promise<RuntimeTerminalLease[]>
  }

  currentWriterLease(id: string): Promise<RuntimeTerminalLease | null> {
    return this.rpc("currentWriterLease", [id]) as Promise<RuntimeTerminalLease | null>
  }

  transferLease(
    terminalId: string,
    terminalEpoch: string,
    leaseId: string,
    principalId: string,
    connectionId: string,
    targetPrincipalId: string,
    targetConnectionId: string,
  ): Promise<RuntimeTerminalLease> {
    return this.rpc("transferLease", [
      terminalId,
      terminalEpoch,
      leaseId,
      principalId,
      connectionId,
      targetPrincipalId,
      targetConnectionId,
    ]) as Promise<RuntimeTerminalLease>
  }

  writeFenced(id: string, data: string, fence: TerminalMutationFence): Promise<null> {
    return this.rpc("writeFenced", [id, data, fence]) as Promise<null>
  }

  writeBinaryFenced(
    id: string,
    dataBase64: string,
    fence: TerminalMutationFence,
  ): Promise<null> {
    return this.rpc("writeBinaryFenced", [id, dataBase64, fence]) as Promise<null>
  }

  resizeFenced(
    id: string,
    cols: number | undefined,
    rows: number | undefined,
    fence: TerminalMutationFence,
  ): Promise<null> {
    return this.rpc("resizeFenced", [id, cols, rows, fence]) as Promise<null>
  }

  pasteFenced(id: string, data: string, fence: TerminalMutationFence): Promise<null> {
    return this.rpc("pasteFenced", [id, data, fence]) as Promise<null>
  }

  focusFenced(id: string, focused: boolean, fence: TerminalMutationFence): Promise<null> {
    return this.rpc("focusFenced", [id, focused, fence]) as Promise<null>
  }

  mouseFenced(
    id: string,
    input: GhosttyMouseInput,
    fence: TerminalMutationFence,
  ): Promise<null> {
    return this.rpc("mouseFenced", [id, input, fence]) as Promise<null>
  }

  disposeFenced(id: string, fence: TerminalMutationFence): Promise<null> {
    return this.rpc("disposeFenced", [id, fence], true) as Promise<null>
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

  readSemanticSnapshot(id: string): Promise<unknown> {
    return this.rpc("readSemanticSnapshot", [id])
  }

  readSemanticHistory(id: string, offset: number, limit: number): Promise<unknown> {
    return this.rpc("readSemanticHistory", [id, offset, limit])
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
    this.reconnectManifest = manifest
    this.negotiatedProtocol = 1
    this.capabilities = null
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
        protocolMax?: number
        supervisorEpoch?: string
        capabilities?: unknown
      }
      const protocol =
        handshake.protocolVersion === 2 || handshake.protocolMax === 2
          ? 2
          : handshake.protocolVersion === 1
            ? 1
            : 0
      if (protocol === 0 || !handshake.supervisorEpoch) {
        this.setState("incompatible")
        socket.destroy()
        return
      }
      if (protocol >= 2 && !isRuntimeCapabilities(handshake.capabilities)) {
        this.setState("incompatible")
        socket.destroy()
        return
      }
      this.negotiatedProtocol = protocol
      this.capabilities = isRuntimeCapabilities(handshake.capabilities)
        ? handshake.capabilities
        : null
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
    let messages: unknown[]
    try {
      messages = this.reader.push(chunk)
    } catch (error) {
      this.socket?.destroy(error instanceof Error ? error : undefined)
      return
    }
    for (const raw of messages) {
      if (isSupervisorEvent(raw)) {
        this.emitTypedEvent(raw)
        continue
      }
      if (!isRecord(raw) || !("kind" in raw)) continue
      if (raw.kind === "event") {
        const channel = raw.channel
        const args = raw.args
        if (typeof channel === "string" && Array.isArray(args)) {
          this.emit(channel, args)
        }
        continue
      }
      if (raw.kind === "response") {
        const requestId = raw.requestId
        if (typeof requestId !== "string") continue
        const id = Number(requestId)
        const pending = this.pending.get(id)
        if (!pending) continue
        this.pending.delete(id)
        clearTimeout(pending.timeout)
        if (raw.ok === true) pending.resolve(raw.value)
        else pending.reject(decodeSupervisorError(raw.error))
        continue
      }
      if (raw.kind !== "res" || typeof raw.id !== "number") continue
      const pending = this.pending.get(raw.id)
      if (!pending) continue
      this.pending.delete(raw.id)
      clearTimeout(pending.timeout)
      if (raw.ok === true) pending.resolve(raw.value)
      else pending.reject(decodeSupervisorError(raw.error))
    }
  }

  private emitTypedEvent(message: SupervisorEvent): void {
    if (!message.terminalId) return
    if (message.event === "terminal.output") {
      const data = message.payload.data
      const sequence = message.payload.sequence
      if (typeof data === "string") {
        this.emit("terminal:data", [
          message.terminalId,
          data,
          typeof sequence === "number" ? sequence : 0,
        ])
      }
      return
    }
    if (message.event === "terminal.semantic") {
      this.emit("terminal:semantic", [
        message.terminalId,
        message.revision ?? 0,
        message.terminalEpoch ?? "",
        message.payload.snapshot,
      ])
      return
    }
    if (message.event === "terminal.exited") {
      const exitCode = message.payload.exitCode
      const signal = message.payload.signal
      this.emit("terminal:exit", [
        message.terminalId,
        typeof exitCode === "number" ? exitCode : 0,
        typeof signal === "number" ? signal : undefined,
      ])
    }
  }

  private handleSocketLost(socket: net.Socket): void {
    if (this.socket !== socket) return
    this.socket = null
    const error = new Error("SUPERVISOR_UNAVAILABLE")
    for (const [id, pending] of this.pending) {
      if (pending.retryable) continue
      this.pending.delete(id)
      clearTimeout(pending.timeout)
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
        if (this.ensureSupervisorOnReconnect) {
          const ensured = await ensureTerminalSupervisor(this.dataDir)
          this.socketPath = ensured.socketPath
          await this.open(ensured.manifest)
        } else {
          await this.open(this.reconnectManifest)
        }
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
      if (pending.deadlineUnixMs <= Date.now()) {
        this.pending.delete(id)
        clearTimeout(pending.timeout)
        pending.reject(new Error("SUPERVISOR_REQUEST_TIMEOUT"))
        continue
      }
      try {
        socket.write(this.encodeRpc(id, pending.op, pending.args, pending.deadlineUnixMs))
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
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) clearTimeout(pending.timeout)
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
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error("SUPERVISOR_PENDING_REQUEST_LIMIT"))
    }
    const id = this.nextId++
    const deadlineUnixMs = Date.now() + SUPERVISOR_REQUEST_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        pending.reject(new Error("SUPERVISOR_REQUEST_TIMEOUT"))
      }, SUPERVISOR_REQUEST_TIMEOUT_MS)
      timeout.unref?.()
      this.pending.set(id, {
        resolve,
        reject,
        op,
        args,
        retryable,
        deadlineUnixMs,
        timeout,
      })
      if (!socket || socket.destroyed) {
        this.setState("reconnecting")
        this.scheduleReconnect()
        return
      }
      try {
        socket.write(this.encodeRpc(id, op, args, deadlineUnixMs))
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timeout)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private encodeRpc(
    id: number,
    op: string,
    args: unknown[],
    deadlineUnixMs: number,
  ): Buffer {
    if (this.negotiatedProtocol >= 2) {
      const command = encodeClientCommand(op, args, String(id), deadlineUnixMs)
      if (command) return encodeSupervisorProtocolMessage(command)
    }
    return encodeSupervisorFrame({
      kind: "req",
      id,
      op,
      args,
      deadlineUnixMs,
    })
  }
}
