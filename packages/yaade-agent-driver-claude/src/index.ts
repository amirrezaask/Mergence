import type { AgentDriver, AgentDriverContext, AgentDriverDetection, AgentDriverDetectionContext, AgentThreadConnection, OpenAgentThreadRequest, AgentSpawnedProcess } from "@yaade/agent-driver"
import { AgentCapabilities, AgentConfigurationOption, AgentConnectionId, AgentDriverDescriptor, UnsequencedAgentEvent, type AgentCommandEnvelope, type AgentCommandResult, type AgentEvent } from "@yaade/agent-protocol"
import { Schema } from "effect"

type Json = Record<string, unknown>
const MAX_SEMANTIC_TEXT_BYTES = 64 * 1024
export function truncateSemanticText(value: string): string { const encoder = new TextEncoder(); if (encoder.encode(value).byteLength <= MAX_SEMANTIC_TEXT_BYTES) return value; let bytes = 0; let end = 0; for (const character of value) { const size = encoder.encode(character).byteLength; if (bytes + size > MAX_SEMANTIC_TEXT_BYTES) break; bytes += size; end += character.length }; return value.slice(0, end) }
type Pending = { resolve: (value: Json) => void; reject: (error: Error) => void }
const MAX_PROTOCOL_LINE_LENGTH = 2 * 1024 * 1024
const text = (value: unknown): string => typeof value === "string" ? value : ""
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []

export type ClaudeAgentSdkOptions = { readonly command?: string; readonly args?: ReadonlyArray<string>; readonly env?: Readonly<Record<string, string>> }

/** Claude Agent SDK's stream-json protocol adapter. */
export class ClaudeAgentSdkDriver implements AgentDriver {
  readonly descriptor = Schema.decodeUnknownSync(AgentDriverDescriptor)({ id: "claude:agent-sdk", providerId: "claude", name: "Claude Agent SDK", integration: "agent-sdk", integrationVersion: "stream-json", priority: 100, supportsRemoteHost: true })
  constructor(private readonly options: ClaudeAgentSdkOptions = {}) {}

  async detect(context: AgentDriverDetectionContext): Promise<AgentDriverDetection> {
    if (context.signal.aborted) return { available: false, reason: "aborted" }
    const command = this.options.command ?? "claude"
    return await context.commands.resolveExecutable([command])
      ? { available: true, version: "stream-json" }
      : { available: false, reason: `${command} was not found on PATH` }
  }

  async openThread(context: AgentDriverContext, request: OpenAgentThreadRequest): Promise<AgentThreadConnection> {
    await context.workspace.assertAllowed(request.cwdUri)
    const process = await context.processSpawner.spawn({
      command: this.options.command ?? "claude",
      args: this.options.args ?? ["--input-format", "stream-json", "--output-format", "stream-json"],
      cwdUri: request.cwdUri,
      env: this.options.env ?? {},
    })
    const client = new ClaudeStreamClient(process)
    const initialized = await client.control("initialize", { cwd: request.cwdUri })
    const connection = new ClaudeConnection(context, client, capabilities(), configuration(initialized), request)
    client.onMessage(message => connection.handle(message))
    return connection
  }
}

class ClaudeConnection implements AgentThreadConnection {
  readonly binding: AgentThreadConnection["binding"]
  readonly capabilities = capabilities()
  readonly configuration: ReadonlyArray<AgentConfigurationOption>
  private readonly queue = new Queue<UnsequencedAgentEvent>()
  private readonly commands = new Set<string>()
  private readonly permissions = new Map<string, { requestId: string; behavior: string }>()
  private readonly items = new Map<string, { turnId: string; revision: number; text: string }>()
  private providerSessionId = ""
  private activeTurnId: string | null = null
  private closed = false
  private config: ReturnType<typeof configuration>

  constructor(private readonly context: AgentDriverContext, private readonly client: ClaudeStreamClient, _capabilities: AgentThreadConnection["capabilities"], configurationFromInit: ReturnType<typeof configuration>, request: OpenAgentThreadRequest) {
    this.config = configurationFromInit
    this.configuration = configurationFromInit
    const resume = request.mode.type === "new" ? "" : request.mode.providerSessionId
    this.providerSessionId = resume
    this.binding = { connectionId: Schema.decodeUnknownSync(AgentConnectionId)(`claude-sdk:${crypto.randomUUID()}`), ...(resume ? { providerSessionId: resume as never } : {}) }
  }

  events(signal?: AbortSignal): AsyncIterable<UnsequencedAgentEvent> { return this.queue.iterate(signal) }

  async send(command: AgentCommandEnvelope): Promise<AgentCommandResult> {
    if (this.commands.has(command.commandId)) return { status: "already-applied", commandId: command.commandId }
    if (this.closed) return reject(command.commandId, "claude.closed", "Claude connection closed", false)
    try {
      switch (command.command.type) {
        case "turn.submit": {
          const content = command.command.input.filter(part => part.type === "text").map(part => part.text).join("\n")
          this.activeTurnId = `claude:${command.commandId}`
          this.emit({ type: "turn.started", turnId: this.activeTurnId as never })
          this.emit({
            type: "item.started",
            item: {
              type: "user-message",
              id: `user:${command.commandId}` as never,
              turnId: this.activeTurnId as never,
              revision: 0,
              content: command.command.input.map(part =>
                part.type === "text"
                  ? part
                  : part.type === "workspace-resource"
                    ? part
                    : { type: "workspace-resource" as const, uri: part.attachmentId },
              ),
            },
          })
          await this.client.write({ type: "user", session_id: this.providerSessionId || "default", message: { role: "user", content } })
          break
        }
        case "turn.interrupt": await this.client.control("interrupt", { session_id: this.providerSessionId }); break
        case "action.respond": {
          const permission = this.permissions.get(command.command.actionId)
          if (!permission || command.command.response.type !== "permission") return reject(command.commandId, "claude.permission", "Unknown Claude permission choice", false)
          const choice = this.permissions.get(command.command.response.optionId)
          if (!choice || choice.requestId !== permission.requestId) return reject(command.commandId, "claude.permission", "Permission option was not advertised", false)
          this.permissions.delete(command.command.actionId)
          this.emit({ type: "action.resolved", actionId: command.command.actionId, response: command.command.response })
          await this.client.write({ type: "control_response", response: { subtype: "success", request_id: permission.requestId, response: { behavior: choice.behavior } } })
          break
        }
        case "configuration.set": await this.setConfiguration(command.command.optionId, command.command.value); break
        case "thread.close": await this.close("user"); break
      }
      this.commands.add(command.commandId)
      return { status: "accepted", commandId: command.commandId }
    } catch (error) { return reject(command.commandId, "claude.request", String(error), true) }
  }

  async close(reason: "user" | "runtime-shutdown" | "driver-restart"): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.queue.push(this.wrap({ type: "thread.closed", reason: reason === "user" ? "user" : "provider" }))
    this.queue.close()
    await this.client.close()
  }

  handle(message: Json): void {
    const type = text(message.type)
    if (type === "system" && text(message.subtype) === "init") {
      const sessionId = text(message.session_id)
      if (sessionId && sessionId !== this.providerSessionId) {
        this.providerSessionId = sessionId
        ;(this.binding as { providerSessionId?: string }).providerSessionId = sessionId
        this.emit({ type: "thread.binding-updated", providerSessionId: sessionId as never })
      }
      const updated = configuration(message, this.config)
      if (updated.length) { this.config = updated; this.emit({ type: "configuration.updated", configuration: updated }) }
      return
    }
    if (type === "control_request" && text(object(message.request).subtype) === "can_use_tool") { this.requestPermission(message); return }
    if (type === "stream_event") { this.streamEvent(message); return }
    if (type === "assistant") { this.assistant(message); return }
    if (type === "result") this.result(message)
  }

  private async setConfiguration(optionId: string, value: unknown): Promise<void> {
    if (typeof value !== "string") throw new Error("Claude configuration values must be strings")
    const subtype = optionId === "model" ? "set_model" : optionId === "permission" ? "set_permission_mode" : ""
    if (!subtype) throw new Error(`unsupported Claude configuration option: ${optionId}`)
    await this.client.control(subtype, optionId === "model" ? { model: value } : { mode: value })
    this.config = this.config.map(option => option.id === optionId && option.value.type === "enum" ? { ...option, value: { ...option.value, current: value } } : option)
    this.emit({ type: "configuration.updated", configuration: this.config })
  }

  private requestPermission(message: Json): void {
    const requestId = text(message.request_id)
    const request = object(message.request)
    const actionId = `claude:${requestId}`
    const allowId = `${actionId}:allow`; const denyId = `${actionId}:deny`
    if (this.permissions.size >= 64) {
      void this.client.write({ type: "control_response", response: { subtype: "error", request_id: requestId, error: "Claude pending action limit exceeded" } })
      return
    }
    this.permissions.set(actionId, { requestId, behavior: "" })
    this.permissions.set(allowId, { requestId, behavior: "allow" })
    this.permissions.set(denyId, { requestId, behavior: "deny" })
    this.emit({ type: "action.requested", action: { type: "permission", id: actionId as never, ...(this.activeTurnId ? { turnId: this.activeTurnId as never } : {}), createdAt: this.context.clock.now().toISOString(), title: text(request.title) || text(request.display_name) || "Claude permission", ...(text(request.description) ? { description: text(request.description) } : {}), options: [{ id: allowId, decision: "allow-once", label: "Allow" }, { id: denyId, decision: "reject-once", label: "Deny" }] } })
    this.emit({ type: "thread.status-changed", status: "waiting-for-action" })
  }

  private streamEvent(message: Json): void {
    const event = object(message.event); const index = Number(event.index ?? 0); const id = `${text(message.uuid) || "claude"}:${index}`
    if (text(event.type) === "content_block_start" && text(object(event.content_block).type) === "text") {
      if (!this.activeTurnId) return
      this.items.set(id, { turnId: this.activeTurnId, revision: 1, text: "" })
      this.emit({ type: "item.started", item: { type: "assistant-message", id: id as never, turnId: this.activeTurnId as never, revision: 1, text: "", status: "streaming" } }, text(message.uuid))
      return
    }
    if (text(event.type) === "content_block_delta") {
      const item = this.items.get(id); const delta = text(object(event.delta).text)
      if (!item || !delta) return
      const boundedDelta = truncateSemanticText(delta); item.revision += 1; item.text = truncateSemanticText(item.text + boundedDelta)
      this.emit({ type: "item.delta", itemId: id as never, revision: item.revision, text: boundedDelta }, text(message.uuid))
      return
    }
    if (text(event.type) === "content_block_stop") {
      const item = this.items.get(id); if (!item) return
      this.emit({ type: "item.completed", item: { type: "assistant-message", id: id as never, turnId: item.turnId as never, revision: item.revision + 1, text: item.text, status: "completed" } }, text(message.uuid))
    }
  }

  private assistant(message: Json): void {
    const content = truncateSemanticText(array(object(message.message).content).map(block => text(object(block).text)).join(""))
    if (!content || this.items.size) return
    if (!this.activeTurnId) return
    const id = `claude:${text(message.uuid) || crypto.randomUUID()}`
    this.emit({ type: "item.started", item: { type: "assistant-message", id: id as never, turnId: this.activeTurnId as never, revision: 1, text: "", status: "streaming" } })
    this.emit({ type: "item.delta", itemId: id as never, revision: 2, text: content })
    this.emit({ type: "item.completed", item: { type: "assistant-message", id: id as never, turnId: this.activeTurnId as never, revision: 3, text: content, status: "completed" } })
  }

  private result(message: Json): void {
    const sessionId = text(message.session_id)
    if (sessionId && sessionId !== this.providerSessionId) { this.providerSessionId = sessionId; this.emit({ type: "thread.binding-updated", providerSessionId: sessionId as never }) }
    const usage = object(message.usage); const cost = typeof message.total_cost_usd === "number" ? message.total_cost_usd : undefined
    if (Object.keys(usage).length || cost != null) this.emit({ type: "usage.updated", usage: { ...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}), ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}), ...(cost != null ? { costUsd: cost } : {}) } })
    const turnId = this.activeTurnId
    if (!turnId) return
    const subtype = text(message.subtype)
    if (subtype === "success") this.emit({ type: "turn.completed", turnId: turnId as never })
    else if (text(array(message.errors)[0]).includes("Interrupted")) this.emit({ type: "turn.interrupted", turnId: turnId as never })
    else this.emit({ type: "turn.failed", turnId: turnId as never, message: text(array(message.errors)[0]) || "Claude turn failed" })
    this.emit({ type: "thread.status-changed", status: "idle" })
    this.activeTurnId = null
  }

  private emit(event: AgentEvent, nativeEventId?: string): void { this.queue.push(this.wrap(event, nativeEventId)) }
  private wrap(event: AgentEvent, nativeEventId?: string): UnsequencedAgentEvent { return Schema.decodeUnknownSync(UnsequencedAgentEvent)({ occurredAt: this.context.clock.now().toISOString(), ...(nativeEventId ? { nativeEventId } : {}), event }) }
}

const MAX_PENDING_REQUESTS = 64

export class ClaudeStreamClient {
  private readonly decoder = new TextDecoder(); private readonly encoder = new TextEncoder(); private readonly pending = new Map<string, Pending>(); private readonly handlers = new Set<(message: Json) => void>(); private nextId = 1; private closed = false
  constructor(private readonly process: AgentSpawnedProcess) { void this.read() }
  onMessage(handler: (message: Json) => void): void { this.handlers.add(handler) }
  async write(message: Json): Promise<void> { if (this.closed) throw new Error("Claude process closed"); await this.process.writeStdin(this.encoder.encode(`${JSON.stringify(message)}\n`)) }
  control(subtype: string, request: Json): Promise<Json> { if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error("Claude pending request limit exceeded")); const requestId = `claude-control-${this.nextId++}`; const result = new Promise<Json>((resolve, reject) => this.pending.set(requestId, { resolve, reject })); void this.write({ type: "control_request", request_id: requestId, request: { subtype, ...request } }).catch(error => { const pending = this.pending.get(requestId); this.pending.delete(requestId); pending?.reject(error instanceof Error ? error : new Error(String(error))) }); return result }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; await this.process.stop(1_000); this.reject(new Error("Claude process closed")) }
  private async read(): Promise<void> { let buffer = ""; try { for await (const chunk of this.process.stdout) { buffer += this.decoder.decode(chunk, { stream: true }); if (buffer.length > MAX_PROTOCOL_LINE_LENGTH && !buffer.includes("\n")) throw new Error("Claude process emitted an oversized protocol line"); let index = buffer.indexOf("\n"); while (index >= 0) { const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1); if (line.length > MAX_PROTOCOL_LINE_LENGTH) throw new Error("Claude process emitted an oversized protocol line"); if (line) this.handle(line); index = buffer.indexOf("\n") } } } catch (error) { this.reject(error instanceof Error ? error : new Error(String(error))) } }
  private handle(line: string): void { let message: Json; try { message = JSON.parse(line) as Json } catch { return }; if (text(message.type) === "control_response") { const response = object(message.response); const pending = this.pending.get(text(response.request_id)); if (pending) { this.pending.delete(text(response.request_id)); if (text(response.subtype) === "success") pending.resolve(object(response.response)); else pending.reject(new Error(text(response.error) || "Claude control error")) }; return }; for (const handler of this.handlers) handler(message) }
  private reject(error: Error): void { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear() }
}

class Queue<T> { static readonly maxItems = 256; static readonly maxBytes = 1_048_576; private values: T[] = []; private waiters: Array<(value: IteratorResult<T>) => void> = []; private closed = false; private bytes = 0; private overflowed = false; get didOverflow(): boolean { return this.overflowed } push(value: T): boolean { if (this.closed) return false; const waiter = this.waiters.shift(); if (waiter) { waiter({ done: false, value }); return true }; const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength; if (this.values.length >= Queue.maxItems || this.bytes + bytes > Queue.maxBytes) { this.overflowed = true; this.close(); return false }; this.values.push(value); this.bytes += bytes; return true } close(): void { this.closed = true; for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined }) } async *iterate(signal?: AbortSignal): AsyncIterable<T> { while (!signal?.aborted) { const value = this.values.shift(); if (value !== undefined) { this.bytes = Math.max(0, this.bytes - new TextEncoder().encode(JSON.stringify(value)).byteLength); yield value; continue } if (this.closed) return; const next = await new Promise<IteratorResult<T>>(resolve => this.waiters.push(resolve)); if (next.done) return; yield next.value } } }

function capabilities(): AgentThreadConnection["capabilities"] { return Schema.decodeUnknownSync(AgentCapabilities)({ input: { text: "native", images: "unsupported", workspaceFiles: "unsupported", uploadedFiles: "unsupported" }, threads: { load: "unsupported", resume: "native", fork: "unsupported", list: "unsupported", delete: "unsupported" }, turns: { interrupt: "native", queue: "unsupported", retry: "unsupported", steer: "unsupported" }, output: { reasoning: "unsupported", plans: "unsupported", usage: "native", contextWindow: "unknown", cost: "native", subagents: "unsupported" }, tools: { streaming: "unsupported", parallel: "unknown", terminal: "unsupported", fileDiffs: "unknown" }, interaction: { permissions: "native", structuredInput: "unsupported", externalUrlInput: "unsupported" }, configuration: { dynamicOptions: "native", slashCommands: "unsupported" } }) }
function configuration(
  raw: Json,
  previous: ReadonlyArray<AgentConfigurationOption> = [],
): AgentConfigurationOption[] {
  let models = array(raw.models).map(model => object(model)).flatMap(model => {
    const value = text(model.value) || text(model.id)
    if (!value) return []
    return [{
      value,
      label: text(model.displayName) || text(model.name) || text(model.label) || value,
      ...(text(model.description) ? { description: text(model.description) } : {}),
    }]
  })
  if (!models.length) {
    const prior = previous.find(option => option.id === "model")
    if (prior?.value.type === "enum") models = [...prior.value.choices]
  }
  const out: AgentConfigurationOption[] = []
  if (models.length) {
    const active = text(raw.model) || text(raw.modelId)
    const current = active && models.some(model => model.value === active) ? active : models[0]!.value
    out.push(Schema.decodeUnknownSync(AgentConfigurationOption)({
      id: "model",
      category: "model",
      label: "Model",
      value: { type: "enum", current, choices: models },
    }))
  }
  const priorPermission = previous.find(option => option.id === "permission")
  out.push(Schema.decodeUnknownSync(AgentConfigurationOption)({
    id: "permission",
    category: "permission",
    label: "Permission mode",
    value: {
      type: "enum",
      current: text(raw.permissionMode)
        || (priorPermission?.value.type === "enum" ? priorPermission.value.current : "default"),
      choices: [
        { value: "default", label: "Default" },
        { value: "acceptEdits", label: "Accept edits" },
        { value: "bypassPermissions", label: "Bypass permissions" },
      ],
    },
  }))
  return out
}
function reject(commandId: string, code: string, message: string, retryable: boolean): AgentCommandResult { return { status: "rejected", commandId, error: { code, message, retryable } } }
