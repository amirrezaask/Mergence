import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import type { AgentDriverContext, AgentMcpServer, AgentSpawnedProcess, AgentThreadConnection } from "@yaade/agent-driver"
import { AgentCommandEnvelope, AgentAttachment, ProviderSessionId, type UnsequencedAgentEvent } from "@yaade/agent-protocol"
import { runAgentDriverConformanceSuite } from "@yaade/agent-testkit"
import { Schema } from "effect"
import { AcpAgentDriver, truncateSemanticText } from "./index.js"
import { JsonLineRpc } from "./json-line-rpc.js"
import { AsyncQueue } from "./async-queue.js"
import { cursorAcpProfile, mockAcpProfile } from "./profiles.js"
import { detectAcpCommand } from "./detect-command.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const bin = path.join(root, "apps/host-server/mocks/bin/yaade-mock-acp")

function context(options: {
  readonly mcpServers?: ReadonlyArray<AgentMcpServer>
  readonly attachment?: AgentAttachment
  readonly file?: Uint8Array
} = {}): AgentDriverContext {
  return {
    workspace: { rootUri: "file:///tmp", additionalRoots: [], assertAllowed: async () => {} },
    filesystem: { readFile: async () => options.file ?? new Uint8Array(), writeFile: async () => {}, stat: async () => ({ size: options.file?.byteLength ?? 0 }) },
    terminal: { open: async () => ({ id: "t", write: async () => {}, readOutput: async () => ({ output: "hi\n", truncated: false }), waitForExit: async () => ({ exitCode: 0 }), close: async () => {} }) },
    processSpawner: { spawn: async ({ command, args }): Promise<AgentSpawnedProcess> => {
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
      if (!child.stdin || !child.stdout || !child.stderr) throw new Error("mock ACP did not expose stdio")
      return {
        id: "mock",
        stdout: child.stdout,
        stderr: child.stderr,
        writeStdin: async data => { child.stdin.write(data) },
        wait: async () => new Promise(resolve => child.once("exit", (code, signal) => resolve({ exitCode: code, ...(signal ? { signal } : {}) }))),
        stop: async () => { child.kill() },
      }
    } },
    commands: {
      resolveExecutable: async candidates => candidates.find(candidate => candidate === bin) ?? candidates[0],
      probe: async () => ({ exitCode: 0, output: "mock" }),
    },
    attachments: {
      resolve: async () => options.attachment ?? Promise.reject(new Error("unused")),
      read: async () => options.file ?? Promise.reject(new Error("unused")),
    },
    credentials: { get: async () => undefined },
    mcp: { listServers: async () => options.mcpServers ?? [] },
    clock: { now: () => new Date(), sleep: async () => {} },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
  }
}

function command(commandId: string, command: Record<string, unknown>) {
  return Schema.decodeUnknownSync(AgentCommandEnvelope)({ protocolVersion: 1, commandId, threadId: "thread", issuedAt: new Date().toISOString(), command })
}

const providerSessionId = (value: string) => Schema.decodeUnknownSync(ProviderSessionId)(value)

async function collectUntil(connection: AgentThreadConnection, predicate: (event: UnsequencedAgentEvent) => boolean): Promise<UnsequencedAgentEvent[]> {
  const events: UnsequencedAgentEvent[] = []
  const abort = new AbortController()
  for await (const event of connection.events(abort.signal)) {
    events.push(event)
    if (predicate(event)) abort.abort()
  }
  return events
}

function cursorFixture(...args: ReadonlyArray<string>) {
  return {
    ...cursorAcpProfile(bin),
    args: ["--provider-profile", "cursor", ...args],
  }
}

test("ACP mock preserves accumulated streamed text in the completed item", async () => {
  const driver = new AcpAgentDriver(mockAcpProfile(bin, ["--scenario", "echo", "--chunk-size", "3"]))
  const connection = await driver.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  assert.equal((await connection.send(command("c1", { type: "turn.submit", input: [{ type: "text", text: "hello" }] }))).status, "accepted")
  const events = await collectUntil(connection, event => event.event.type === "turn.completed")
  const completed = events.find(event => event.event.type === "item.completed" && event.event.item.type === "assistant-message")
  assert.ok(completed)
  if (completed.event.type !== "item.completed" || completed.event.item.type !== "assistant-message") throw new Error("missing completed assistant message")
  assert.equal(completed.event.item.text, "Mock agent reply: hello")
  await connection.close("user")
})

test("ACP semantic truncation is UTF-8 bounded at an emoji boundary", () => {
  const value = "a".repeat(65_535) + "😀"
  const bounded = truncateSemanticText(value)
  assert.ok(new TextEncoder().encode(bounded).byteLength <= 65_536)
  assert.equal(bounded.includes("�"), false)
})

test("ACP RPC rejects the 65th pending request", async () => {
  const stalled: AgentSpawnedProcess = {
    id: "stalled", stdout: { async *[Symbol.asyncIterator]() { await new Promise<void>(() => {}) } }, stderr: { async *[Symbol.asyncIterator]() {} },
    writeStdin: async () => {}, wait: async () => ({ exitCode: null }), stop: async () => {},
  }
  const rpc = new JsonLineRpc(stalled)
  for (let index = 0; index < 64; index += 1) void rpc.request("pending", {})
  await assert.rejects(rpc.request("overflow", {}), /pending request limit/)
})

test("ACP RPC applies its protocol-line limit to UTF-8 bytes", async () => {
  const oversizedLine = new TextEncoder().encode(`${"😀".repeat(524_289)}\n`)
  const process: AgentSpawnedProcess = {
    id: "oversized",
    stdout: { async *[Symbol.asyncIterator]() { yield oversizedLine } },
    stderr: { async *[Symbol.asyncIterator]() {} },
    writeStdin: async () => {},
    wait: async () => ({ exitCode: null }),
    stop: async () => {},
  }
  const rpc = new JsonLineRpc(process)
  const failure = new Promise<Error>(resolve => rpc.onClose(resolve))
  await assert.doesNotReject(async () => {
    assert.match((await failure).message, /oversized protocol line/)
  })
  await rpc.close()
})

test("ACP mock passes the shared driver lifecycle suite", async () => {
  const report = await runAgentDriverConformanceSuite({
    driver: new AcpAgentDriver(mockAcpProfile(bin, ["--scenario", "echo"])),
    context: context(), request: { mode: { type: "new" }, cwdUri: "file:///tmp" },
    command: command("conformance", { type: "turn.submit", input: [{ type: "text", text: "hello" }] }),
    expectedEventCount: 5,
  })
  assert.equal(report.passed, true, JSON.stringify(report.checks))
})

test("ACP rejects a permission option that was not advertised", async () => {
  const driver = new AcpAgentDriver(mockAcpProfile(bin, ["--scenario", "permission_allow"]))
  const connection = await driver.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  assert.equal((await connection.send(command("c1", { type: "turn.submit", input: [{ type: "text", text: "hello" }] }))).status, "accepted")
  const pending = await collectUntil(connection, event => event.event.type === "action.requested")
  const requested = pending.find(event => event.event.type === "action.requested")
  assert.ok(requested)
  if (requested.event.type !== "action.requested" || requested.event.action.type !== "permission") throw new Error("missing permission action")
  const invalid = await connection.send(command("c2", { type: "action.respond", actionId: requested.event.action.id, response: { type: "permission", optionId: "not-advertised" } }))
  assert.equal(invalid.status, "rejected")
  const valid = await connection.send(command("c3", { type: "action.respond", actionId: requested.event.action.id, response: { type: "permission", optionId: requested.event.action.options[0]!.id } }))
  assert.equal(valid.status, "accepted")
  const raced = await connection.send(command("c4", { type: "action.respond", actionId: requested.event.action.id, response: { type: "permission", optionId: requested.event.action.options[0]!.id } }))
  assert.equal(raced.status, "rejected")
  await collectUntil(connection, event => event.event.type === "turn.completed")
  await connection.close("user")
})

test("ACP terminal output and wait bridge round-trips bounded host output", async () => {
  const driver = new AcpAgentDriver(mockAcpProfile(bin, ["--scenario", "terminal_roundtrip"]))
  const connection = await driver.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  assert.equal(connection.capabilities.tools.terminal, "native")
  assert.equal((await connection.send(command("terminal", { type: "turn.submit", input: [{ type: "text", text: "terminal" }] }))).status, "accepted")
  const events = await collectUntil(connection, event => event.event.type === "turn.completed")
  assert.ok(events.some(event => event.event.type === "item.completed" && event.event.item.type === "assistant-message" && event.event.item.text === "Mock terminal: hi"))
  await connection.close("user")
})

test("ACP advertises negotiated dynamic configuration truthfully", async () => {
  const driver = new AcpAgentDriver(mockAcpProfile(bin, ["--scenario", "config_model"]))
  const connection = await driver.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  assert.equal(connection.capabilities.configuration.dynamicOptions, "native")
  assert.ok(connection.configuration?.some(option => option.id === "model" && option.value.type === "enum"))
  await connection.close("user")
})

test("ACP normalizes native reasoning and streamed tool lifecycles", async () => {
  const reasoningDriver = new AcpAgentDriver(mockAcpProfile(bin, ["--scenario", "thought_then_answer"]))
  const reasoning = await reasoningDriver.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  await reasoning.send(command("reasoning", { type: "turn.submit", input: [{ type: "text", text: "think" }] }))
  const reasoningEvents = await collectUntil(reasoning, event => event.event.type === "turn.completed")
  assert.ok(reasoningEvents.some(event => event.event.type === "item.completed" && event.event.item.type === "reasoning" && event.event.item.text === "Mock thought: considering the prompt."))
  await reasoning.close("user")

  const toolDriver = new AcpAgentDriver(mockAcpProfile(bin, ["--scenario", "tool_lifecycle"]))
  const tool = await toolDriver.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  await tool.send(command("tool", { type: "turn.submit", input: [{ type: "text", text: "use tool" }] }))
  const toolEvents = await collectUntil(tool, event => event.event.type === "turn.completed")
  assert.ok(toolEvents.some(event => event.event.type === "item.started" && event.event.item.type === "tool-call"))
  assert.ok(toolEvents.some(event => (event.event.type === "item.updated" || event.event.type === "item.completed") && event.event.item.type === "tool-call" && event.event.item.status === "completed"))
  await tool.close("user")
})

test("ACP maps elicitation schemas and reports terminal support honestly", async () => {
  const driver = new AcpAgentDriver(mockAcpProfile(bin, ["--scenario", "elicitation"]))
  const connection = await driver.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  assert.equal(connection.capabilities.tools.terminal, "native")
  assert.equal((await connection.send(command("c1", { type: "turn.submit", input: [{ type: "text", text: "hello" }] }))).status, "accepted")
  const pending = await collectUntil(connection, event => event.event.type === "action.requested")
  const requested = pending.find(event => event.event.type === "action.requested")
  assert.ok(requested)
  if (requested.event.type !== "action.requested" || requested.event.action.type !== "elicitation") throw new Error("missing elicitation action")
  assert.deepEqual(requested.event.action.fields, [{ id: "note", label: "note", required: true, input: "text" }])
  assert.equal((await connection.send(command("c2", { type: "action.respond", actionId: requested.event.action.id, response: { type: "elicitation", values: { note: "done" } } }))).status, "accepted")
  await collectUntil(connection, event => event.event.type === "turn.completed")
  await connection.close("user")
})

test("ACP queue closes deterministically on byte overflow", async () => {
  const queue = new AsyncQueue<string>()
  assert.equal(queue.push("x".repeat(AsyncQueue.maxBytes)), false)
  assert.equal(queue.didOverflow, true)
  assert.deepEqual(await queue.iterate()[Symbol.asyncIterator]().next(), { done: true, value: undefined })
})

test("ACP truncates oversized semantic provider output with an explicit marker", () => {
  const output = truncateSemanticText("x".repeat(70_000))
  assert.ok(output.includes("[yaade: truncated oversized provider payload]"))
  assert.ok(new TextEncoder().encode(output).byteLength < 70_000)
})

test("Cursor ACP v1 sends exact client capabilities, native cwd, MCP input, and truthful capabilities", async () => {
  const attachment = AgentAttachment.make({
    id: "image-1",
    name: "pixel.png",
    mediaType: "image/png",
    size: 4,
    source: { type: "temporary-upload", storageKey: "opaque-image-capability" },
    createdAt: "2026-01-01T00:00:00.000Z",
  })
  const driver = new AcpAgentDriver(cursorFixture("--strict", "--scenario", "image_prompt"))
  const connection = await driver.openThread(context({
    mcpServers: [{ type: "http", id: "mcp-1", name: "Fixture MCP", url: "https://mcp.example.test/rpc", headers: [{ name: "Authorization", value: "test-only" }] }],
    attachment,
    file: new Uint8Array([1, 2, 3, 4]),
  }), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  assert.equal(connection.capabilities.input.images, "native")
  assert.equal(connection.capabilities.threads.load, "native")
  assert.equal(connection.capabilities.threads.resume, "unsupported")
  assert.equal(connection.capabilities.threads.list, "unsupported")
  assert.equal((await connection.send(command("image", {
    type: "turn.submit",
    input: [{ type: "attachment", attachmentId: "image-1", purpose: "image" }],
  }))).status, "accepted")
  const events = await collectUntil(connection, event => event.event.type === "turn.completed")
  assert.ok(events.some(event => event.nativeEventId?.startsWith("mock-event-") && event.providerCursor))
  assert.ok(events.some(event => event.event.type === "item.completed" && event.event.item.type === "assistant-message" && event.event.item.text.includes("images=1")))
  assert.equal((await connection.send(command("close", { type: "thread.close" }))).status, "accepted")
  await connection.close("user")
})

test("Cursor load includes cwd and MCP input while unadvertised resume is rejected", async () => {
  const profile = cursorFixture("--strict", "--scenario", "load_session")
  const driver = new AcpAgentDriver(profile)
  const loaded = await driver.openThread(context({ mcpServers: [{ type: "sse", id: "mcp", name: "MCP", url: "https://mcp.example.test/events", headers: [] }] }), {
    mode: { type: "load", providerSessionId: providerSessionId("cursor-session-1") },
    cwdUri: "file:///tmp",
  })
  assert.equal(loaded.binding.providerSessionId, "cursor-session-1")
  await loaded.send(command("loaded-turn", { type: "turn.submit", input: [{ type: "text", text: "after load" }] }))
  const loadedEvents = await collectUntil(loaded, event => event.event.type === "turn.completed")
  assert.equal(loadedEvents.some(event => event.event.type === "item.delta" && event.event.text.includes("replayed")), false)
  await loaded.close("user")
  await assert.rejects(
    driver.openThread(context(), {
      mode: { type: "resume", providerSessionId: providerSessionId("cursor-session-1") },
      cwdUri: "file:///tmp",
    }),
    /did not advertise session\/resume/,
  )

  const resumable = new AcpAgentDriver(mockAcpProfile(bin, ["--strict", "--capabilities", "resume"]))
  const resumed = await resumable.openThread(context({
    mcpServers: [{
      type: "stdio",
      id: "stdio-mcp",
      name: "Stdio MCP",
      command: "fixture-mcp",
      args: ["--stdio"],
      env: [{ name: "FIXTURE", value: "true" }],
    }],
  }), {
    mode: { type: "resume", providerSessionId: providerSessionId("mock-session-resume") },
    cwdUri: "file:///tmp",
  })
  await resumed.close("user")
})

test("Cursor vendor elicitation is profile-gated", async () => {
  const generic = new AcpAgentDriver(mockAcpProfile(bin, ["--scenario", "ask_question"]))
  const genericConnection = await generic.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  await genericConnection.send(command("generic-ask", { type: "turn.submit", input: [{ type: "text", text: "ask" }] }))
  const failed = await collectUntil(genericConnection, event => event.event.type === "turn.failed")
  assert.ok(failed.some(event => event.event.type === "turn.failed"))
  await genericConnection.close("user")

  const cursor = new AcpAgentDriver(cursorFixture("--scenario", "ask_question"))
  const cursorConnection = await cursor.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  await cursorConnection.send(command("cursor-ask", { type: "turn.submit", input: [{ type: "text", text: "ask" }] }))
  const requested = await collectUntil(cursorConnection, event => event.event.type === "action.requested")
  const action = requested.find(event => event.event.type === "action.requested")
  assert.ok(action && action.event.type === "action.requested" && action.event.action.type === "elicitation")
  await cursorConnection.close("user")
})

test("ACP rejects protocol drift and malformed required session fields", async () => {
  const mismatch = new AcpAgentDriver(mockAcpProfile(bin, ["--capabilities", "protocol_v2"]))
  await assert.rejects(
    mismatch.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" }),
    /Unsupported ACP protocol version: 2/,
  )
  const malformed = new AcpAgentDriver(mockAcpProfile(bin, ["--capabilities", "malformed_session"]))
  await assert.rejects(
    malformed.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" }),
    /sessionId is required/,
  )
  const malformedInitialize = new AcpAgentDriver(mockAcpProfile(bin, ["--capabilities", "malformed_initialize"]))
  await assert.rejects(
    malformedInitialize.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" }),
    /initialize agentCapabilities/,
  )
})

test("Cursor detection covers alias fallback, version, auth, abort, and probe failure", async () => {
  const profile = { ...cursorAcpProfile(bin), executableCandidates: ["/definitely/missing/cursor-agent", bin] }
  const commands = {
    resolveExecutable: async () => bin,
    probe: async () => ({ exitCode: 0, output: "unused" }),
  }
  const calls: string[][] = []
  const detected = await detectAcpCommand(profile, {
    cwdUri: "file:///tmp",
    signal: new AbortController().signal,
    commands,
  }, async (_command, args) => {
    calls.push([...args])
    return args[0] === "--version"
      ? { exitCode: 0, output: "Cursor Agent 1.2.3" }
      : { exitCode: 0, output: "Authenticated" }
  })
  assert.deepEqual(detected, { available: true, version: "1.2.3" })
  assert.deepEqual(calls, [["--version"], ["status"]])

  const unauthenticated = await detectAcpCommand(profile, {
    cwdUri: "file:///tmp",
    signal: new AbortController().signal,
    commands,
  }, async (_command, args) => args[0] === "--version"
    ? { exitCode: 0, output: "1.2.3" }
    : { exitCode: 1, output: "Not logged in" })
  assert.equal(unauthenticated.available, false)
  assert.match(unauthenticated.reason ?? "", /Run agent login/)

  const aborted = new AbortController()
  aborted.abort()
  assert.deepEqual(await detectAcpCommand(profile, { cwdUri: "file:///tmp", signal: aborted.signal, commands }), { available: false, reason: "aborted" })

  const failed = await detectAcpCommand(profile, {
    cwdUri: "file:///tmp",
    signal: new AbortController().signal,
    commands,
  }, async () => { throw new Error("probe exploded") })
  assert.equal(failed.available, false)
  assert.match(failed.reason ?? "", /version probe failed: probe exploded/)

  const missing = await detectAcpCommand({ ...profile, executableCandidates: ["/definitely/missing/cursor-agent"] }, {
    cwdUri: "file:///tmp",
    signal: new AbortController().signal,
    commands: { ...commands, resolveExecutable: async () => undefined },
  })
  assert.equal(missing.available, false)
  assert.match(missing.reason ?? "", /not found on PATH/)
})

test("ACP rejects malformed permission, filesystem, and terminal callback fields", async () => {
  const driver = new AcpAgentDriver(mockAcpProfile(bin, ["--scenario", "malformed_callbacks"]))
  const connection = await driver.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  await connection.send(command("malformed-callbacks", { type: "turn.submit", input: [{ type: "text", text: "validate" }] }))
  const events = await collectUntil(connection, event => event.event.type === "turn.completed")
  assert.ok(events.some(event => event.event.type === "turn.completed"))
  await connection.close("user")
})

test("malformed updates and provider exit terminate the event stream for host recovery", async () => {
  const malformedDriver = new AcpAgentDriver(mockAcpProfile(bin, ["--scenario", "malformed_update"]))
  const malformed = await malformedDriver.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  const malformedEvents = (async () => {
    const events: UnsequencedAgentEvent[] = []
    for await (const event of malformed.events()) events.push(event)
    return events
  })()
  await malformed.send(command("malformed-update", { type: "turn.submit", input: [{ type: "text", text: "validate" }] }))
  const observedMalformed = await malformedEvents
  assert.ok(observedMalformed.some(event => event.event.type === "agent.error" && event.event.code === "acp.transport"))
  await malformed.close("user")

  const exitDriver = new AcpAgentDriver(mockAcpProfile(bin, ["--scenario", "echo", "--exit-after", "1"]))
  const exited = await exitDriver.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  const exitEvents = (async () => {
    const events: UnsequencedAgentEvent[] = []
    for await (const event of exited.events()) events.push(event)
    return events
  })()
  await exited.send(command("provider-exit", { type: "turn.submit", input: [{ type: "text", text: "bye" }] }))
  const observedExit = await exitEvents
  assert.ok(observedExit.some(event => event.event.type === "turn.completed"))
  assert.ok(observedExit.some(event => event.event.type === "agent.error" && event.event.code === "acp.transport"))
  await exited.close("driver-restart")
})

test("ACP rejects a malformed configuration response at the native boundary", async () => {
  const driver = new AcpAgentDriver(mockAcpProfile(bin, ["--scenario", "config_malformed"]))
  const connection = await driver.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  const result = await connection.send(command("bad-config", {
    type: "configuration.set",
    optionId: "model",
    value: "mock-fast",
  }))
  assert.equal(result.status, "rejected")
  if (result.status === "rejected") assert.match(result.error.message, /session\/set_config_option response/)
  await connection.close("user")
})

test("native session close is capability-gated and emitted exactly once", async () => {
  const profile = mockAcpProfile(bin, ["--scenario", "load_session", "--strict"])
  const direct = await new AcpAgentDriver(profile).openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  await direct.close("user")

  const commanded = await new AcpAgentDriver(profile).openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  assert.equal((await commanded.send(command("native-close", { type: "thread.close" }))).status, "accepted")
  await commanded.close("user")

  const unsupported = await new AcpAgentDriver(mockAcpProfile(bin, ["--scenario", "echo", "--strict"]))
    .openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  await unsupported.close("user")
})

test("Cursor profile preserves exact permission, configuration, and interrupt lifecycles", async () => {
  const permission = await new AcpAgentDriver(cursorFixture("--scenario", "permission_allow"))
    .openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  await permission.send(command("cursor-permission-turn", { type: "turn.submit", input: [{ type: "text", text: "permission" }] }))
  const permissionEvents = await collectUntil(permission, event => event.event.type === "action.requested")
  const permissionRequest = permissionEvents.find(event => event.event.type === "action.requested")
  if (!permissionRequest || permissionRequest.event.type !== "action.requested" || permissionRequest.event.action.type !== "permission") throw new Error("missing Cursor permission")
  assert.equal(permissionRequest.event.action.options[0]?.id, "allow_once")
  assert.equal((await permission.send(command("cursor-permission-response", {
    type: "action.respond",
    actionId: permissionRequest.event.action.id,
    response: { type: "permission", optionId: "allow_once" },
  }))).status, "accepted")
  await collectUntil(permission, event => event.event.type === "turn.completed")
  await permission.close("user")

  const configuration = await new AcpAgentDriver(cursorFixture("--scenario", "config_model"))
    .openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  assert.equal(configuration.capabilities.configuration.dynamicOptions, "native")
  assert.equal((await configuration.send(command("cursor-config", {
    type: "configuration.set",
    optionId: "model",
    value: "mock-fast",
  }))).status, "accepted")
  await configuration.close("user")

  const interrupted = await new AcpAgentDriver(cursorFixture("--scenario", "cancel_coop"))
    .openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" })
  await interrupted.send(command("cursor-interrupt-turn", { type: "turn.submit", input: [{ type: "text", text: "wait" }] }))
  await collectUntil(interrupted, event => event.event.type === "item.delta")
  assert.equal((await interrupted.send(command("cursor-interrupt", {
    type: "turn.interrupt",
    turnId: "acp-turn:cursor-interrupt-turn",
  }))).status, "accepted")
  const interruptEvents = await collectUntil(interrupted, event => event.event.type === "turn.interrupted")
  assert.ok(interruptEvents.some(event => event.event.type === "turn.interrupted"))
  await interrupted.close("user")
})
