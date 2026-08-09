import type { AgentSpawnedProcess } from "@yaade/agent-driver"

type Json = Record<string, unknown>
type RpcId = string | number
type Pending = { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
export type RpcRequest = { readonly id: RpcId; readonly method: string; readonly params: Json }
export const object = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {}
const MAX_PROTOCOL_LINE_LENGTH = 2 * 1024 * 1024
const MAX_PENDING_REQUESTS = 64

export class JsonlRpc {
  private nextId = 1
  private closed = false
  private readonly pending = new Map<RpcId, Pending>()
  private readonly requests = new Set<(request: RpcRequest) => void>()
  private readonly notifications = new Set<(method: string, params: Json) => void>()
  private readonly decoder = new TextDecoder()
  private readonly encoder = new TextEncoder()
  private readonly pump: Promise<void>
  constructor(private readonly process: AgentSpawnedProcess) { this.pump = this.read() }
  request(method: string, params: Json): Promise<unknown> { if (this.closed) return Promise.reject(new Error("Codex app-server connection is closed")); if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error("Codex pending request limit exceeded")); const id = this.nextId++; const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject })); void this.write({ id, method, params }).catch(error => this.fail(id, error)); return result }
  notify(method: string, params: Json): Promise<void> { return this.write({ method, params }) }
  respond(id: RpcId, result: unknown): Promise<void> { return this.write({ id, result }) }
  onRequest(handler: (request: RpcRequest) => void): void { this.requests.add(handler) }
  onNotification(handler: (method: string, params: Json) => void): void { this.notifications.add(handler) }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; await this.process.stop(1_000); await this.pump.catch(() => undefined); this.rejectAll(new Error("Codex app-server closed")) }
  private write(message: Json): Promise<void> { return this.process.writeStdin(this.encoder.encode(`${JSON.stringify(message)}\n`)) }
  private fail(id: RpcId, error: unknown): void { const pending = this.pending.get(id); this.pending.delete(id); pending?.reject(error instanceof Error ? error : new Error(String(error))) }
  private async read(): Promise<void> { let buffer = ""; try { for await (const bytes of this.process.stdout) { buffer += this.decoder.decode(bytes, { stream: true }); if (buffer.length > MAX_PROTOCOL_LINE_LENGTH && !buffer.includes("\n")) throw new Error("Codex app-server emitted an oversized protocol line"); let end = buffer.indexOf("\n"); while (end >= 0) { const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (line.length > MAX_PROTOCOL_LINE_LENGTH) throw new Error("Codex app-server emitted an oversized protocol line"); if (line) this.line(line); end = buffer.indexOf("\n") } } this.rejectAll(new Error("Codex app-server exited")) } catch (error) { this.rejectAll(error instanceof Error ? error : new Error(String(error))) } }
  private line(line: string): void { let message: Json; try { message = JSON.parse(line) as Json } catch { this.rejectAll(new Error("Codex app-server emitted malformed JSON")); return } const method = typeof message.method === "string" ? message.method : undefined; const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined; if (method && id !== undefined) { const request = { id, method, params: object(message.params) }; for (const handler of this.requests) handler(request); return } if (method) { for (const handler of this.notifications) handler(method, object(message.params)); return } if (id === undefined) return; if (message.error !== undefined) { const err = object(message.error); this.fail(id, new Error(typeof err.message === "string" ? err.message : "Codex app-server request failed")); return } const pending = this.pending.get(id); this.pending.delete(id); pending?.resolve(message.result) }
  private rejectAll(error: Error): void { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear() }
}
