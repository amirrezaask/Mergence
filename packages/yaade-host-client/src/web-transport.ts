import type { YaadeHostTransport } from "./transport.js"
import {
  HostDisconnectedError,
  decodeTerminalDataFrame,
  encodeTerminalWsCommand,
  isTerminalWsHotOp,
  tryDecodeRealtimeHostEvent,
  type HostEvent,
  type TextFileReadResult,
  type TextFileWriteOptions,
  type TextFileWriteResult,
  type TerminalWsHotOp,
} from "@yaade/rpc"
import { Duration, Effect, Fiber } from "effect"
import { invokeHostRpc } from "./effect-host-client.js"
import { readTextFileHttp, writeTextFileHttp } from "./text-file-http.js"

async function runInvokePromise<T>(
  effect: ReturnType<typeof invokeHostRpc>,
): Promise<T> {
  const outcome = await Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: error => ({ ok: false as const, error }),
        onSuccess: value => ({ ok: true as const, value }),
      }),
    ),
  )
  if (!outcome.ok) throw outcome.error
  return outcome.value as T
}

export function acceptHostEvent(lastSequence: number, message: HostEvent): boolean {
  return (
    message.protocolVersion === 1 &&
    Array.isArray(message.args) &&
    message.sequence > lastSequence
  )
}

export function websocketUrl(
  location: Pick<Location, "protocol" | "host">,
  since = 0,
  clientId?: string,
): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:"
  const client = clientId ? `&clientId=${encodeURIComponent(clientId)}` : ""
  return `${protocol}//${location.host}/ws?since=${since}${client}`
}

/** Reconnect backoff matching legacy setTimeout: 250ms × 2^n, cap 10s. */
export function hostRealtimeReconnectDelay(attempt: number): Duration.Duration {
  return Duration.millis(Math.min(10_000, 250 * 2 ** Math.max(0, attempt)))
}

export function createClientId(
  cryptoSource: Crypto | undefined = globalThis.crypto,
): string {
  if (typeof cryptoSource?.randomUUID === "function") {
    return cryptoSource.randomUUID()
  }
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/**
 * Host realtime WS client.
 *
 * - Reconnect owned by an Effect Fiber (interrupt on `close`)
 * - `terminal:data` / `terminal:exit` use structural decode (no Schema)
 * - Binary `terminal:data` frames skip JSON.stringify/parse on the hot path
 * - Hot terminal control (`write`/`ack`/`resize`) sent fire-and-forget on WS
 * - In-flight HTTP invokes aborted with `HostDisconnectedError` on WS drop / close
 */
export class WebHostTransport implements YaadeHostTransport {
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private socket: WebSocket | null = null
  private reconnectAttempt = 0
  private lastSequence = 0
  private closed = false
  private readonly clientId = createClientId()
  private readonly pendingAborts = new Set<AbortController>()
  private loopFiber: Fiber.RuntimeFiber<void, never> | null = null

  constructor() {
    this.loopFiber = Effect.runFork(
      this.reconnectLoop().pipe(Effect.orDie, Effect.asVoid),
    )
  }

  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    if (this.closed) {
      throw new Error("host transport closed")
    }
    const ac = new AbortController()
    this.pendingAborts.add(ac)
    try {
      return await runInvokePromise<T>(
        invokeHostRpc(this.clientId, channel, args, { signal: ac.signal }),
      )
    } finally {
      this.pendingAborts.delete(ac)
    }
  }

  async invokeWithSignal<T>(
    channel: string,
    args: unknown[],
    signal: AbortSignal,
  ): Promise<T> {
    if (this.closed) throw new Error("host transport closed")
    if (signal.aborted) throw requestAbortError(signal)
    const ac = new AbortController()
    const abort = () => ac.abort(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    this.pendingAborts.add(ac)
    try {
      try {
        return await runInvokePromise<T>(
          invokeHostRpc(this.clientId, channel, args, { signal: ac.signal }),
        )
      } catch (error) {
        if (signal.aborted) throw requestAbortError(signal)
        throw error
      }
    } finally {
      signal.removeEventListener("abort", abort)
      this.pendingAborts.delete(ac)
    }
  }

  readTextFile(uri: string): Promise<TextFileReadResult> {
    return this.runTextFileRequest(signal => readTextFileHttp(uri, { signal }))
  }

  writeTextFile(
    uri: string,
    content: string,
    options: TextFileWriteOptions,
  ): Promise<TextFileWriteResult> {
    return this.runTextFileRequest(signal =>
      writeTextFileHttp(uri, content, options, { signal }),
    )
  }

  sendRealtime(channel: string, ...args: unknown[]): boolean {
    if (this.closed || !isTerminalWsHotOp(channel)) return false
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    try {
      socket.send(encodeTerminalWsCommand(channel as TerminalWsHotOp, args))
      return true
    } catch {
      return false
    }
  }

  on(channel: string, listener: (...args: unknown[]) => void): () => void {
    let channelListeners = this.listeners.get(channel)
    if (!channelListeners) {
      channelListeners = new Set()
      this.listeners.set(channel, channelListeners)
    }
    channelListeners.add(listener)
    return () => {
      channelListeners!.delete(listener)
      if (channelListeners!.size === 0) this.listeners.delete(channel)
    }
  }

  close(): void {
    this.closed = true
    this.rejectPending(
      new HostDisconnectedError({ message: "host transport closed" }),
    )
    const fiber = this.loopFiber
    this.loopFiber = null
    if (fiber) {
      Effect.runFork(Fiber.interrupt(fiber))
    }
    this.socket?.close()
    this.socket = null
  }

  private reconnectLoop(): Effect.Effect<void> {
    const self = this
    return Effect.gen(function* () {
      if (typeof WebSocket === "undefined") return
      while (!self.closed) {
        yield* self.openSession()
        if (self.closed) return
        self.dispatch("connection:status", "disconnected")
        self.rejectPending(
          new HostDisconnectedError({ message: "host websocket disconnected" }),
        )
        const delay = hostRealtimeReconnectDelay(self.reconnectAttempt++)
        yield* Effect.sleep(delay)
      }
    })
  }

  private openSession(): Effect.Effect<void> {
    const self = this
    return Effect.scoped(
      Effect.acquireRelease(
        Effect.sync(() => {
          const socket = new WebSocket(
            websocketUrl(window.location, self.lastSequence, self.clientId),
          )
          socket.binaryType = "arraybuffer"
          self.socket = socket
          return socket
        }),
        socket =>
          Effect.sync(() => {
            if (self.socket === socket) self.socket = null
            if (
              socket.readyState === WebSocket.OPEN ||
              socket.readyState === WebSocket.CONNECTING
            ) {
              socket.close()
            }
          }),
      ).pipe(
        Effect.flatMap(socket =>
          Effect.async<void>(resume => {
            let settled = false
            const finish = () => {
              if (settled) return
              settled = true
              resume(Effect.void)
            }
            socket.addEventListener("open", () => {
              self.reconnectAttempt = 0
              self.dispatch("connection:status", "connected")
            })
            socket.addEventListener("message", event => {
              if (typeof event.data !== "string") {
                self.handleBinaryMessage(event.data)
                return
              }
              let raw: unknown
              try {
                raw = JSON.parse(event.data)
              } catch {
                self.dispatch("protocol:error", "Invalid realtime message")
                return
              }
              const message = tryDecodeRealtimeHostEvent(raw)
              if (!message) {
                self.dispatch("protocol:error", "Unsupported realtime protocol")
                return
              }
              if (!acceptHostEvent(self.lastSequence, message)) return
              self.lastSequence = message.sequence
              if (message.channel === "server:shuttingDown") {
                self.rejectPending(
                  new HostDisconnectedError({ message: "host server shutting down" }),
                )
              }
              self.dispatch(message.channel, ...message.args)
            })
            socket.addEventListener("close", finish)
            socket.addEventListener("error", () => {
              try {
                socket.close()
              } catch {
                /* ignore */
              }
            })
            return Effect.sync(() => {
              try {
                socket.close()
              } catch {
                /* ignore */
              }
            })
          }),
        ),
      ),
    )
  }

  private handleBinaryMessage(data: unknown): void {
    // Prefer zero-copy views — decodeTerminalDataFrame accepts ArrayBufferView.
    // Avoid TypedArray.buffer.slice() which allocated on every terminal:data frame.
    let frame: ArrayBuffer | ArrayBufferView | null = null
    if (data instanceof ArrayBuffer) frame = data
    else if (ArrayBuffer.isView(data)) frame = data
    if (!frame) {
      this.dispatch("protocol:error", "Unsupported realtime binary message")
      return
    }
    const decoded = decodeTerminalDataFrame(frame)
    if (!decoded) {
      this.dispatch("protocol:error", "Unsupported realtime binary message")
      return
    }
    const message: HostEvent = {
      protocolVersion: 1,
      sequence: decoded.eventSequence,
      channel: "terminal:data",
      args: [decoded.id, decoded.data, decoded.terminalSequence],
    }
    if (!acceptHostEvent(this.lastSequence, message)) return
    this.lastSequence = message.sequence
    this.dispatch(message.channel, ...message.args)
  }

  private rejectPending(error: HostDisconnectedError): void {
    for (const ac of [...this.pendingAborts]) {
      ac.abort(error)
    }
  }

  private async runTextFileRequest<T>(
    request: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new Error("host transport closed")
    const controller = new AbortController()
    this.pendingAborts.add(controller)
    try {
      return await request(controller.signal)
    } finally {
      this.pendingAborts.delete(controller)
    }
  }

  private dispatch(channel: string, ...args: unknown[]): void {
    this.listeners.get(channel)?.forEach(listener => listener(...args))
  }
}

function requestAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && signal.reason.name === "AbortError") {
    return signal.reason
  }
  const error = new Error(
    signal.reason instanceof Error ? signal.reason.message : "host invoke aborted",
  )
  error.name = "AbortError"
  return error
}

export function createWebTransport(): YaadeHostTransport {
  return new WebHostTransport()
}
