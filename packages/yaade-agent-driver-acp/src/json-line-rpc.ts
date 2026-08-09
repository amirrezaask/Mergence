import type { AgentSpawnedProcess } from "@yaade/agent-driver"
import { Schema } from "effect"

type JsonObject = Record<string, unknown>
type RpcId = number | string

type Pending = {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

const MAX_PROTOCOL_LINE_BYTES = 2 * 1024 * 1024
const MAX_PENDING_REQUESTS = 64
const JsonObjectSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown })

export type JsonLineRpcRequest = {
  readonly id: RpcId
  readonly method: string
  readonly params: JsonObject
}

export class JsonLineRpc {
  // @agentclientprotocol/sdk 1.3.0 leaves NDJSON lines and pending responses
  // unbounded. Keep this injected transport until the SDK exposes equivalent
  // limits; provider spawning and host callbacks still remain context-owned.
  private nextId = 1
  private readonly pending = new Map<RpcId, Pending>()
  private readonly requestHandlers = new Set<(request: JsonLineRpcRequest) => void>()
  private readonly notificationHandlers = new Set<
    (method: string, params: JsonObject) => void
  >()
  private readonly closeHandlers = new Set<(error: Error) => void>()
  private readonly encoder = new TextEncoder()
  private readonly decoder = new TextDecoder()
  private closed = false
  private closeNotified = false
  private readonly pump: Promise<void>

  constructor(private readonly process: AgentSpawnedProcess) {
    this.pump = this.readLoop()
  }

  request(method: string, params: JsonObject): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("ACP connection is closed"))
    if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error("ACP pending request limit exceeded"))
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    void this.write({ jsonrpc: "2.0", id, method, params }).catch(error => {
      const pending = this.pending.get(id)
      this.pending.delete(id)
      pending?.reject(error instanceof Error ? error : new Error(String(error)))
    })
    return promise
  }

  notify(method: string, params: JsonObject): Promise<void> {
    return this.write({ jsonrpc: "2.0", method, params })
  }

  respond(id: RpcId, result: unknown): Promise<void> {
    return this.write({ jsonrpc: "2.0", id, result })
  }

  respondError(id: RpcId, code: number, message: string): Promise<void> {
    return this.write({ jsonrpc: "2.0", id, error: { code, message } })
  }

  onRequest(handler: (request: JsonLineRpcRequest) => void): () => void {
    this.requestHandlers.add(handler)
    return () => this.requestHandlers.delete(handler)
  }

  onNotification(handler: (method: string, params: JsonObject) => void): () => void {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  onClose(handler: (error: Error) => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  async close(graceMs = 1_000): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.process.stop(graceMs)
    await this.pump.catch(() => undefined)
    this.rejectPending(new Error("ACP connection closed"))
  }

  private write(message: JsonObject): Promise<void> {
    const line = this.encoder.encode(`${JSON.stringify(message)}\n`)
    if (line.byteLength > MAX_PROTOCOL_LINE_BYTES) {
      return Promise.reject(new Error("ACP protocol line exceeds the byte limit"))
    }
    return this.process.writeStdin(line)
  }

  private async readLoop(): Promise<void> {
    let buffer = ""
    try {
      for await (const chunk of this.process.stdout) {
        buffer += this.decoder.decode(chunk, { stream: true })
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const rawLine = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (this.encoder.encode(rawLine).byteLength > MAX_PROTOCOL_LINE_BYTES) {
            throw new Error("ACP process emitted an oversized protocol line")
          }
          const line = rawLine.trim()
          if (line) this.handleLine(line)
          newline = buffer.indexOf("\n")
        }
        if (this.encoder.encode(buffer).byteLength > MAX_PROTOCOL_LINE_BYTES) {
          throw new Error("ACP process emitted an oversized protocol line")
        }
      }
      buffer += this.decoder.decode()
      if (this.encoder.encode(buffer).byteLength > MAX_PROTOCOL_LINE_BYTES) {
        throw new Error("ACP process emitted an oversized protocol line")
      }
      if (buffer.trim()) this.handleLine(buffer.trim())
      const error = new Error("ACP process exited")
      this.rejectPending(error)
      if (!this.closed) this.notifyClose(error)
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.rejectPending(failure)
      if (!this.closed) this.notifyClose(failure)
    }
  }

  private handleLine(line: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      throw new Error("ACP process emitted malformed JSON")
    }
    const message = decodeJsonObject(raw, "JSON-RPC message")
    const rawId = message.id
    const id = typeof rawId === "string" || typeof rawId === "number" ? rawId : undefined
    const method = typeof message.method === "string" ? message.method : undefined
    if (method && id !== undefined) {
      const params = decodeJsonObject(message.params, `${method} params`)
      for (const handler of this.requestHandlers) handler({ id, method, params })
      return
    }
    if (method) {
      const params = decodeJsonObject(message.params, `${method} params`)
      for (const handler of this.notificationHandlers) handler(method, params)
      return
    }
    if (id === undefined) return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (message.error !== undefined) {
      const error = asObject(message.error)
      pending.reject(
        new Error(
          typeof error.message === "string"
            ? error.message
            : `ACP request ${String(id)} failed`,
        ),
      )
    } else {
      pending.resolve(message.result)
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }


  private notifyClose(error: Error): void {
    if (this.closed || this.closeNotified) return
    this.closeNotified = true
    for (const handler of this.closeHandlers) handler(error)
  }
}

export function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
}

export function decodeJsonObject(value: unknown, boundary: string): JsonObject {
  try {
    return Schema.decodeUnknownSync(JsonObjectSchema)(value)
  } catch (error) {
    throw new Error(`Malformed ACP ${boundary}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
