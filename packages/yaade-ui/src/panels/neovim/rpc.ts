import { Decoder, Encoder } from "@msgpack/msgpack"

export const MAX_RPC_FRAME_BYTES = 2 * 1024 * 1024
export const MAX_PENDING_REQUESTS = 256

export type RpcNotification = {
  readonly method: string
  readonly args: readonly unknown[]
}

export type RpcServerRequest = {
  readonly id: number
  readonly method: string
  readonly args: readonly unknown[]
}

export type RpcDiagnostics = {
  readonly receivedBytes: number
  readonly decodedMessages: number
  readonly decodedNotifications: number
  readonly decodedResponses: number
  readonly decodedServerRequests: number
  readonly queuedBytes: number
  readonly peakQueuedBytes: number
  readonly rejectedFrames: number
}

export class RpcRemoteError extends Error {
  readonly name = "RpcRemoteError"

  constructor(
    readonly method: string,
    readonly details: unknown,
  ) {
    super(`Neovim RPC request failed: ${method}`)
  }
}

type PendingRequest = {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

type RpcClientOptions = {
  readonly send: (bytes: Uint8Array) => void
  readonly onNotification?: (notification: RpcNotification) => void
  readonly onServerRequest?: (request: RpcServerRequest) => Promise<unknown> | unknown
  readonly onError?: (error: Error) => void
  readonly requestTimeoutMs?: number
}

/**
 * A bounded, head-indexed queue.  Fragmented WebSocket delivery is common on
 * real connections; shifting every chunk made a long redraw stream spend a
 * surprising amount of time moving array elements.
 */
class ChunkQueue implements AsyncIterable<Uint8Array> {
  private readonly chunks: Uint8Array[] = []
  private readonly waiters: Array<(result: IteratorResult<Uint8Array>) => void> = []
  private head = 0
  private closed = false
  private queuedBytes = 0
  private peakQueuedBytes = 0

  push(chunk: Uint8Array): boolean {
    if (this.closed) return false
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value: chunk, done: false })
      return true
    }
    if (this.queuedBytes + chunk.byteLength > MAX_RPC_FRAME_BYTES) return false
    this.chunks.push(chunk)
    this.queuedBytes += chunk.byteLength
    this.peakQueuedBytes = Math.max(this.peakQueuedBytes, this.queuedBytes)
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true })
    }
  }

  queued(): number {
    return this.queuedBytes
  }

  peakQueued(): number {
    return this.peakQueuedBytes
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    while (true) {
      const chunk = this.chunks[this.head]
      if (chunk) {
        this.head += 1
        this.queuedBytes -= chunk.byteLength
        if (this.head >= 64 && this.head * 2 >= this.chunks.length) {
          this.chunks.splice(0, this.head)
          this.head = 0
        }
        yield chunk
        continue
      }
      if (this.closed) return
      const next = await new Promise<IteratorResult<Uint8Array>>(resolve => {
        this.waiters.push(resolve)
      })
      if (next.done) return
      yield next.value
    }
  }
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

/** Streaming, bounded Msgpack-RPC client for one Neovim UI socket. */
export class MsgpackRpcClient {
  private readonly encoder = new Encoder()
  private readonly decoder = new Decoder({
    maxArrayLength: 4096,
    maxMapLength: 4096,
    maxStrLength: MAX_RPC_FRAME_BYTES,
    maxBinLength: MAX_RPC_FRAME_BYTES,
  })
  private readonly chunks = new ChunkQueue()
  private readonly pending = new Map<number, PendingRequest>()
  private readonly requestTimeoutMs: number
  private nextRequestId = 1
  private closed = false
  private rejectedFrames = 0
  private receivedBytes = 0
  private decodedMessages = 0
  private decodedNotifications = 0
  private decodedResponses = 0
  private decodedServerRequests = 0
  private readonly decodePromise: Promise<void>

  constructor(private readonly options: RpcClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000
    this.decodePromise = this.decodeMessages()
  }

  request(method: string, args: readonly unknown[] = []): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Neovim RPC client is closed"))
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error("Neovim RPC request queue is full"))
    }
    const id = this.allocateRequestId()
    let frame: Uint8Array
    try {
      frame = this.encoder.encode([0, id, method, args])
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    if (frame.byteLength > MAX_RPC_FRAME_BYTES) {
      return Promise.reject(new Error("Neovim RPC request exceeds the 2 MiB limit"))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Neovim RPC request timed out: ${method}`))
      }, this.requestTimeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.options.send(frame)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, args: readonly unknown[] = []): void {
    if (this.closed) return
    let frame: Uint8Array
    try {
      frame = this.encoder.encode([2, method, args])
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (frame.byteLength > MAX_RPC_FRAME_BYTES) {
      this.fail(new Error("Neovim RPC notification exceeds the 2 MiB limit"))
      return
    }
    try {
      this.options.send(frame)
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  receive(chunk: ArrayBuffer | Uint8Array | ArrayLike<number>): void {
    if (this.closed) return
    const bytes = chunk instanceof Uint8Array
      ? chunk
      : chunk instanceof ArrayBuffer
        ? new Uint8Array(chunk)
        : Uint8Array.from(chunk)
    this.receivedBytes += bytes.byteLength
    if (bytes.byteLength > MAX_RPC_FRAME_BYTES) {
      this.rejectedFrames += 1
      this.fail(new Error("Neovim RPC frame exceeds the 2 MiB limit"))
      return
    }
    if (!this.chunks.push(bytes)) {
      this.rejectedFrames += 1
      this.fail(new Error("Neovim RPC receive queue exceeds the 2 MiB limit"))
    }
  }

  close(reason: Error = new Error("Neovim RPC client closed")): void {
    if (this.closed) return
    this.closed = true
    this.chunks.close()
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(reason)
      this.pending.delete(id)
    }
  }

  diagnostics(): RpcDiagnostics {
    return {
      receivedBytes: this.receivedBytes,
      decodedMessages: this.decodedMessages,
      decodedNotifications: this.decodedNotifications,
      decodedResponses: this.decodedResponses,
      decodedServerRequests: this.decodedServerRequests,
      queuedBytes: this.chunks.queued(),
      peakQueuedBytes: this.chunks.peakQueued(),
      rejectedFrames: this.rejectedFrames,
    }
  }

  /** Keeps the decoder alive for callers that want to await protocol failure. */
  decoding(): Promise<void> {
    return this.decodePromise
  }

  private async decodeMessages(): Promise<void> {
    try {
      for await (const message of this.decoder.decodeStream(this.chunks)) {
        this.decodedMessages += 1
        this.handleMessage(message)
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private handleMessage(message: unknown): void {
    if (!isUnknownArray(message) || message.length < 3 || message.length > 4 || !isFiniteInteger(message[0])) {
      this.fail(new Error("Malformed Neovim RPC message"))
      return
    }
    const type = message[0]
    if (type === 1) {
      this.decodedResponses += 1
      this.handleResponse(message)
      return
    }
    if (type === 2) {
      this.decodedNotifications += 1
      const method = message[1]
      const args = message[2]
      if (typeof method !== "string" || !isUnknownArray(args)) {
        this.fail(new Error("Malformed Neovim RPC notification"))
        return
      }
      this.options.onNotification?.({ method, args })
      return
    }
    if (type === 0) {
      this.decodedServerRequests += 1
      this.handleServerRequest(message)
      return
    }
    this.fail(new Error(`Unknown Neovim RPC message type: ${type}`))
  }

  private handleResponse(message: readonly unknown[]): void {
    if (message.length !== 4) {
      this.fail(new Error("Malformed Neovim RPC response"))
      return
    }
    const id = message[1]
    if (!isFiniteInteger(id)) {
      this.fail(new Error("Malformed Neovim RPC response id"))
      return
    }
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    const error = message[2]
    if (error !== null && error !== undefined && error !== false) {
      pending.reject(new RpcRemoteError(pending.method, error))
      return
    }
    pending.resolve(message[3])
  }

  private handleServerRequest(message: readonly unknown[]): void {
    if (message.length !== 4) {
      this.fail(new Error("Malformed Neovim RPC server request"))
      return
    }
    const id = message[1]
    const method = message[2]
    const args = message[3]
    if (!isFiniteInteger(id) || typeof method !== "string" || !isUnknownArray(args)) {
      this.fail(new Error("Malformed Neovim RPC server request"))
      return
    }
    if (!this.options.onServerRequest) {
      this.sendServerError(id, `Unsupported Neovim server request: ${method}`)
      return
    }
    const request = { id, method, args }
    void Promise.resolve(this.options.onServerRequest(request)).then(
      result => {
        if (this.closed) return
        this.sendServerResponse([1, id, null, result])
      },
      error => {
        if (this.closed) return
        const messageText = error instanceof Error ? error.message : String(error)
        this.sendServerError(id, messageText)
      },
    )
  }

  private sendServerError(id: number, message: string): void {
    this.sendServerResponse([1, id, [0, message], null])
  }

  private allocateRequestId(): number {
    while (this.pending.has(this.nextRequestId)) {
      this.nextRequestId += 1
      if (this.nextRequestId > Number.MAX_SAFE_INTEGER) this.nextRequestId = 1
    }
    const id = this.nextRequestId
    this.nextRequestId += 1
    if (this.nextRequestId > Number.MAX_SAFE_INTEGER) this.nextRequestId = 1
    return id
  }

  private sendServerResponse(message: readonly unknown[]): void {
    try {
      const frame = this.encoder.encode(message)
      if (frame.byteLength > MAX_RPC_FRAME_BYTES) {
        this.fail(new Error("Neovim RPC server response exceeds the 2 MiB limit"))
        return
      }
      this.options.send(frame)
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.options.onError?.(error)
    this.close(error)
  }
}
