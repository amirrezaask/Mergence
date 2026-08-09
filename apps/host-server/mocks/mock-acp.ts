#!/usr/bin/env tsx
/**
 * Deterministic ACP v1 stdio peer used for exercising Yaade's agent transport.
 *
 * TypeScript port of the Rust `yaade-mock-acp` binary
 * (apps/server/src/mock_acp/{mod,cli,scenarios,cursor_ext}.rs). Wire format,
 * scenario names, message shapes and CLI flags are kept compatible so the ACP
 * matrix tests and E2E specs observe identical behavior.
 *
 * Usage: tsx apps/host-server/mocks/mock-acp.ts --scenario echo
 */
import fs from "node:fs"
import path from "node:path"

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const SCENARIOS = [
  "echo",
  "thought_then_answer",
  "tool_lifecycle",
  "permission_allow",
  "permission_tool_race",
  "permission_allow_always",
  "plan_update",
  "cancel_coop",
  "slow_stream",
  "usage_meter",
  "config_model",
  "config_malformed",
  "slash_commands",
  "chaos_malformed",
  "partial_then_error",
  "load_session",
  "fs_roundtrip",
  "terminal_roundtrip",
  "multi_session",
  "ask_question",
  "create_plan",
  "update_todos",
  "elicitation",
  "auth_required",
  "image_prompt",
  "set_mode_plan",
  "mcp_servers_inject",
  "malformed_callbacks",
  "malformed_update",
] as const

type Scenario = (typeof SCENARIOS)[number]

type Args = {
  scenario: string
  seed: bigint
  latencyMs: number
  jitterMs: number
  chunkSize: number
  fault: string | null
  trace: boolean
  capabilities: string | null
  providerProfile: string
  exitAfter: number
  stderrNoise: number
  strict: boolean
}

const USAGE = `Deterministic ACP peer used for exercising Yaade's agent transport.

Usage: mock-acp [OPTIONS]

Options:
      --scenario <SCENARIO>                  [default: echo]
      --seed <SEED>                          [default: 1]
      --latency-ms <LATENCY_MS>              [default: 0]
      --jitter-ms <JITTER_MS>                [default: 0]
      --chunk-size <CHUNK_SIZE>              [default: 12]
      --fault <FAULT>                        Inject a named transport fault ("malformed" | "disconnect")
      --trace                                Print protocol traffic to stderr
      --capabilities <CAPABILITIES>          Comma-separated overrides: load_session, resume, auth, auth_methods
      --provider-profile <PROVIDER_PROFILE>  [default: mock]
      --exit-after <EXIT_AFTER>              Stop after this many prompt turns; 0 means unlimited [default: 0]
      --stderr-noise <STDERR_NOISE>          Diagnostic lines emitted to stderr at startup [default: 0]
      --strict                               Reject unknown scenarios and unsupported protocol versions
  -h, --help                                 Print help

Scenarios: ${SCENARIOS.join(", ")}
`

class CliError extends Error {}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    scenario: "echo",
    seed: 1n,
    latencyMs: 0,
    jitterMs: 0,
    chunkSize: 12,
    fault: null,
    trace: false,
    capabilities: null,
    providerProfile: "mock",
    exitAfter: 0,
    stderrNoise: 0,
    strict: false,
  }

  let index = 0
  const next = (flag: string): string => {
    index += 1
    const value = argv[index]
    if (value === undefined) {
      throw new CliError(`a value is required for '${flag}' but none was supplied`)
    }
    return value
  }
  const int = (flag: string, raw: string): number => {
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new CliError(`invalid value '${raw}' for '${flag}': not a valid unsigned integer`)
    }
    return parsed
  }

  for (; index < argv.length; index += 1) {
    const token = argv[index]!
    let flag = token
    let inline: string | null = null
    const equals = token.indexOf("=")
    if (token.startsWith("--") && equals > 2) {
      flag = token.slice(0, equals)
      inline = token.slice(equals + 1)
    }
    const value = (): string => (inline !== null ? inline : next(flag))

    switch (flag) {
      case "-h":
      case "--help":
        process.stdout.write(USAGE)
        process.exit(0)
        break
      case "--scenario":
        args.scenario = value()
        break
      case "--seed": {
        const raw = value()
        try {
          args.seed = BigInt(raw)
        } catch {
          throw new CliError(`invalid value '${raw}' for '--seed': not a valid unsigned integer`)
        }
        break
      }
      case "--latency-ms":
        args.latencyMs = int(flag, value())
        break
      case "--jitter-ms":
        args.jitterMs = int(flag, value())
        break
      case "--chunk-size":
        args.chunkSize = int(flag, value())
        break
      case "--fault":
        args.fault = value()
        break
      case "--trace":
        args.trace = true
        break
      case "--capabilities":
        args.capabilities = value()
        break
      case "--provider-profile":
        args.providerProfile = value()
        break
      case "--exit-after":
        args.exitAfter = int(flag, value())
        break
      case "--stderr-noise":
        args.stderrNoise = int(flag, value())
        break
      case "--strict":
        args.strict = true
        break
      default:
        throw new CliError(`unexpected argument '${token}' found`)
    }
  }

  return args
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

type JsonValue = unknown
type JsonObject = Record<string, JsonValue>
type RpcId = number | string

const INTERNAL_ERROR = -32603
const METHOD_NOT_FOUND = -32601
const AUTH_REQUIRED = -32000

type RpcError = { code: number; message: string; data?: JsonValue }

class ProtocolError extends Error {
  constructor(readonly rpc: RpcError) {
    super(rpc.message)
  }
}

/** Mirrors `agent_client_protocol::util::internal_error`: generic message + data detail. */
function internalError(detail: string): ProtocolError {
  return new ProtocolError({ code: INTERNAL_ERROR, message: "Internal error", data: detail })
}

function authRequiredError(): ProtocolError {
  return new ProtocolError({ code: AUTH_REQUIRED, message: "Authentication required" })
}

type Pending = {
  resolve: (value: JsonValue) => void
  reject: (error: Error) => void
}

class Connection {
  private nextId = 1
  private pending = new Map<RpcId, Pending>()
  private buffer = ""

  constructor(private readonly trace: boolean) {}

  private writeLine(line: string): void {
    if (this.trace) process.stderr.write(`[mock-acp Stdout] ${line}\n`)
    process.stdout.write(`${line}\n`)
  }

  /** Emits an unframed line — only used by the intentional-malformed fault. */
  writeRaw(line: string): void {
    this.writeLine(line)
  }

  private send(message: JsonObject): void {
    this.writeLine(JSON.stringify({ jsonrpc: "2.0", ...message }))
  }

  respond(id: RpcId, result: JsonValue): void {
    this.send({ id, result })
  }

  respondError(id: RpcId, error: RpcError): void {
    this.send({ id, error })
  }

  notify(method: string, params: JsonValue): void {
    this.send({ method, params })
  }

  request(method: string, params: JsonValue): Promise<JsonValue> {
    const id = this.nextId++
    return new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ id, method, params })
    })
  }

  /** Feeds raw stdin bytes; forwards whole parsed requests/notifications. */
  ingest(chunk: string, onMessage: (message: JsonObject) => void): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      if (this.trace) process.stderr.write(`[mock-acp Stdin] ${line}\n`)
      let message: JsonObject
      try {
        message = JSON.parse(line) as JsonObject
      } catch {
        continue
      }
      if (this.settleResponse(message)) continue
      onMessage(message)
    }
  }

  private settleResponse(message: JsonObject): boolean {
    const id = message.id as RpcId | undefined
    if (id === undefined) return false
    if (message.result === undefined && message.error === undefined) return false
    const pending = this.pending.get(id)
    if (!pending) return true
    this.pending.delete(id)
    if (message.error !== undefined) {
      const error = message.error as { message?: string; code?: number } | null
      pending.reject(
        new ProtocolError({
          code: error?.code ?? INTERNAL_ERROR,
          message: error?.message ?? JSON.stringify(message.error),
        }),
      )
    } else {
      pending.resolve(message.result)
    }
    return true
  }

  rejectAllPending(reason: string): void {
    for (const [, pending] of this.pending) pending.reject(new Error(reason))
    this.pending.clear()
  }
}

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

type SessionState = {
  cancelled: boolean
  cancelWaiters: Set<() => void>
}

const U64_MASK = (1n << 64n) - 1n
const LCG_MULTIPLIER = 6364136223846793005n

class MockState {
  readonly sessions = new Map<string, SessionState>()
  private nextSession = 1
  promptCount = 0
  private random: bigint
  lastSetMode: string | null = null
  lastMcpServerCount = 0
  authenticated = false

  constructor(
    readonly args: Args,
    readonly scenario: Scenario,
  ) {
    this.random = args.seed & U64_MASK
  }

  newSession(): string {
    const id = `mock-session-${this.nextSession++}`
    this.session(id)
    return id
  }

  session(id: string): SessionState {
    let existing = this.sessions.get(id)
    if (!existing) {
      existing = { cancelled: false, cancelWaiters: new Set() }
      this.sessions.set(id, existing)
    }
    return existing
  }

  private delayMs(): number {
    let jitter = 0
    if (this.args.jitterMs !== 0) {
      this.random = (this.random * LCG_MULTIPLIER + 1n) & U64_MASK
      jitter = Number(this.random % BigInt(this.args.jitterMs + 1))
    }
    return this.args.latencyMs + jitter
  }

  async wait(): Promise<void> {
    const delay = this.delayMs()
    if (delay > 0) await sleep(delay)
  }

  private capabilityFlag(name: string): boolean {
    const raw = this.args.capabilities
    if (!raw) return false
    return raw.split(",").some(item => item.trim() === name)
  }

  supportsLoadSession(): boolean {
    return this.args.providerProfile === "cursor" || this.scenario === "load_session" || this.capabilityFlag("load_session")
  }

  supportsResumeSession(): boolean {
    return this.scenario === "load_session" || this.capabilityFlag("resume")
  }

  supportsCloseSession(): boolean {
    return this.scenario === "load_session" || this.capabilityFlag("close")
  }

  protocolVersion(): number {
    return this.capabilityFlag("protocol_v2") ? 2 : 1
  }

  malformedSession(): boolean {
    return this.capabilityFlag("malformed_session")
  }

  malformedInitialize(): boolean {
    return this.capabilityFlag("malformed_initialize")
  }

  requiresAuth(): boolean {
    return this.scenario === "auth_required" || this.capabilityFlag("auth")
  }

  advertisesAuth(): boolean {
    return this.requiresAuth() || this.capabilityFlag("auth_methods")
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function whenCancelled(session: SessionState): Promise<void> {
  return new Promise<void>(resolve => {
    session.cancelWaiters.add(() => resolve())
  })
}

// ---------------------------------------------------------------------------
// Payload helpers (mirror ACP schema serialization)
// ---------------------------------------------------------------------------

function textChunk(text: string): JsonObject {
  return { content: { type: "text", text } }
}

let updateSequence = 0
function sendUpdate(connection: Connection, sessionId: string, update: JsonObject): void {
  updateSequence += 1
  connection.notify("session/update", {
    sessionId,
    update: {
      eventId: `mock-event-${updateSequence}`,
      cursor: String(updateSequence),
      ...update,
    },
  })
}

function promptText(params: JsonObject): string {
  const blocks = (params.prompt as JsonObject[] | undefined) ?? []
  return blocks
    .filter(block => block?.type === "text")
    .map(block => String(block.text ?? ""))
    .join("")
}

function promptImageCount(params: JsonObject): number {
  const blocks = (params.prompt as JsonObject[] | undefined) ?? []
  return blocks.filter(block => block?.type === "image").length
}

/**
 * Byte-oriented chunking that never splits a UTF-8 code point, matching the
 * Rust `chunks()` helper: `chunks("aébc", 2) == ["a", "é", "bc"]`.
 */
function chunks(text: string, size: number): string[] {
  const width = Math.max(size, 1)
  const bytes = Buffer.from(text, "utf8")
  const out: string[] = []
  let start = 0
  while (start < bytes.length) {
    let end = Math.min(start + width, bytes.length)
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1
    if (end === start) end = start + utf8CharLength(bytes[start]!)
    out.push(bytes.subarray(start, end).toString("utf8"))
    start = end
  }
  return out
}

function utf8CharLength(lead: number): number {
  if (lead >= 0xf0) return 4
  if (lead >= 0xe0) return 3
  if (lead >= 0xc0) return 2
  return 1
}

function modelOptions(): JsonObject[] {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "mock-auto",
      options: [
        { value: "mock-auto", name: "Mock Auto" },
        { value: "mock-fast", name: "Mock Fast" },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// Non-prompt requests
// ---------------------------------------------------------------------------

async function handleRequest(
  state: MockState,
  connection: Connection,
  method: string,
  params: JsonObject,
): Promise<JsonValue> {
  switch (method) {
    case "initialize":
      return handleInitialize(state, params)

    case "session/new": {
      if (state.requiresAuth() && !state.authenticated) throw authRequiredError()
      validateOpenParams(state, params)
      state.lastMcpServerCount = ((params.mcpServers as unknown[] | undefined) ?? []).length
      const sessionId = state.newSession()
      const response: JsonObject = { sessionId }
      if (state.malformedSession()) delete response.sessionId
      if (state.scenario === "config_model" || state.scenario === "config_malformed") response.configOptions = modelOptions()
      if (state.scenario === "set_mode_plan") {
        response.modes = {
          currentModeId: "agent",
          availableModes: [
            { id: "agent", name: "Agent" },
            { id: "plan", name: "Plan" },
            { id: "ask", name: "Ask" },
          ],
        }
      }
      return response
    }

    case "session/load": {
      if (!state.supportsLoadSession()) throw new ProtocolError({ code: METHOD_NOT_FOUND, message: "Method not found" })
      validateOpenParams(state, params)
      const sessionId = String(params.sessionId ?? "")
      state.session(sessionId)
      if (state.scenario === "load_session") {
        sendUpdate(connection, sessionId, {
          sessionUpdate: "agent_message_chunk",
          ...textChunk("Mock replayed session message."),
        })
      }
      return {}
    }

    case "session/resume":
      if (!state.supportsResumeSession()) throw new ProtocolError({ code: METHOD_NOT_FOUND, message: "Method not found" })
      validateOpenParams(state, params)
      // Resume restores context without replaying history.
      state.session(String(params.sessionId ?? ""))
      return {}

    case "authenticate":
      if (params.methodId !== "mock-token") throw internalError("unknown auth method")
      state.authenticated = true
      return {}

    case "logout":
      state.authenticated = false
      return {}

    case "session/list":
      return {
        sessions: [...state.sessions.keys()].map(sessionId => ({
          sessionId,
          cwd: process.cwd(),
        })),
      }

    case "session/close":
      if (!state.supportsCloseSession()) throw new ProtocolError({ code: METHOD_NOT_FOUND, message: "Method not found" })
      if (state.args.strict && !state.sessions.has(String(params.sessionId ?? ""))) throw internalError("session already closed")
      state.sessions.delete(String(params.sessionId ?? ""))
      return {}
    case "session/delete":
      state.sessions.delete(String(params.sessionId ?? ""))
      return {}

    case "session/set_config_option":
      if (state.scenario === "config_malformed") return []
      return { configOptions: [] }

    case "session/set_mode":
      state.lastSetMode = String(params.modeId ?? "")
      return {}

    case "cursor/list_available_models":
      return {
        models: [
          { value: "mock-auto", name: "Mock Auto", configOptions: null },
          { value: "mock-fast", name: "Mock Fast", configOptions: null },
        ],
      }

    default:
      throw new ProtocolError({ code: METHOD_NOT_FOUND, message: "Method not found" })
  }
}

function handleInitialize(state: MockState, params: JsonObject): JsonValue {
  if (state.args.strict && params.protocolVersion !== 1) {
    throw internalError("yaade-mock-acp supports ACP protocol V1 only")
  }
  if (state.args.strict) {
    const client = params.clientCapabilities as JsonObject | undefined
    const fs = client?.fs as JsonObject | undefined
    const elicitation = client?.elicitation as JsonObject | undefined
    if (fs?.readTextFile !== true || fs.writeTextFile !== true || client?.terminal !== true || typeof elicitation?.form !== "object") {
      throw internalError("ACP v1 client capabilities must explicitly enable fs read/write, terminal, and elicitation")
    }
  }

  const cursor = state.args.providerProfile === "cursor"

  const agentCapabilities: JsonObject = {
    loadSession: cursor || state.supportsLoadSession(),
    promptCapabilities: { image: cursor, audio: false, embeddedContext: cursor },
    mcpCapabilities: { http: cursor, sse: cursor },
    sessionCapabilities: {},
    auth: {},
  }
  if (cursor) {
    agentCapabilities.sessionCapabilities = { list: {} }
  } else if (state.supportsResumeSession() || state.supportsLoadSession()) {
    agentCapabilities.sessionCapabilities = {
      list: {},
      delete: {},
      ...(state.supportsResumeSession() ? { resume: {} } : {}),
      ...(state.supportsCloseSession() ? { close: {} } : {}),
    }
  }
  if (state.advertisesAuth()) agentCapabilities.auth = { logout: {} }

  return {
    protocolVersion: state.protocolVersion(),
    agentCapabilities: state.malformedInitialize() ? null : agentCapabilities,
    authMethods: cursor
      ? [{ id: "cursor_login", name: "Log in to Cursor" }]
      : state.advertisesAuth() ? [{ id: "mock-token", name: "Mock token auth" }] : [],
    agentInfo: {
      name: "yaade-mock-acp",
      title: `YAADE Mock ACP (${state.args.providerProfile})`,
      version: "0.1",
    },
  }
}

function validateOpenParams(state: MockState, params: JsonObject): void {
  if (!state.args.strict) return
  const cwd = params.cwd
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.startsWith("file:")) {
    throw internalError("session open cwd must be an absolute native path")
  }
  if (!Array.isArray(params.mcpServers)) {
    throw internalError("session open mcpServers is required")
  }
  for (const raw of params.mcpServers) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw internalError("MCP server must be an object")
    const server = raw as JsonObject
    if (server.id !== undefined || typeof server.name !== "string") throw internalError("MCP wire server must strip id and retain name")
    if (server.type === undefined) {
      if (typeof server.command !== "string" || !Array.isArray(server.args) || !Array.isArray(server.env)) {
        throw internalError("stdio MCP server requires command, args, and env without type")
      }
      for (const entry of server.env) {
        if (!entry || typeof entry !== "object" || typeof (entry as JsonObject).name !== "string" || typeof (entry as JsonObject).value !== "string") throw internalError("stdio MCP env entry is malformed")
      }
    } else if (server.type === "http" || server.type === "sse") {
      if (typeof server.url !== "string" || !Array.isArray(server.headers)) throw internalError(`${server.type} MCP server requires url and headers`)
      for (const entry of server.headers) {
        if (!entry || typeof entry !== "object" || typeof (entry as JsonObject).name !== "string" || typeof (entry as JsonObject).value !== "string") throw internalError(`${server.type} MCP header is malformed`)
      }
    } else {
      throw internalError("MCP server type is invalid")
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt scenarios
// ---------------------------------------------------------------------------

type StopReason = "end_turn" | "cancelled" | "refusal"

async function answer(
  state: MockState,
  connection: Connection,
  sessionId: string,
  prompt: string,
): Promise<StopReason> {
  if (state.args.fault === "disconnect") throw internalError("mock disconnect fault")
  await state.wait()
  sendUpdate(connection, sessionId, {
    sessionUpdate: "agent_message_chunk",
    ...textChunk(`Mock agent reply: ${prompt}`),
  })
  return "end_turn"
}

async function handlePrompt(
  state: MockState,
  connection: Connection,
  params: JsonObject,
): Promise<JsonObject> {
  const sessionId = String(params.sessionId ?? "")
  const session = state.session(sessionId)
  session.cancelled = false
  const prompt = promptText(params)
  const promptNumber = ++state.promptCount

  let stopReason: StopReason

  switch (state.scenario) {
    case "malformed_callbacks": {
      const malformedRequests: Array<[string, JsonObject]> = [
        ["session/request_permission", { sessionId, toolCall: { toolCallId: "bad" }, options: [{ name: "Missing option id", kind: "allow_once" }] }],
        ["fs/read_text_file", { sessionId }],
        ["terminal/create", { sessionId, command: "printf", args: [1] }],
      ]
      for (const [method, malformed] of malformedRequests) {
        let rejected = false
        try {
          await connection.request(method, malformed)
        } catch (error) {
          if (!(error instanceof ProtocolError)) throw error
          rejected = true
        }
        if (!rejected) throw internalError(`${method} unexpectedly accepted malformed input`)
      }
      stopReason = await answer(state, connection, sessionId, prompt)
      break
    }

    case "malformed_update": {
      sendUpdate(connection, sessionId, { sessionUpdate: "usage_update", used: "invalid", size: 4096 })
      stopReason = "end_turn"
      break
    }

    case "thought_then_answer": {
      sendUpdate(connection, sessionId, {
        sessionUpdate: "agent_thought_chunk",
        ...textChunk("Mock thought: "),
      })
      sendUpdate(connection, sessionId, {
        sessionUpdate: "agent_thought_chunk",
        ...textChunk("considering the prompt."),
      })
      stopReason = await answer(state, connection, sessionId, prompt)
      break
    }

    case "tool_lifecycle": {
      const toolCallId = `tool-${promptNumber}`
      const fixturePath = "/workspace/src/mock-tool.ts"
      sendUpdate(connection, sessionId, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Read File",
        kind: "read",
        status: "pending",
        locations: [{ path: fixturePath }],
        rawInput: { path: fixturePath },
      })
      sendUpdate(connection, sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "in_progress",
      })
      await state.wait()
      sendUpdate(connection, sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: "export const mock = true",
      })
      stopReason = await answer(state, connection, sessionId, prompt)
      break
    }

    case "permission_allow":
    case "permission_tool_race":
    case "permission_allow_always": {
      const toolCall: JsonObject = {
        toolCallId: `permission-tool-${promptNumber}`,
        title: "Mock protected operation",
        kind: "execute",
        status: "in_progress",
      }
      // The update is sent before awaiting the request response. Both messages are
      // queued in one turn without a client round trip, reproducing the race.
      sendUpdate(connection, sessionId, { sessionUpdate: "tool_call_update", ...toolCall })
      const options: JsonObject[] = [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
      ]
      if (state.scenario === "permission_allow_always") {
        options.unshift({ optionId: "allow_always", name: "Always allow", kind: "allow_always" })
      }
      const response = (await connection.request("session/request_permission", {
        sessionId,
        toolCall,
        options,
      })) as { outcome?: { outcome?: string; optionId?: string } } | null
      const outcome = response?.outcome
      const picked = outcome?.outcome === "selected" ? outcome.optionId : undefined
      stopReason =
        picked === "allow_once" || picked === "allow_always"
          ? await answer(state, connection, sessionId, prompt)
          : "refusal"
      break
    }

    case "ask_question": {
      const response = (await connection.request("cursor/ask_question", {
        toolCallId: `ask-${promptNumber}`,
        title: "Mock question",
        questions: [
          {
            id: "q1",
            prompt: "Pick a color",
            allowMultiple: false,
            options: [
              { label: "Red", id: "red" },
              { label: "Blue", id: "blue" },
            ],
          },
        ],
      })) as { answers?: Array<{ selected?: string[] }> } | null
      const picked = response?.answers?.[0]?.selected?.[0] ?? "none"
      stopReason = await answer(state, connection, sessionId, `${prompt} -> ${picked}`)
      break
    }

    case "create_plan": {
      await connection.request("cursor/create_plan", {
        toolCallId: `plan-${promptNumber}`,
        name: "Mock plan",
        overview: "Deterministic mock plan",
        plan: "# Mock plan\n\n1. Inspect\n2. Answer",
        todos: [
          { id: "t1", content: "Inspect prompt", status: "completed" },
          { id: "t2", content: "Return answer", status: "pending" },
        ],
        isProject: false,
        phases: [],
      })
      stopReason = await answer(state, connection, sessionId, prompt)
      break
    }

    case "update_todos": {
      connection.notify("cursor/update_todos", {
        toolCallId: `todos-${promptNumber}`,
        todos: [
          { id: "t1", content: "Mock todo A", status: "in_progress" },
          { id: "t2", content: "Mock todo B", status: "pending" },
        ],
        merge: false,
      })
      stopReason = await answer(state, connection, sessionId, prompt)
      break
    }

    case "elicitation": {
      await connection.request("elicitation/create", {
        mode: "form",
        type: "session",
        sessionId,
        requestedSchema: {
          type: "object",
          properties: { note: { type: "string" } },
          required: ["note"],
        },
        message: "Mock elicitation: provide a note",
      })
      stopReason = await answer(state, connection, sessionId, prompt)
      break
    }

    case "image_prompt": {
      const images = promptImageCount(params)
      stopReason = await answer(state, connection, sessionId, `images=${images} ${prompt}`)
      break
    }

    case "auth_required":
      // Auth is enforced at session/new; once authenticated this is echo.
      stopReason = await answer(state, connection, sessionId, prompt)
      break

    case "plan_update": {
      sendUpdate(connection, sessionId, {
        sessionUpdate: "plan",
        entries: [
          { content: "Inspect mock prompt", priority: "high", status: "completed" },
          { content: "Return deterministic answer", priority: "medium", status: "in_progress" },
        ],
      })
      stopReason = await answer(state, connection, sessionId, prompt)
      break
    }

    case "cancel_coop": {
      sendUpdate(connection, sessionId, {
        sessionUpdate: "agent_thought_chunk",
        ...textChunk("Mock cancellation waiting."),
      })
      const raced = await Promise.race([
        whenCancelled(session).then(() => "cancelled" as const),
        sleep(60_000).then(() => "timeout" as const),
      ])
      stopReason =
        raced === "cancelled" ? "cancelled" : await answer(state, connection, sessionId, prompt)
      break
    }

    case "slow_stream": {
      const text = `Mock agent reply: ${prompt}`
      for (const part of chunks(text, state.args.chunkSize)) {
        if (session.cancelled) break
        sendUpdate(connection, sessionId, {
          sessionUpdate: "agent_message_chunk",
          ...textChunk(part),
        })
        await state.wait()
      }
      stopReason = session.cancelled ? "cancelled" : "end_turn"
      break
    }

    case "usage_meter": {
      sendUpdate(connection, sessionId, { sessionUpdate: "usage_update", used: 128, size: 4096 })
      stopReason = await answer(state, connection, sessionId, prompt)
      break
    }

    case "slash_commands": {
      sendUpdate(connection, sessionId, {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "/mock", description: "Run the mock agent" },
          { name: "/reset", description: "Reset mock state" },
        ],
      })
      stopReason = await answer(state, connection, sessionId, prompt)
      break
    }

    case "fs_roundtrip": {
      // Prompt may be an absolute read path (legacy) or a write basename.
      // Always perform a write+read under the session cwd when the prompt is not
      // an existing absolute file — proves the host FS write path works.
      const absoluteExisting = path.isAbsolute(prompt) && fs.existsSync(prompt)
      const writePath = absoluteExisting
        ? path.join(path.dirname(prompt) || ".", "acp-write-probe.txt")
        : "acp-write-probe.txt"
      const expectedContent = absoluteExisting
        ? `mock-write:${promptNumber}`
        : `mock-write:${prompt}`
      const alsoReadPrompt = absoluteExisting ? prompt : null

      await connection.request("fs/write_text_file", {
        sessionId,
        path: writePath,
        content: expectedContent,
      })
      const written = String(
        ((await connection.request("fs/read_text_file", { sessionId, path: writePath })) as {
          content?: string
        } | null)?.content ?? "",
      )
      let message = `Mock write+read: ${written}`
      if (alsoReadPrompt) {
        const original = String(
          ((await connection.request("fs/read_text_file", {
            sessionId,
            path: alsoReadPrompt,
          })) as { content?: string } | null)?.content ?? "",
        )
        message = `Mock read: ${original}\n${message}`
      }
      sendUpdate(connection, sessionId, {
        sessionUpdate: "agent_message_chunk",
        ...textChunk(message),
      })
      if (written !== expectedContent) {
        throw internalError(
          `fs_roundtrip: wrote ${JSON.stringify(expectedContent)} but read back ${JSON.stringify(written)}`,
        )
      }
      stopReason = "end_turn"
      break
    }

    case "terminal_roundtrip": {
      const created = (await connection.request("terminal/create", {
        sessionId,
        command: "/bin/echo",
        args: ["hi"],
      })) as { terminalId?: string } | null
      const terminalId = created?.terminalId
      await connection.request("terminal/wait_for_exit", { sessionId, terminalId })
      const output = (await connection.request("terminal/output", {
        sessionId,
        terminalId,
      })) as { output?: string } | null
      await connection.request("terminal/release", { sessionId, terminalId })
      sendUpdate(connection, sessionId, {
        sessionUpdate: "agent_message_chunk",
        ...textChunk(`Mock terminal: ${String(output?.output ?? "").trim()}`),
      })
      stopReason = "end_turn"
      break
    }

    case "chaos_malformed":
      // Initialize already injected a malformed JSON line; fail the prompt so
      // clients observe a hard transport/protocol error.
      throw internalError("chaos_malformed: intentional protocol/prompt failure")

    case "partial_then_error":
      sendUpdate(connection, sessionId, {
        sessionUpdate: "agent_message_chunk",
        ...textChunk("Partial output before transport failure."),
      })
      await sleep(50)
      throw internalError("partial_then_error: intentional prompt failure")

    case "set_mode_plan": {
      const mode = state.lastSetMode ?? "unset"
      stopReason = await answer(state, connection, sessionId, `mode:${mode} ${prompt}`)
      break
    }

    case "mcp_servers_inject":
      stopReason = await answer(
        state,
        connection,
        sessionId,
        `mcp_servers=${state.lastMcpServerCount}`,
      )
      break

    case "echo":
    case "config_model":
    case "load_session":
    case "multi_session":
    default:
      stopReason = await answer(state, connection, sessionId, prompt)
      break
  }

  return { stopReason }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

function resolveScenario(args: Args): Scenario {
  if ((SCENARIOS as readonly string[]).includes(args.scenario)) return args.scenario as Scenario
  if (!args.strict) {
    process.stderr.write(
      `mock-acp: unknown scenario ${JSON.stringify(args.scenario)}; falling back to echo\n`,
    )
    return "echo"
  }
  throw new Error(
    `unknown scenario ${JSON.stringify(args.scenario)}; available: ${SCENARIOS.join(", ")}`,
  )
}

function toRpcError(error: unknown): RpcError {
  if (error instanceof ProtocolError) return error.rpc
  return {
    code: INTERNAL_ERROR,
    message: "Internal error",
    data: error instanceof Error ? error.message : String(error),
  }
}

function run(args: Args): void {
  const scenario = resolveScenario(args)
  for (let line = 0; line < args.stderrNoise; line += 1) {
    process.stderr.write(`mock-acp stderr noise ${line}\n`)
  }

  const state = new MockState(args, scenario)
  const connection = new Connection(args.trace)

  const dispatch = (message: JsonObject): void => {
    const method = typeof message.method === "string" ? message.method : null
    if (!method) return
    const params = (message.params as JsonObject | undefined) ?? {}
    const id = message.id as RpcId | undefined

    if (id === undefined) {
      if (method === "session/cancel") {
        const session = state.session(String(params.sessionId ?? ""))
        session.cancelled = true
        for (const waiter of session.cancelWaiters) waiter()
        session.cancelWaiters.clear()
      }
      return
    }

    if (method === "session/prompt") {
      // Prompt turns run concurrently with the read loop so cancel notifications
      // and client responses still land while a turn is in flight.
      void handlePrompt(state, connection, params)
        .then(response => {
          connection.respond(id, response)
          if (args.exitAfter !== 0 && state.promptCount >= args.exitAfter) {
            // Closing stdio after the response is deliberate: it lets process-exit
            // handling be tested without corrupting the current turn.
            setTimeout(() => process.exit(0), 10)
          }
        })
        .catch(error => connection.respondError(id, toRpcError(error)))
      return
    }

    void handleRequest(state, connection, method, params)
      .then(result => {
        connection.respond(id, result)
        if (
          method === "initialize" &&
          (scenario === "chaos_malformed" || args.fault === "malformed")
        ) {
          // Intentional protocol fault used by transport error tests.
          connection.writeRaw("{ this is intentionally malformed json")
        }
      })
      .catch(error => connection.respondError(id, toRpcError(error)))
  }

  process.stdin.setEncoding("utf8")
  process.stdin.on("data", chunk => connection.ingest(String(chunk), dispatch))
  process.stdin.on("end", () => {
    connection.rejectAllPending("stdin closed")
    process.exit(0)
  })
}

function main(): void {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(
      `yaade-mock-acp: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(1)
    return
  }
  try {
    run(args)
  } catch (error) {
    process.stderr.write(
      `yaade-mock-acp: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(1)
  }
}

main()
