import assert from "node:assert/strict"
import { test } from "node:test"
import type { AgentDriverContext, AgentSpawnedProcess } from "@yaade/agent-driver"
import { AgentCommandEnvelope } from "@yaade/agent-protocol"
import { runAgentDriverConformanceSuite } from "@yaade/agent-testkit"
import { Schema } from "effect"
import { ClaudeAgentSdkDriver, truncateSemanticText } from "./index.js"

class MockClaudeSdk implements AgentSpawnedProcess {
  readonly id = "mock-claude"
  private readonly values: Uint8Array[] = []
  private readonly waiters: Array<(value: IteratorResult<Uint8Array>) => void> = []
  readonly stdout: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => this.next() }) }
  readonly stderr: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: async function* () { return } }
  async writeStdin(bytes: Uint8Array): Promise<void> {
    const message = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
    if (message.type === "control_request") this.push({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { models: [{ value: "mock-sonnet", displayName: "Mock Sonnet" }] } } })
    if (message.type === "user") {
      this.push({ type: "system", subtype: "init", session_id: "mock-session", model: "mock-sonnet", permissionMode: "default" })
      this.push({ type: "stream_event", uuid: "a1", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } })
      this.push({ type: "stream_event", uuid: "a1", event: { type: "content_block_delta", index: 0, delta: { text: "mock:hello" } } })
      this.push({ type: "stream_event", uuid: "a1", event: { type: "content_block_stop", index: 0 } })
      this.push({ type: "result", subtype: "success", session_id: "mock-session", usage: { input_tokens: 2, output_tokens: 1 }, total_cost_usd: 0.001 })
    }
  }
  async wait(): Promise<{ readonly exitCode: number | null }> { return { exitCode: 0 } }
  async stop(): Promise<void> { for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined }) }
  private push(value: unknown): void { const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`); const waiter = this.waiters.shift(); if (waiter) waiter({ done: false, value: bytes }); else this.values.push(bytes) }
  private next(): Promise<IteratorResult<Uint8Array>> { const value = this.values.shift(); return value ? Promise.resolve({ done: false, value }) : new Promise(resolve => this.waiters.push(resolve)) }
}

function context(): AgentDriverContext { return { workspace: { rootUri: "file:///workspace", additionalRoots: [], assertAllowed: () => Promise.resolve() }, filesystem: { readFile: () => Promise.resolve(new Uint8Array()), writeFile: () => Promise.resolve(), stat: () => Promise.resolve({ size: 0 }) }, terminal: { open: () => Promise.reject(new Error("unused")) }, processSpawner: { spawn: () => Promise.resolve(new MockClaudeSdk()) }, commands: { resolveExecutable: async candidates => candidates[0], probe: async () => ({ exitCode: 0, output: "mock" }) }, attachments: { resolve: () => Promise.reject(new Error("unused")), read: () => Promise.reject(new Error("unused")) }, credentials: { get: () => Promise.resolve(undefined) }, mcp: { listServers: () => Promise.resolve([]) }, clock: { now: () => new Date("2026-01-01T00:00:00.000Z"), sleep: () => Promise.resolve() }, logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }, signal: new AbortController().signal } }

test("normalizes Claude stream-json text, usage, binding, and duplicate command IDs", async () => {
  const driver = new ClaudeAgentSdkDriver()
  const connection = await driver.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///workspace" })
  const command = Schema.decodeUnknownSync(AgentCommandEnvelope)({ protocolVersion: 1, commandId: "c1", threadId: "t1", issuedAt: "2026-01-01T00:00:00.000Z", command: { type: "turn.submit", input: [{ type: "text", text: "hello" }] } })
  assert.equal((await connection.send(command)).status, "accepted")
  assert.equal((await connection.send(command)).status, "already-applied")
  const iterator = connection.events()[Symbol.asyncIterator](); const types: string[] = []; const nativeIds: string[] = []
  for (let index = 0; index < 10; index += 1) { const next = await iterator.next(); if (!next.done) { types.push(next.value.event.type); if (next.value.nativeEventId) nativeIds.push(next.value.nativeEventId) } }
  assert.equal(types.filter(type => type === "item.started").length, 2)
  assert.ok(types.includes("item.delta")); assert.ok(types.includes("usage.updated")); assert.ok(types.includes("turn.completed"))
  assert.ok(nativeIds.includes("a1"))
  await connection.close("user")
})

test("Claude semantic truncation is UTF-8 bounded at an emoji boundary", () => {
  const bounded = truncateSemanticText("a".repeat(65_535) + "😀")
  assert.equal(new TextEncoder().encode(bounded).byteLength, 65_535)
  assert.equal(bounded.includes("�"), false)
})

test("Claude fixture passes the same core lifecycle suite and advertises only normalized features", async () => {
  const driver = new ClaudeAgentSdkDriver({ command: process.execPath })
  const report = await runAgentDriverConformanceSuite({
    driver, context: context(), request: { mode: { type: "new" }, cwdUri: "file:///workspace" },
    command: Schema.decodeUnknownSync(AgentCommandEnvelope)({ protocolVersion: 1, commandId: "conformance", threadId: "thread", issuedAt: "2026-01-01T00:00:00.000Z", command: { type: "turn.submit", input: [{ type: "text", text: "hello" }] } }),
    expectedEventCount: 1,
  })
  assert.equal(report.passed, true, JSON.stringify(report.checks))
  const connection = await driver.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///workspace" })
  assert.equal(connection.capabilities.input.images, "unsupported")
  assert.equal(connection.capabilities.output.reasoning, "unsupported")
  assert.equal(connection.capabilities.tools.streaming, "unsupported")
  const rejected = await connection.send(Schema.decodeUnknownSync(AgentCommandEnvelope)({ protocolVersion: 1, commandId: "bad-config", threadId: "thread", issuedAt: "2026-01-01T00:00:00.000Z", command: { type: "configuration.set", optionId: "unknown", value: "x" } }))
  assert.equal(rejected.status, "rejected")
  await connection.close("user")
})
