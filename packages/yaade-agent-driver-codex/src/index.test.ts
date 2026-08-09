import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import type { AgentDriverContext, AgentSpawnedProcess } from "@yaade/agent-driver"
import { AgentCommandEnvelope } from "@yaade/agent-protocol"
import { Schema } from "effect"
import { CodexAppServerDriver, truncateSemanticText } from "./index.js"
import { AsyncQueue } from "./queue.js"

function context(): AgentDriverContext {
  return {
    workspace: { rootUri: "file:///tmp", additionalRoots: [], assertAllowed: () => Promise.resolve() },
    filesystem: { readFile: () => Promise.resolve(new Uint8Array()), writeFile: () => Promise.resolve(), stat: () => Promise.resolve({ size: 0 }) },
    terminal: { open: () => Promise.reject(new Error("unused")) },
    processSpawner: { spawn: ({ command, args, cwdUri, env }) => spawnProcess(command, args, cwdUri, env) },
    commands: { resolveExecutable: async candidates => candidates[0], probe: async () => ({ exitCode: 0, output: "mock" }) },
    attachments: { resolve: () => Promise.reject(new Error("unused")), read: () => Promise.reject(new Error("unused")) }, credentials: { get: () => Promise.resolve(undefined) }, mcp: { listServers: () => Promise.resolve([]) },
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z"), sleep: () => Promise.resolve() }, logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }, signal: new AbortController().signal,
  }
}

function spawnProcess(command: string, args: ReadonlyArray<string>, cwdUri: string, env: Readonly<Record<string, string>>): Promise<AgentSpawnedProcess> {
  const child = spawn(command, [...args], { cwd: fileURLToPath(cwdUri), env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] })
  if (!child.stdin || !child.stdout) return Promise.reject(new Error("mock process has no stdio"))
  if (child.stderr) void (async () => { for await (const bytes of child.stderr!) process.stderr.write(bytes) })()
  const wait = () => new Promise<{ readonly exitCode: number | null; readonly signal?: string }>(resolve => child.once("exit", (exitCode, signal) => resolve({ exitCode, ...(signal ? { signal } : {}) })))
  return Promise.resolve({ id: String(child.pid), stdout: child.stdout, stderr: child.stderr ?? (async function* () {})(), writeStdin: data => new Promise((resolve, reject) => child.stdin!.write(data, error => error ? reject(error) : resolve())), wait, stop: () => { child.kill("SIGKILL"); return Promise.resolve() } })
}

function command(commandId: string, commandValue: unknown) {
  return Schema.decodeUnknownSync(AgentCommandEnvelope)({ protocolVersion: 1, commandId, threadId: "thread", issuedAt: "2026-01-01T00:00:00.000Z", command: commandValue })
}

const root = fileURLToPath(new URL("../../../", import.meta.url))
const tsxLoader = `${root}node_modules/tsx/dist/loader.mjs`
const mock = `${root}apps/host-server/mocks/mock-line-rpc.ts`

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), 2_000)
      timer.unref()
    }),
  ])
}

describe("Codex app-server driver", () => {
  it("bounds semantic text without splitting emoji", () => {
    const bounded = truncateSemanticText("a".repeat(65_535) + "😀")
    assert.equal(new TextEncoder().encode(bounded).byteLength, 65_535)
    assert.equal(bounded.includes("�"), false)
  })
  it("closes its bounded queue on overflow", async () => {
    const queue = new AsyncQueue<string>()
    assert.equal(queue.push("x".repeat(AsyncQueue.maxBytes)), false)
    assert.equal(queue.didOverflow, true)
  })
  it("translates streaming assistant, tool, usage, and terminal events", async () => {
    try {
    const driver = new CodexAppServerDriver({ command: process.execPath, args: ["--import", tsxLoader, mock] })
    const connection = await within(driver.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" }), "open tool thread")
    const envelope = command("tool-command", { type: "turn.submit", input: [{ type: "text", text: "tool" }] })
    assert.equal((await connection.send(envelope)).status, "accepted")
    assert.equal((await connection.send(envelope)).status, "already-applied")
    const iterator = connection.events()[Symbol.asyncIterator]()
    const types: string[] = []
    for (let i = 0; i < 7; i += 1) { const next = await iterator.next(); if (!next.done) types.push(next.value.event.type) }
    assert.deepEqual(types, ["turn.started", "item.started", "item.started", "item.completed", "item.started", "item.delta", "usage.updated"])
    await connection.close("user")
    } catch (error) { throw error }
  })

  it("returns the exact permission option through the native request id", async () => {
    try {
    const driver = new CodexAppServerDriver({ command: process.execPath, args: ["--import", tsxLoader, mock] })
    const connection = await within(driver.openThread(context(), { mode: { type: "new" }, cwdUri: "file:///tmp" }), "open permission thread")
    await within(connection.send(command("permission-command", { type: "turn.submit", input: [{ type: "text", text: "request permission" }] })), "submit permission turn")
    const iterator = connection.events()[Symbol.asyncIterator]()
    let action: IteratorResult<import("@yaade/agent-protocol").UnsequencedAgentEvent> | null = null
    for (let index = 0; index < 3; index += 1) { const next = await within(iterator.next(), `permission event ${index}`); if (!next.done && next.value.event.type === "action.requested") { action = next; break } }
    if (!action || action.done || action.value.event.type !== "action.requested") throw new Error("missing permission action")
    const permission = action.value.event.action
    assert.equal(permission.type, "permission")
    if (permission.type !== "permission") throw new Error("wrong pending action")
    assert.equal(permission.options[0]?.id, "allow-once")
    assert.equal((await within(connection.send(command("approval", { type: "action.respond", actionId: permission.id, response: { type: "permission", optionId: "allow-once" } })), "permission response")).status, "accepted")
    const emitted: string[] = []
    for (let index = 0; index < 4; index += 1) { const next = await within(iterator.next(), `post-permission event ${index}`); if (!next.done) emitted.push(next.value.event.type) }
    assert.deepEqual(emitted, ["action.resolved", "item.started", "item.delta", "item.completed"])
    await connection.close("user")
    } catch (error) { throw error }
  })
})
