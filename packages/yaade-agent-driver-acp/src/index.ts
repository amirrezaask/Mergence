import type { AgentDriver, AgentDriverContext, AgentDriverDetection, AgentDriverDetectionContext, AgentMcpServer, AgentTerminalHandle, AgentThreadConnection, OpenAgentThreadRequest } from "@yaade/agent-driver"
import { AgentCapabilities, AgentConnectionId, UnsequencedAgentEvent, type AgentCommandEnvelope, type AgentCommandResult, type AgentConfigurationOption, type AgentEvent, type AgentInputPart } from "@yaade/agent-protocol"
import { Schema } from "effect"
import { fileURLToPath } from "node:url"
import { basename, isAbsolute } from "node:path"
import { AsyncQueue } from "./async-queue.js"
import { JsonLineRpc, asObject, decodeJsonObject, type JsonLineRpcRequest } from "./json-line-rpc.js"
import type { AcpDriverProfile } from "./profiles.js"
import { detectAcpCommand } from "./detect-command.js"

type Json = Record<string, unknown>
const text = (value: unknown): string => typeof value === "string" ? value : ""
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined
const requiredString = (value: Json, key: string, boundary: string): string => {
  const field = value[key]
  if (typeof field !== "string" || !field) throw new Error(`Malformed ACP ${boundary}: ${key} is required`)
  return field
}
const requiredNumber = (value: Json, key: string, boundary: string): number => {
  const field = value[key]
  if (typeof field !== "number" || !Number.isFinite(field)) throw new Error(`Malformed ACP ${boundary}: ${key} must be a finite number`)
  return field
}
const requiredArray = (value: Json, key: string, boundary: string): unknown[] => {
  const field = value[key]
  if (!Array.isArray(field)) throw new Error(`Malformed ACP ${boundary}: ${key} must be an array`)
  return field
}
const now = (): string => new Date().toISOString()
const MAX_SEMANTIC_TEXT_BYTES = 65_536
export const truncateSemanticText = (value: string): string => {
  const encoder = new TextEncoder()
  if (encoder.encode(value).byteLength <= MAX_SEMANTIC_TEXT_BYTES) return value
  const suffix = "\n[yaade: truncated oversized provider payload]"
  const limit = MAX_SEMANTIC_TEXT_BYTES - encoder.encode(suffix).byteLength
  let bytes = 0; let end = 0
  for (const character of value) { const size = encoder.encode(character).byteLength; if (bytes + size > limit) break; bytes += size; end += character.length }
  return value.slice(0, end) + suffix
}

/** ACP v1 stdio adapter. All provider-specific names stay inside this module. */
export class AcpAgentDriver implements AgentDriver {
  readonly descriptor
  constructor(readonly profile: AcpDriverProfile) { this.descriptor = profile.descriptor }

  async detect(context: AgentDriverDetectionContext): Promise<AgentDriverDetection> {
    return detectAcpCommand(this.profile, context)
  }

  async openThread(context: AgentDriverContext, request: OpenAgentThreadRequest): Promise<AgentThreadConnection> {
    await context.workspace.assertAllowed(request.cwdUri)
    const cwd = nativeCwd(request.cwdUri)
    const command = await context.commands.resolveExecutable(this.profile.executableCandidates)
    if (!command) throw new Error(`${this.profile.executableCandidates.join(" or ")} was not found on PATH`)
    const process = await context.processSpawner.spawn({ command, args: this.profile.args, cwdUri: request.cwdUri, env: this.profile.env ?? {} })
    const rpc = new JsonLineRpc(process)
    const events = new AsyncQueue<UnsequencedAgentEvent>()
    const client = new AcpClient(context, rpc, events, request.cwdUri, this.profile)
    rpc.onClose(error => client.transportClosed(error))
    rpc.onRequest(request => { void client.handleRequest(request) })
    rpc.onNotification((method, params) => client.handleNotification(method, params))
    try {
      const initialized = decodeInitialize(await rpc.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
          auth: { terminal: false },
          elicitation: { form: {} },
        },
      }))
      const mcpServers = (await context.mcp.listServers()).map(acpMcpServer)
      const negotiated = negotiatedCapabilities(initialized.agentCapabilities)
      const session = request.mode.type === "new"
        ? decodeSession(await rpc.request("session/new", { cwd, mcpServers }), true)
        : await openExisting(rpc, request.mode.type, request.mode.providerSessionId, cwd, mcpServers, negotiated)
      const providerSessionId = text(session.sessionId) || (request.mode.type === "new" ? "" : request.mode.providerSessionId)
      const configOptions = configuration(session)
      const capabilities = capabilityMap(initialized.agentCapabilities, configOptions.length > 0, this.profile.allowImageContent === true)
      return new AcpConnection(rpc, events, providerSessionId, capabilities, configOptions, context.clock, client, context.attachments, negotiated.close, capabilities.input.images === "native")
    } catch (error) {
      await client.close()
      await rpc.close().catch(() => undefined)
      throw error
    }
  }
}

function nativeCwd(uri: string): string {
  const cwd = fileURLToPath(uri)
  if (!isAbsolute(cwd)) throw new Error("ACP cwd must resolve to an absolute native path")
  return cwd
}

type NegotiatedLifecycle = { readonly load: boolean; readonly resume: boolean; readonly close: boolean }

async function openExisting(rpc: JsonLineRpc, mode: "load" | "resume", providerSessionId: string, cwd: string, mcpServers: ReadonlyArray<Json>, negotiated: NegotiatedLifecycle): Promise<Json> {
  if (mode === "load" && !negotiated.load) throw new Error("ACP agent did not advertise session/load")
  if (mode === "resume" && !negotiated.resume) throw new Error("ACP agent did not advertise session/resume")
  return decodeSession(await rpc.request(mode === "load" ? "session/load" : "session/resume", { sessionId: providerSessionId, cwd, mcpServers }), false)
}

function acpMcpServer(server: AgentMcpServer): Json {
  if (server.type === "stdio") {
    return {
      name: server.name,
      command: server.command,
      args: [...server.args],
      env: server.env.map(entry => ({ name: entry.name, value: entry.value })),
    }
  }
  return {
    type: server.type,
    name: server.name,
    url: server.url,
    headers: server.headers.map(entry => ({ name: entry.name, value: entry.value })),
  }
}

class AcpConnection implements AgentThreadConnection {
  readonly binding
  readonly configuration: ReadonlyArray<AgentConfigurationOption>
  private closed = false
  private nativeClosed = false
  private readonly commandIds = new Set<string>()
  constructor(private readonly rpc: JsonLineRpc, private readonly queue: AsyncQueue<UnsequencedAgentEvent>, providerSessionId: string, readonly capabilities: AgentThreadConnection["capabilities"], configuration: ReadonlyArray<AgentConfigurationOption>, private readonly clock: AgentDriverContext["clock"], private readonly client: AcpClient, private readonly attachments: AgentDriverContext["attachments"], private readonly nativeClose: boolean, private readonly allowImageContent: boolean) {
    this.configuration = configuration
    this.binding = { connectionId: Schema.decodeUnknownSync(AgentConnectionId)(`acp:${crypto.randomUUID()}`), ...(providerSessionId ? { providerSessionId: providerSessionId as never } : {}) }
  }
  events(signal?: AbortSignal): AsyncIterable<UnsequencedAgentEvent> { return this.queue.iterate(signal) }
  async close(reason?: string): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      if (reason === "user") await this.closeNative()
    } finally {
      this.queue.close()
      await this.client.close()
      await this.rpc.close()
    }
  }
  private async closeNative(): Promise<void> {
    if (!this.nativeClose || this.nativeClosed) return
    this.nativeClosed = true
    await this.rpc.request("session/close", { sessionId: this.binding.providerSessionId })
  }
  async send(command: AgentCommandEnvelope): Promise<AgentCommandResult> {
    if (this.commandIds.has(command.commandId)) return { status: "already-applied", commandId: command.commandId }
    if (this.closed) return { status: "rejected", commandId: command.commandId, error: { code: "acp.closed", message: "ACP connection closed", retryable: false } }
    const sessionId = this.binding.providerSessionId
    try {
      switch (command.command.type) {
        case "turn.submit":
          this.client.beginTurn(`acp-turn:${command.commandId}`)
          void Promise.all(command.command.input.map(part => acpPromptPart(part, this.attachments, this.allowImageContent)))
            .then(prompt => this.rpc.request("session/prompt", { sessionId, prompt }))
            .then(result => this.client.finishTurn(requiredString(decodeJsonObject(result, "session/prompt response"), "stopReason", "session/prompt response")))
            .catch(error => this.client.failTurn(String(error)))
          break
        case "turn.interrupt": await this.rpc.notify("session/cancel", { sessionId }); break
        case "action.respond":
          if (!this.client.resolveAction(command.command.actionId, command.command.response)) {
            return { status: "rejected", commandId: command.commandId, error: { code: "acp.action", message: "Unknown ACP action or permission option", retryable: false } }
          }
          break
        case "configuration.set": decodeJsonObject(await this.rpc.request("session/set_config_option", { sessionId, configId: command.command.optionId, value: command.command.value }), "session/set_config_option response"); break
        case "thread.close": await this.closeNative(); break
      }
      this.commandIds.add(command.commandId)
      return { status: "accepted", commandId: command.commandId }
    } catch (error) { return { status: "rejected", commandId: command.commandId, error: { code: "acp.request", message: String(error), retryable: true } } }
  }
}

async function acpPromptPart(
  part: AgentInputPart,
  attachments: AgentDriverContext["attachments"],
  allowImageContent: boolean,
): Promise<Json> {
  if (part.type === "text") return { type: "text", text: part.text }
  if (part.type === "workspace-resource") {
    return { type: "resource_link", uri: part.uri, name: resourceName(part.uri) }
  }
  const attachment = await attachments.resolve(part.attachmentId)
  if (attachment.source.type === "workspace-resource") {
    return { type: "resource_link", uri: attachment.source.uri, name: attachment.name, mimeType: attachment.mediaType }
  }
  const data = await attachments.read(part.attachmentId)
  if (part.purpose === "image") {
    if (!allowImageContent || !attachment.mediaType.startsWith("image/")) {
      throw new Error("ACP agent did not negotiate this image attachment")
    }
    return { type: "image", data: Buffer.from(data).toString("base64"), mimeType: attachment.mediaType }
  }
  const resource = attachment.mediaType.startsWith("text/") || attachment.mediaType === "application/json"
    ? { uri: `yaade-attachment:${encodeURIComponent(part.attachmentId)}`, mimeType: attachment.mediaType, text: new TextDecoder().decode(data) }
    : { uri: `yaade-attachment:${encodeURIComponent(part.attachmentId)}`, mimeType: attachment.mediaType, blob: Buffer.from(data).toString("base64") }
  return { type: "resource", resource }
}

function resourceName(uri: string): string {
  try {
    return basename(fileURLToPath(uri)) || uri
  } catch {
    return uri
  }
}

class AcpClient {
  private readonly actions = new Map<string, { readonly resolve: (response: unknown) => void; readonly optionIds?: ReadonlySet<string> }>()
  private turnId: string | null = null
  private readonly itemRevision = new Map<string, number>()
  private readonly textItems = new Map<string, { text: string; revision: number }>()
  private readonly terminals = new Map<string, AgentTerminalHandle>()
  constructor(private readonly context: AgentDriverContext, private readonly rpc: JsonLineRpc, private readonly queue: AsyncQueue<UnsequencedAgentEvent>, private readonly cwdUri: string, private readonly profile: AcpDriverProfile) {}
  async close(): Promise<void> {
    this.actions.clear()
    await Promise.all([...this.terminals.values()].map(terminal => terminal.close().catch(() => undefined)))
    this.terminals.clear()
  }
  transportClosed(error: Error): void {
    this.emit({ type: "agent.error", code: "acp.transport", message: error.message, retryable: true })
    this.queue.close()
  }
  resolveAction(id: string, response: unknown): boolean {
    const action = this.actions.get(id)
    if (!action) return false
    if (action.optionIds) {
      const optionId = permissionOptionId(response)
      if (!optionId || !action.optionIds.has(optionId)) return false
    }
    this.actions.delete(id)
    action.resolve(response)
    return true
  }
  beginTurn(turnId: string): void { this.turnId = turnId; this.emit({ type: "turn.started", turnId: turnId as never }) }
  finishTurn(reason: string): void { if (!this.turnId) return; this.completeTextItems(reason === "cancelled" ? "cancelled" : "completed"); this.emit({ type: reason === "cancelled" ? "turn.interrupted" : "turn.completed", turnId: this.turnId as never }); this.turnId = null }
  failTurn(message: string): void { if (!this.turnId) return; this.completeTextItems("cancelled"); this.emit({ type: "turn.failed", turnId: this.turnId as never, message }); this.turnId = null }
  handleNotification(method: string, params: Json): void {
    if (method !== "session/update") return
    const update = decodeJsonObject(params.update, "session/update update")
    const kind = requiredString(update, "sessionUpdate", "session/update update")
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      // session/load may replay native history before a canonical turn exists.
      // The durable runtime already owns that history; forwarding orphan deltas
      // would both duplicate it and violate canonical item ordering.
      if (!this.turnId) return
      const itemId = `acp-${kind}`; const revision = (this.itemRevision.get(itemId) ?? 0) + 1; this.itemRevision.set(itemId, revision)
      if (revision === 1 && this.turnId) this.emit({ type: "item.started", item: { type: kind === "agent_message_chunk" ? "assistant-message" : "reasoning", id: itemId as never, turnId: this.turnId as never, revision, text: "", status: "streaming" } as never }, update)
      const content = decodeJsonObject(update.content, `${kind} content`)
      const delta = truncateSemanticText(requiredString(content, "text", `${kind} content`))
      const previous = this.textItems.get(itemId)
      this.textItems.set(itemId, { text: `${previous?.text ?? ""}${delta}`, revision: revision + 1 })
      this.emit({ type: "item.delta", itemId: itemId as never, revision: revision + 1, text: delta }, update)
      this.itemRevision.set(itemId, revision + 1)
    }
    else if (kind === "tool_call" || kind === "tool_call_update") {
      requiredString(update, "toolCallId", kind)
      this.toolUpdate(update)
    }
    else if (kind === "plan") {
      requiredArray(update, "entries", "plan update")
      this.planUpdate(update)
    }
    else if (kind === "usage_update") this.emit({ type: "usage.updated", usage: { inputTokens: requiredNumber(update, "used", "usage update"), contextWindowTokens: requiredNumber(update, "size", "usage update") } })
  }
  async handleRequest(request: JsonLineRpcRequest): Promise<void> {
    try {
      if (request.method === "session/request_permission") {
        if (this.actions.size >= 64) { await this.rpc.respondError(request.id, -32000, "ACP pending action limit exceeded"); return }
        const toolCall = decodeJsonObject(request.params.toolCall, "session/request_permission toolCall")
        const id = requiredString(toolCall, "toolCallId", "session/request_permission toolCall")
        const options = requiredArray(request.params, "options", "session/request_permission").map((value, index) => {
          const option = decodeJsonObject(value, `session/request_permission option ${index}`)
          requiredString(option, "optionId", `session/request_permission option ${index}`)
          requiredString(option, "name", `session/request_permission option ${index}`)
          requiredString(option, "kind", `session/request_permission option ${index}`)
          return option
        })
        const actionId = `acp-permission:${id}`
        this.emit({ type: "action.requested", action: { type: "permission", id: actionId as never, ...(this.turnId ? { turnId: this.turnId as never } : {}), createdAt: now(), title: text(asObject(request.params.toolCall).title) || "Permission required", options: options.map(option => ({ id: text(option.optionId), decision: permissionDecision(text(option.kind)), label: text(option.name) })) } as never })
        const optionIds = new Set(options.map(option => text(option.optionId)).filter(Boolean))
        const response = await new Promise<unknown>(resolve => this.actions.set(actionId, { resolve, optionIds }))
        const selected = permissionOptionId(response)
        if (!selected) throw new Error("ACP permission response did not contain an advertised option")
        this.emit({ type: "action.resolved", actionId, response: response as never })
        await this.rpc.respond(request.id, { outcome: { outcome: "selected", optionId: selected } })
        return
      }
      if (request.method === "elicitation/create" || this.profile.vendorElicitationMethods?.includes(request.method)) {
        if (this.actions.size >= 64) { await this.rpc.respondError(request.id, -32000, "ACP pending action limit exceeded"); return }
        if (request.method === "elicitation/create") {
          if (requiredString(request.params, "mode", "elicitation/create") !== "form") throw new Error("Malformed ACP elicitation/create: only form mode is supported")
          decodeJsonObject(request.params.requestedSchema, "elicitation/create requestedSchema")
        } else {
          requiredArray(request.params, "questions", request.method)
        }
        const actionId = `acp-elicitation:${crypto.randomUUID()}`
        this.emit({ type: "action.requested", action: elicitationAction(actionId, this.turnId, request.method, request.params) as never })
        const response = await new Promise<unknown>(resolve => this.actions.set(actionId, { resolve }))
        this.emit({ type: "action.resolved", actionId, response: response as never })
        await this.rpc.respond(request.id, elicitationResponse(request.method, response))
        return
      }
      if (request.method.startsWith("fs/")) { await this.handleFs(request); return }
      if (request.method.startsWith("terminal/")) { await this.handleTerminal(request); return }
      await this.rpc.respondError(request.id, -32601, "method not supported")
    } catch (error) { await this.rpc.respondError(request.id, -32603, String(error)) }
  }
  private emit(event: AgentEvent, source?: Json): void {
    const nativeEventId = source ? text(source.eventId) || text(source.id) : ""
    const providerCursor = source ? text(source.cursor) || text(source.sequence) : ""
    this.queue.push(Schema.decodeUnknownSync(UnsequencedAgentEvent)({ occurredAt: now(), ...(nativeEventId ? { nativeEventId } : {}), ...(providerCursor ? { providerCursor } : {}), event }))
  }
  private completeTextItems(status: "completed" | "cancelled"): void {
    for (const [id, item] of this.textItems) {
      if (!this.turnId) continue
      this.emit({ type: "item.completed", item: { type: id.includes("thought") ? "reasoning" : "assistant-message", id: id as never, turnId: this.turnId as never, revision: item.revision + 1, text: item.text, status } as never })
      this.textItems.delete(id)
      this.itemRevision.delete(id)
    }
  }
  private toolUpdate(update: Json): void { if (!this.turnId) return; const id = `acp-tool:${text(update.toolCallId)}`; const revision = (this.itemRevision.get(id) ?? 0) + 1; this.itemRevision.set(id, revision); const item = { type: "tool-call", id: id as never, turnId: this.turnId as never, revision, nativeName: text(update.kind), category: text(update.kind) || "other", title: text(update.title) || "Tool", status: toolStatus(text(update.status)), ...(update.rawInput ? { input: [{ type: "text", text: truncateSemanticText(JSON.stringify(update.rawInput)) }] } : {}), ...(update.rawOutput ? { output: [{ type: "text", text: truncateSemanticText(JSON.stringify(update.rawOutput)) }] } : {}) }; this.emit({ type: revision === 1 ? "item.started" : "item.updated", item: item as never }) }
  private planUpdate(update: Json): void { if (!this.turnId) return; const id = "acp-plan"; const revision = (this.itemRevision.get(id) ?? 0) + 1; this.itemRevision.set(id, revision); this.emit({ type: revision === 1 ? "item.started" : "item.updated", item: { type: "plan", id: id as never, turnId: this.turnId as never, revision, entries: array(update.entries).map((entry, index) => ({ id: text(asObject(entry).id) || String(index), text: text(asObject(entry).content), status: planStatus(text(asObject(entry).status)) })), status: "active" } as never }) }
  private async handleFs(request: JsonLineRpcRequest): Promise<void> {
    const path = requiredString(request.params, "path", request.method); const uri = path.startsWith("file:") ? path : new URL(path, this.cwdUri.endsWith("/") ? this.cwdUri : `${this.cwdUri}/`).toString(); await this.context.workspace.assertAllowed(uri)
    if (request.method === "fs/read_text_file") { const bytes = await this.context.filesystem.readFile(uri); await this.rpc.respond(request.id, { content: new TextDecoder().decode(bytes) }); return }
    if (request.method === "fs/write_text_file") { await this.context.filesystem.writeFile(uri, new TextEncoder().encode(requiredString(request.params, "content", request.method))); await this.rpc.respond(request.id, {}); return }
    await this.rpc.respondError(request.id, -32601, "fs method not supported")
  }
  private async handleTerminal(request: JsonLineRpcRequest): Promise<void> {
    if (request.method === "terminal/create") {
      const command = requiredString(request.params, "command", "terminal/create")
      const args = requiredArray(request.params, "args", "terminal/create").map((value, index) => {
        if (typeof value !== "string") throw new Error(`Malformed ACP terminal/create: args[${index}] must be a string`)
        return value
      })
      const terminal = await this.context.terminal.open({ cwdUri: this.cwdUri, command, args })
      this.terminals.set(terminal.id, terminal)
      await this.rpc.respond(request.id, { terminalId: terminal.id })
      return
    }
    const terminalId = requiredString(request.params, "terminalId", request.method)
    const terminal = this.terminals.get(terminalId)
    if (!terminal) { await this.rpc.respondError(request.id, -32001, "terminal not found"); return }
    if (request.method === "terminal/write") { await terminal.write(requiredString(request.params, "data", "terminal/write")); await this.rpc.respond(request.id, {}); return }
    if (request.method === "terminal/output") { const output = await terminal.readOutput(); await this.rpc.respond(request.id, output); return }
    if (request.method === "terminal/wait_for_exit") { const exit = await terminal.waitForExit(); await this.rpc.respond(request.id, exit); return }
    if (request.method === "terminal/release" || request.method === "terminal/close") { await terminal.close(); this.terminals.delete(terminalId); await this.rpc.respond(request.id, {}); return }
    await this.rpc.respondError(request.id, -32601, "terminal method not supported")
  }
}

function permissionOptionId(response: unknown): string | undefined {
  const record = asObject(response)
  return text(record.type) === "permission" && typeof record.optionId === "string" ? record.optionId : undefined
}

function elicitationAction(actionId: string, turnId: string | null, method: string, params: Json): Json {
  const schema = asObject(params.requestedSchema)
  const required = new Set(array(schema.required).map(text))
  const properties = asObject(schema.properties)
  const questions = array(params.questions)
  const fields = method === "cursor/ask_question"
    ? questions.map((value, index) => cursorQuestionField(asObject(value), index))
    : Object.entries(properties).map(([id, value]) => schemaField(id, asObject(value), required.has(id)))
  return {
    type: "elicitation",
    id: actionId,
    ...(turnId ? { turnId } : {}),
    createdAt: now(),
    title: text(params.message) || text(params.title) || "Input required",
    mode: fields.length === 1 ? fieldMode(fields[0] ?? {}) : "form",
    fields,
  }
}

function schemaField(id: string, schema: Json, required: boolean): Json {
  const enumValues = array(schema.enum).map(text).filter(Boolean)
  const type = text(schema.type)
  const input = enumValues.length ? "single-select" : type === "boolean" ? "confirm" : "text"
  return {
    id,
    label: text(schema.title) || id,
    ...(text(schema.description) ? { description: text(schema.description) } : {}),
    required,
    input,
    ...(enumValues.length ? { choices: enumValues.map(value => ({ id: value, label: value })) } : {}),
  }
}

function cursorQuestionField(question: Json, index: number): Json {
  const choices = array(question.options).map(asObject).map(option => ({ id: text(option.id) || text(option.label), label: text(option.label) || text(option.id) }))
  return {
    id: text(question.id) || String(index),
    label: text(question.prompt) || "Input required",
    required: true,
    input: question.allowMultiple === true ? "multi-select" : choices.length ? "single-select" : "text",
    ...(choices.length ? { choices } : {}),
  }
}

function fieldMode(field: Json): "text" | "confirm" | "select" | "multi-select" | "form" {
  const input = text(field.input)
  if (input === "confirm") return "confirm"
  if (input === "single-select") return "select"
  if (input === "multi-select") return "multi-select"
  return "text"
}

function elicitationResponse(method: string, response: unknown): Json {
  const values = elicitationValues(response)
  if (method !== "cursor/ask_question") return { action: "accept", content: values }
  return { answers: Object.entries(values).map(([id, value]) => ({ questionId: id, selected: Array.isArray(value) ? value.map(text) : [text(value)] })) }
}

function elicitationValues(response: unknown): Json {
  const record = asObject(response)
  return text(record.type) === "elicitation" ? asObject(record.values) : {}
}

function permissionDecision(kind: string): "allow-once" | "allow-always" | "reject-once" | "reject-always" | "custom" {
  if (kind === "allow_once") return "allow-once"
  if (kind === "allow_always") return "allow-always"
  if (kind === "reject_once") return "reject-once"
  if (kind === "reject_always") return "reject-always"
  return "custom"
}
function toolStatus(value: string): "pending" | "waiting-for-permission" | "running" | "completed" | "failed" | "cancelled" { if (value === "pending") return "pending"; if (value === "completed") return "completed"; if (value === "failed") return "failed"; if (value === "cancelled") return "cancelled"; return "running" }
function planStatus(value: string): "pending" | "in-progress" | "completed" | "cancelled" { if (value === "completed") return "completed"; if (value === "cancelled") return "cancelled"; if (value === "in_progress") return "in-progress"; return "pending" }

function decodeInitialize(value: unknown): { readonly agentCapabilities: Json } {
  const initialized = decodeJsonObject(value, "initialize response")
  if (initialized.protocolVersion !== 1) {
    throw new Error(`Unsupported ACP protocol version: ${String(initialized.protocolVersion)}`)
  }
  return { agentCapabilities: decodeJsonObject(initialized.agentCapabilities, "initialize agentCapabilities") }
}

function decodeSession(value: unknown, requireSessionId: boolean): Json {
  const session = decodeJsonObject(value, "session response")
  if (requireSessionId && (typeof session.sessionId !== "string" || !session.sessionId)) {
    throw new Error("Malformed ACP session response: sessionId is required")
  }
  return session
}

function negotiatedCapabilities(raw: Json): NegotiatedLifecycle {
  const sessions = asObject(raw.sessionCapabilities)
  return { load: raw.loadSession === true, resume: sessions.resume !== undefined, close: sessions.close !== undefined }
}

function capabilityMap(raw: Json, hasConfiguration: boolean, allowImageContent: boolean): AgentThreadConnection["capabilities"] {
  const sessions = asObject(raw.sessionCapabilities)
  const prompts = asObject(raw.promptCapabilities)
  const images = allowImageContent && prompts.image === true ? "native" : "unsupported"
  return Schema.decodeUnknownSync(AgentCapabilities)({ input: { text: "native", images, workspaceFiles: "native", uploadedFiles: "native" }, threads: { load: raw.loadSession === true ? "native" : "unsupported", resume: sessions.resume !== undefined ? "native" : "unsupported", fork: "unsupported", list: "unsupported", delete: sessions.delete !== undefined ? "native" : "unsupported" }, turns: { interrupt: "native", queue: "unsupported", retry: "unsupported", steer: "unsupported" }, output: { reasoning: "native", plans: "unknown", usage: "native", contextWindow: "unknown", cost: "unknown", subagents: "unsupported" }, tools: { streaming: "native", parallel: "unknown", terminal: "native", fileDiffs: "unknown" }, interaction: { permissions: "native", structuredInput: "native", externalUrlInput: "unsupported" }, configuration: { dynamicOptions: hasConfiguration ? "native" : "unsupported", slashCommands: "unsupported" } })
}
function configuration(session: Json): ReadonlyArray<AgentConfigurationOption> {
  return array(session.configOptions).map(asObject).flatMap(option => {
    const id = text(option.id)
    if (!id) return []
    const choices = array(option.options).map(asObject).map(choice => ({
      value: text(choice.value),
      label: text(choice.name) || text(choice.label) || text(choice.value),
      ...(text(choice.description) ? { description: text(choice.description) } : {}),
    })).filter(choice => choice.value)
    const current = option.currentValue
    const value: AgentConfigurationOption["value"] | null = choices.length > 0 && typeof current === "string"
      ? { type: "enum", current, choices }
      : typeof current === "boolean"
        ? { type: "boolean", current }
        : typeof current === "number" && Number.isFinite(current)
          ? {
              type: "number",
              current,
              ...(number(option.minimum) !== undefined ? { minimum: number(option.minimum) } : {}),
              ...(number(option.maximum) !== undefined ? { maximum: number(option.maximum) } : {}),
            }
          : typeof current === "string"
            ? { type: "string", current }
            : null
    if (!value) return []
    const category = configurationCategory(text(option.category))
    return [{
      id,
      category,
      label: text(option.name) || id,
      ...(text(option.description) ? { description: text(option.description) } : {}),
      value,
    }]
  })
}

function configurationCategory(value: string): AgentConfigurationOption["category"] {
  if (value === "model") return "model"
  if (value === "mode") return "mode"
  if (value === "thought_level" || value === "reasoning") return "reasoning"
  if (value === "permission") return "permission"
  if (value === "performance") return "performance"
  return "other"
}
export * from "./profiles.js"
export * from "./json-line-rpc.js"
