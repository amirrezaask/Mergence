import type { AgentDriver, AgentDriverContext, AgentDriverDetection, AgentDriverDetectionContext, AgentThreadConnection, OpenAgentThreadRequest } from "@yaade/agent-driver"
import { AgentCapabilities, AgentConfigurationOption, AgentConnectionId, AgentDriverDescriptor, AgentTurnId, DriverId, ProviderId, ProviderSessionId, UnsequencedAgentEvent, type AgentActionResponse, type AgentCommandEnvelope, type AgentCommandResult } from "@yaade/agent-protocol"
import { Schema } from "effect"
import { AsyncQueue } from "./queue.js"
import { JsonlRpc, object, type RpcRequest } from "./rpc.js"

type Json = Record<string, unknown>
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const MAX_SEMANTIC_TEXT_BYTES = 64 * 1024
const MODEL_LIST_PAGE_LIMIT = 100
const MODEL_LIST_MAX_PAGES = 32
export function truncateSemanticText(value: string): string { const encoder = new TextEncoder(); if (encoder.encode(value).byteLength <= MAX_SEMANTIC_TEXT_BYTES) return value; let bytes = 0; let end = 0; for (const character of value) { const size = encoder.encode(character).byteLength; if (bytes + size > MAX_SEMANTIC_TEXT_BYTES) break; bytes += size; end += character.length }; return value.slice(0, end) }
const capabilities = (hasConfiguration: boolean): AgentThreadConnection["capabilities"] => AgentCapabilities.make({ input: { text: "native", images: "unsupported", workspaceFiles: "native", uploadedFiles: "unsupported" }, threads: { load: "unsupported", resume: "native", fork: "unsupported", list: "unsupported", delete: "unsupported" }, turns: { interrupt: "native", queue: "unsupported", retry: "unsupported", steer: "unsupported" }, output: { reasoning: "unsupported", plans: "unknown", usage: "native", contextWindow: "native", cost: "unknown", subagents: "unknown" }, tools: { streaming: "native", parallel: "unknown", terminal: "unsupported", fileDiffs: "unknown" }, interaction: { permissions: "native", structuredInput: "unsupported", externalUrlInput: "unsupported" }, configuration: { dynamicOptions: hasConfiguration ? "native" : "unsupported", slashCommands: "unsupported" } })

export type CodexAppServerOptions = { readonly command?: string; readonly args?: ReadonlyArray<string> }

/** Codex app-server adapter. Provider JSON-RPC is translated into protocol events here only. */
export class CodexAppServerDriver implements AgentDriver {
  readonly descriptor = AgentDriverDescriptor.make({ id: Schema.decodeUnknownSync(DriverId)("codex:app-server"), providerId: Schema.decodeUnknownSync(ProviderId)("codex"), name: "Codex app-server", integration: "app-server", priority: 300, supportsRemoteHost: true })
  constructor(private readonly options: CodexAppServerOptions = {}) {}
  async detect(context: AgentDriverDetectionContext): Promise<AgentDriverDetection> {
    if (context.signal.aborted) return { available: false, reason: "aborted" }
    const command = this.options.command ?? "codex"
    return await context.commands.resolveExecutable([command])
      ? { available: true }
      : { available: false, reason: `${command} was not found on PATH` }
  }
  async openThread(context: AgentDriverContext, request: OpenAgentThreadRequest): Promise<AgentThreadConnection> {
    await context.workspace.assertAllowed(request.cwdUri)
    const process = await context.processSpawner.spawn({ command: this.options.command ?? "codex", args: this.options.args ?? ["app-server"], cwdUri: request.cwdUri, env: {} })
    const rpc = new JsonlRpc(process)
    const queue = new AsyncQueue<UnsequencedAgentEvent>()
    const client = new CodexClient(rpc, queue, context.clock)
    rpc.onRequest(requestMessage => { void client.request(requestMessage) })
    rpc.onNotification((method, params) => client.notification(method, params))
    try {
      await rpc.request("initialize", { clientInfo: { name: "yaade", version: "1" } })
      await rpc.notify("initialized", {})
      const native = request.mode.type === "new"
        ? object(await rpc.request("thread/start", { cwd: request.cwdUri }))
        : object(await rpc.request("thread/resume", { threadId: request.mode.providerSessionId }))
      const thread = object(native.thread)
      const providerSessionId = string(thread.id) ?? (request.mode.type === "new" ? undefined : request.mode.providerSessionId)
      const configuration = await loadModelConfiguration(rpc, string(native.model))
      return new CodexConnection(rpc, queue, client, providerSessionId, context.clock, context.attachments, configuration)
    } catch (error) { await rpc.close(); throw error }
  }
}

class CodexConnection implements AgentThreadConnection {
  readonly capabilities: AgentThreadConnection["capabilities"]
  readonly binding: AgentThreadConnection["binding"]
  private config: ReadonlyArray<AgentConfigurationOption>
  private readonly applied = new Set<string>()
  private closed = false
  constructor(
    private readonly rpc: JsonlRpc,
    private readonly queue: AsyncQueue<UnsequencedAgentEvent>,
    private readonly client: CodexClient,
    providerSessionId: string | undefined,
    private readonly clock: AgentDriverContext["clock"],
    private readonly attachments: AgentDriverContext["attachments"],
    configuration: ReadonlyArray<AgentConfigurationOption>,
  ) {
    this.config = configuration
    this.capabilities = capabilities(configuration.length > 0)
    this.binding = { connectionId: Schema.decodeUnknownSync(AgentConnectionId)(`codex:${crypto.randomUUID()}`), ...(providerSessionId ? { providerSessionId: Schema.decodeUnknownSync(ProviderSessionId)(providerSessionId) } : {}) }
  }
  get configuration(): ReadonlyArray<AgentConfigurationOption> { return this.config }
  events(signal?: AbortSignal): AsyncIterable<UnsequencedAgentEvent> { return this.queue.iterate(signal) }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; this.queue.close(); await this.rpc.close() }
  async send(envelope: AgentCommandEnvelope): Promise<AgentCommandResult> {
    if (this.applied.has(envelope.commandId)) return { status: "already-applied", commandId: envelope.commandId }
    if (this.closed) return { status: "rejected", commandId: envelope.commandId, error: { code: "codex.closed", message: "Codex connection is closed", retryable: false } }
    const threadId = this.binding.providerSessionId
    if (!threadId) return { status: "rejected", commandId: envelope.commandId, error: { code: "codex.thread", message: "Codex thread is not bound", retryable: false } }
    try {
      if (envelope.command.type === "turn.submit") { const input = await Promise.all(envelope.command.input.map(async part => { if (part.type === "text") return { type: "text", text: part.text }; if (part.type === "workspace-resource") return { type: "text", text: part.uri }; const attachment = await this.attachments.resolve(part.attachmentId); return attachment.mediaType.startsWith("image/") && attachment.source.type === "temporary-upload" ? { type: "localImage", path: attachment.source.storageKey } : { type: "text", text: attachment.source.type === "workspace-resource" ? attachment.source.uri : attachment.source.storageKey } })); const result = object(await this.rpc.request("turn/start", { threadId, input })); const turn = object(result.turn); const id = string(turn.id); if (id) { const turnId = Schema.decodeUnknownSync(AgentTurnId)(id); this.client.emit({ type: "turn.started", turnId }); this.client.emit({ type: "item.started", item: { type: "user-message", id: `user:${envelope.commandId}`, turnId, revision: 0, content: envelope.command.input.map(part => part.type === "text" ? { type: "text", text: part.text } : part.type === "workspace-resource" ? { type: "workspace-resource", uri: part.uri } : { type: "workspace-resource", uri: part.attachmentId }) } }) } }
      else if (envelope.command.type === "turn.interrupt") await this.rpc.request("turn/interrupt", { threadId, turnId: envelope.command.turnId })
      else if (envelope.command.type === "action.respond") await this.client.respond(envelope.command.actionId, envelope.command.response)
      else if (envelope.command.type === "configuration.set") await this.setConfiguration(envelope.command.optionId, envelope.command.value)
      else await this.rpc.notify("thread/close", { threadId })
      this.applied.add(envelope.commandId); return { status: "accepted", commandId: envelope.commandId }
    } catch (error) { return { status: "rejected", commandId: envelope.commandId, error: { code: "codex.request", message: error instanceof Error ? error.message : String(error), retryable: true } } }
  }
  private async setConfiguration(optionId: string, value: unknown): Promise<void> {
    if (optionId !== "model" || typeof value !== "string") throw new Error(`unsupported Codex configuration option: ${optionId}`)
    const model = this.config.find(option => option.id === "model")
    if (!model || model.value.type !== "enum" || !model.value.choices.some(choice => choice.value === value)) {
      throw new Error(`Codex model is not in the negotiated catalog: ${value}`)
    }
    await this.rpc.request("config/value/write", { key: "model", value })
    this.config = this.config.map(option =>
      option.id === "model" && option.value.type === "enum"
        ? Schema.decodeUnknownSync(AgentConfigurationOption)({ ...option, value: { ...option.value, current: value } })
        : option,
    )
    this.client.emit({ type: "configuration.updated", configuration: this.config })
  }
}

class CodexClient {
  private readonly actions = new Map<string, { readonly requestId: string | number; readonly optionIds: ReadonlySet<string> }>()
  private readonly textItems = new Map<string, { turnId: string; text: string; revision: number }>()
  constructor(private readonly rpc: JsonlRpc, private readonly queue: AsyncQueue<UnsequencedAgentEvent>, private readonly clock: AgentDriverContext["clock"]) {}
  emit(event: unknown): void { this.queue.push(Schema.decodeUnknownSync(UnsequencedAgentEvent)({ occurredAt: this.clock.now().toISOString(), event })) }
  async respond(actionId: string, response: unknown): Promise<void> { const pending = this.actions.get(actionId); if (!pending || response === null || typeof response !== "object") throw new Error("Unknown Codex pending action"); const record = response as Json; const optionId = string(record.optionId); if (record.type !== "permission" || !optionId || !pending.optionIds.has(optionId)) throw new Error("Invalid Codex permission option"); const resolved = response as AgentActionResponse; await this.rpc.respond(pending.requestId, { decision: optionId }); this.actions.delete(actionId); this.emit({ type: "action.resolved", actionId: actionId as never, response: resolved }) }
  async request(request: RpcRequest): Promise<void> { if (request.method !== "item/commandExecution/requestApproval") { await this.rpc.respond(request.id, {}); return } if (this.actions.size >= 64) { await this.rpc.respond(request.id, { error: "Codex pending action limit exceeded" }); return } const actionId = `codex-approval:${String(request.id)}`; const options = [{ id: "allow-once", decision: "allow-once" as const, label: "Allow once" }, { id: "reject-once", decision: "reject-once" as const, label: "Reject" }]; this.actions.set(actionId, { requestId: request.id, optionIds: new Set(options.map(option => option.id)) }); this.emit({ type: "action.requested", action: { type: "permission", id: actionId, createdAt: this.clock.now().toISOString(), title: "Approve command execution", ...(string(request.params.reason) ? { description: string(request.params.reason) } : {}), options } }) }
  notification(method: string, params: Json): void {
    const turn = object(params.turn)
    const turnId = string(params.turnId) ?? string(turn.id)
    if (method === "item/agentMessage/delta" && turnId) {
      const itemId = string(params.itemId) ?? "assistant"
      const previous = this.textItems.get(itemId)
      if (!previous) {
        this.emit({ type: "item.started", item: { type: "assistant-message", id: itemId as never, turnId: turnId as never, revision: 0, text: "", status: "streaming" } })
      }
      const delta = truncateSemanticText(string(params.delta) ?? "")
      const next = {
        turnId,
        text: truncateSemanticText(`${previous?.text ?? ""}${delta}`),
        revision: (previous?.revision ?? 0) + 1,
      }
      this.textItems.set(itemId, next)
      this.emit({ type: "item.delta", itemId: itemId as never, revision: next.revision, text: delta })
      return
    }
    if ((method === "item/started" || method === "item/completed") && turnId) {
      const item = object(params.item)
      const id = string(item.id)
      if (!id || string(item.type) !== "commandExecution") return
      const status = string(item.status) === "completed" ? "completed" : "running"
      const tool = { type: "tool-call" as const, id: id as never, turnId: turnId as never, revision: method === "item/started" ? 0 : 1, category: "shell", title: array(item.command).map(value => String(value)).join(" ") || "Command", status, ...(string(item.aggregatedOutput) ? { output: [{ type: "text" as const, text: truncateSemanticText(string(item.aggregatedOutput)!) }] } : {}) }
      this.emit({ type: method === "item/started" ? "item.started" : "item.completed", item: tool })
      return
    }
    if (method === "thread/tokenUsage/updated") {
      const usage = object(params.tokenUsage)
      const total = object(usage.total)
      this.emit({ type: "usage.updated", usage: { ...(typeof total.totalTokens === "number" ? { outputTokens: total.totalTokens } : {}), ...(typeof usage.modelContextWindow === "number" ? { contextWindowTokens: usage.modelContextWindow } : {}) } })
      return
    }
    if (method === "turn/completed" && turnId) {
      const status = string(turn.status)
      for (const [itemId, item] of this.textItems) {
        if (item.turnId !== turnId) continue
        this.emit({ type: "item.completed", item: { type: "assistant-message", id: itemId as never, turnId: turnId as never, revision: item.revision + 1, text: item.text, status: status === "interrupted" ? "cancelled" : "completed" } })
        this.textItems.delete(itemId)
      }
      this.emit(status === "interrupted" ? { type: "turn.interrupted", turnId: turnId as never } : { type: "turn.completed", turnId: turnId as never })
    }
  }
}

async function loadModelConfiguration(rpc: JsonlRpc, threadModel: string | undefined): Promise<ReadonlyArray<AgentConfigurationOption>> {
  try {
    const { choices, defaultId } = await listModels(rpc)
    if (!choices.length) return []
    const current = (threadModel && choices.some(choice => choice.value === threadModel) ? threadModel : undefined)
      ?? (defaultId && choices.some(choice => choice.value === defaultId) ? defaultId : undefined)
      ?? choices[0]!.value
    return [Schema.decodeUnknownSync(AgentConfigurationOption)({
      id: "model",
      category: "model",
      label: "Model",
      value: { type: "enum", current, choices },
    })]
  } catch {
    return []
  }
}

async function listModels(rpc: JsonlRpc): Promise<{
  readonly choices: Array<{ value: string; label: string }>
  readonly defaultId?: string
}> {
  const choices: Array<{ value: string; label: string }> = []
  const seen = new Set<string>()
  let cursor: string | undefined
  let defaultId: string | undefined
  for (let page = 0; page < MODEL_LIST_MAX_PAGES; page += 1) {
    const result = object(await rpc.request("model/list", {
      limit: MODEL_LIST_PAGE_LIMIT,
      includeHidden: false,
      ...(cursor ? { cursor } : {}),
    }))
    for (const entry of array(result.data)) {
      const model = object(entry)
      const value = string(model.id) ?? string(model.model)
      if (!value || seen.has(value)) continue
      seen.add(value)
      choices.push({ value, label: string(model.displayName) || value })
      if (model.isDefault === true) defaultId = value
    }
    const next = string(result.nextCursor)
    if (!next) break
    cursor = next
  }
  return { choices, ...(defaultId ? { defaultId } : {}) }
}
