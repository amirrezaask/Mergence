import assert from "node:assert/strict"
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { MockAgentDriver, simpleStreamScenario } from "@yaade/agent-driver-mock"
import type {
  AgentDriver,
  AgentDriverContext,
  AgentDriverDetectionContext,
  AgentThreadConnection,
  OpenAgentThreadRequest,
} from "@yaade/agent-driver"
import {
  AgentCommandEnvelope,
  AgentConnectionId,
  AgentDriverDescriptor,
  DriverId,
  ProviderId,
  ProviderSessionId,
  AgentCapabilities,
  unsupportedAgentCapabilities,
  type AgentCommandResult,
} from "@yaade/agent-protocol"
import { Schema } from "effect"
import { ensureAgentThreadSchema } from "./schema.js"
import { AgentThreadRuntime } from "./runtime.js"
import {
  deleteAgentAttachmentsForThread,
  pruneAgentAttachments,
  readAgentAttachment,
  resolveAgentAttachment,
  storeAgentAttachment,
} from "./attachments.js"

function context(): any {
  return {
    workspace: { rootUri: "file:///tmp", additionalRoots: [], assertAllowed: async () => {} },
    filesystem: { readFile: async () => new Uint8Array(), writeFile: async () => {}, stat: async () => ({ size: 0 }) },
    terminal: { open: async () => ({ id: "test", write: async () => {}, close: async () => {} }) },
    processSpawner: { spawn: async () => { throw new Error("unused") } },
    commands: { resolveExecutable: async (candidates: ReadonlyArray<string>) => candidates[0], probe: async () => ({ exitCode: 0, output: "mock" }) },
    attachments: {
      resolve: async () => { throw new Error("unused") },
      read: async () => { throw new Error("unused") },
    },
    credentials: { get: async () => undefined }, mcp: { listServers: async () => [] },
    clock: {
      now: () => new Date(),
      sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    }, logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
  }
}

test("interactive runtime persists before publishing and rebuilds an identical snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaade-agent-runtime-"))
  const file = join(dir, "t.sqlite")
  const db = new DatabaseSync(file)
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)")
  ensureAgentThreadSchema(db)
  const published: string[] = []
  const persistedSnapshotSequences: number[] = []
  const runtime = new AgentThreadRuntime({ db, drivers: [new MockAgentDriver(simpleStreamScenario)], context: context(), publish: event => {
    assert.ok(db.prepare("SELECT 1 FROM agent_thread_events WHERE event_id=?").get(event.eventId))
    published.push(event.event.type)
    const row = db.prepare("SELECT snapshot_sequence FROM agent_threads WHERE thread_id=?")
      .get(event.threadId) as { snapshot_sequence: number }
    persistedSnapshotSequences.push(row.snapshot_sequence)
  } })
  const opened = await runtime.create({ threadId: "thread-1", projectSessionId: "ses-1", driverId: "mock:canonical", cwdUri: "file:///tmp" })
  assert.equal(runtime.getConnectionState("thread-1").status, "connected")
  const command = Schema.decodeUnknownSync(AgentCommandEnvelope)({ protocolVersion: 1, commandId: "cmd-1", threadId: "thread-1", issuedAt: new Date().toISOString(), command: { type: "turn.submit", input: [{ type: "text", text: "hello" }] } })
  assert.equal((await runtime.sendCommand(command)).status, "accepted")
  await new Promise(resolve => setTimeout(resolve, 0))
  const snapshot = runtime.getSnapshot("thread-1")
  assert.equal(snapshot?.state.status, "idle")
  const item = snapshot?.state.itemsById["mock-item-1"]
  assert.equal(item?.type, "assistant-message")
  if (item?.type === "assistant-message") assert.equal(item.text, "Hello from mock.")
  assert.ok(published.includes("thread.opened"))
  assert.equal(
    runtime.listEvents("thread-1").filter(event => event.event.type === "item.delta").length,
    1,
  )
  assert.ok(persistedSnapshotSequences.some((sequence, index) => sequence < index + 1))
  await runtime.shutdown()
  assert.equal(runtime.getConnectionState("thread-1").status, "disconnected")
  const stopped = runtime.getSnapshot("thread-1")
  db.close()
  const reopened = new DatabaseSync(file)
  ensureAgentThreadSchema(reopened)
  const restored = new AgentThreadRuntime({ db: reopened, drivers: [], context: context() }).getSnapshot("thread-1")
  assert.deepEqual(restored, stopped)
  reopened.close()
  rmSync(dir, { recursive: true, force: true })
})

test("attachments are bounded, thread-scoped, and stored outside browser control", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaade-agent-attachment-"))
  const db = new DatabaseSync(join(dir, "t.sqlite"))
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)")
  ensureAgentThreadSchema(db)
  const runtime = new AgentThreadRuntime({
    db,
    drivers: [new MockAgentDriver(simpleStreamScenario)],
    context: context(),
  })
  await runtime.create({
    threadId: "thread-attachment",
    projectSessionId: "ses-1",
    driverId: "mock:canonical",
    cwdUri: "file:///tmp",
  })
  const uploaded = await storeAgentAttachment(db, dir, {
    threadId: "thread-attachment",
    name: "../context.md",
    mediaType: "text/markdown",
    contentBase64: Buffer.from("# safe context").toString("base64"),
  })
  assert.equal(uploaded.name, "context.md")
  const resolved = await resolveAgentAttachment(db, dir, "thread-attachment", uploaded.id)
  assert.equal(resolved.size, 14)
  assert.equal(resolved.source.type, "temporary-upload")
  assert.equal(
    new TextDecoder().decode(await readAgentAttachment(db, dir, "thread-attachment", uploaded.id)),
    "# safe context",
  )
  await assert.rejects(
    resolveAgentAttachment(db, dir, "another-thread", uploaded.id),
    /unknown agent attachment/,
  )
  await assert.rejects(
    storeAgentAttachment(db, dir, {
      threadId: "thread-attachment",
      name: "payload.exe",
      mediaType: "application/octet-stream",
      contentBase64: "AA==",
    }),
    /unsupported agent attachment type/,
  )
  if (resolved.source.type !== "temporary-upload") throw new Error("temporary upload missing")
  const replacement = join(dir, "replacement.md")
  writeFileSync(replacement, "# host secret!")
  unlinkSync(resolved.source.storageKey)
  symlinkSync(replacement, resolved.source.storageKey)
  await assert.rejects(
    readAgentAttachment(db, dir, "thread-attachment", uploaded.id),
  )
  await runtime.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test("native event ids dedupe per thread and migrate legacy global ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "yaade-agent-event-id-"))
  const db = new DatabaseSync(join(dir, "t.sqlite"))
  db.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
    CREATE TABLE agent_threads (
      thread_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL,
      snapshot_sequence INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_thread_events (
      thread_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
      envelope_json TEXT NOT NULL, PRIMARY KEY(thread_id, sequence)
    ) WITHOUT ROWID;
    INSERT INTO agent_threads VALUES('thread-a', '{}', 0, '2026-01-01T00:00:00.000Z');
    INSERT INTO agent_threads VALUES('thread-b', '{}', 0, '2026-01-01T00:00:00.000Z');
    INSERT INTO agent_thread_events VALUES('thread-a', 1, 'native-1', '{}');
  `)
  ensureAgentThreadSchema(db)
  db.prepare("INSERT INTO agent_thread_events VALUES(?,?,?,?)")
    .run("thread-b", 1, "native-1", "{}")
  assert.throws(
    () => db.prepare("INSERT INTO agent_thread_events VALUES(?,?,?,?)")
      .run("thread-a", 2, "native-1", "{}"),
    /UNIQUE constraint failed/,
  )
  const count = db.prepare("SELECT COUNT(*) AS n FROM agent_thread_events WHERE event_id=?")
    .get("native-1") as { n: number }
  assert.equal(count.n, 2)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

class BlockingConnection implements AgentThreadConnection {
  readonly binding = {
    connectionId: Schema.decodeUnknownSync(AgentConnectionId)("blocking-connection"),
  }
  readonly capabilities = unsupportedAgentCapabilities()
  calls = 0
  private releaseSend: (() => void) | undefined
  private readonly sendGate = new Promise<void>(resolve => { this.releaseSend = resolve })

  async send(command: Schema.Schema.Type<typeof AgentCommandEnvelope>): Promise<AgentCommandResult> {
    this.calls += 1
    await this.sendGate
    return { status: "accepted", commandId: command.commandId }
  }

  async *events(signal?: AbortSignal) {
    if (signal?.aborted) return
    await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }))
  }

  close(): Promise<void> {
    this.releaseSend?.()
    return Promise.resolve()
  }

  release(): void { this.releaseSend?.() }
}

class BlockingDriver implements AgentDriver {
  readonly descriptor = AgentDriverDescriptor.make({
    id: Schema.decodeUnknownSync(DriverId)("blocking:test"),
    providerId: Schema.decodeUnknownSync(ProviderId)("blocking"),
    name: "Blocking test driver",
    integration: "mock",
    priority: 1,
    supportsRemoteHost: true,
  })
  readonly connection = new BlockingConnection()
  detect(_context: AgentDriverDetectionContext) { return Promise.resolve({ available: true }) }
  openThread(_context: AgentDriverContext, _request: OpenAgentThreadRequest) {
    return Promise.resolve(this.connection)
  }
}

class ResumableConnection implements AgentThreadConnection {
  readonly binding = {
    connectionId: Schema.decodeUnknownSync(AgentConnectionId)(`resume-connection-${crypto.randomUUID()}`),
    providerSessionId: Schema.decodeUnknownSync(ProviderSessionId)("provider-session-resume"),
  }
  readonly capabilities = AgentCapabilities.make({
    ...unsupportedAgentCapabilities(),
    input: { ...unsupportedAgentCapabilities().input, text: "native" },
    threads: { ...unsupportedAgentCapabilities().threads, resume: "native" },
  })
  send(command: Schema.Schema.Type<typeof AgentCommandEnvelope>): Promise<AgentCommandResult> {
    return Promise.resolve({ status: "accepted", commandId: command.commandId })
  }
  async *events(signal?: AbortSignal) {
    if (signal?.aborted) return
    await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }))
  }
  close(): Promise<void> { return Promise.resolve() }
}

class ResumableDriver implements AgentDriver {
  readonly descriptor = AgentDriverDescriptor.make({
    id: Schema.decodeUnknownSync(DriverId)("resume:test"),
    providerId: Schema.decodeUnknownSync(ProviderId)("resume"),
    name: "Resume test driver",
    integration: "mock",
    priority: 1,
    supportsRemoteHost: true,
  })
  readonly modes: OpenAgentThreadRequest["mode"][] = []
  detect(_context: AgentDriverDetectionContext) { return Promise.resolve({ available: true }) }
  openThread(_context: AgentDriverContext, request: OpenAgentThreadRequest) {
    this.modes.push(request.mode)
    return Promise.resolve(new ResumableConnection())
  }
}

class ReconnectingDriver implements AgentDriver {
  readonly descriptor = AgentDriverDescriptor.make({
    id: Schema.decodeUnknownSync(DriverId)("reconnecting:test"),
    providerId: Schema.decodeUnknownSync(ProviderId)("reconnecting"),
    name: "Reconnecting test driver",
    integration: "mock",
    priority: 1,
    supportsRemoteHost: true,
  })
  opens = 0

  detect(_context: AgentDriverDetectionContext) { return Promise.resolve({ available: true }) }
  openThread(_context: AgentDriverContext, _request: OpenAgentThreadRequest): Promise<AgentThreadConnection> {
    this.opens += 1
    const opens = this.opens
    return Promise.resolve({
      binding: {
        connectionId: Schema.decodeUnknownSync(AgentConnectionId)(`reconnecting-${opens}`),
      },
      capabilities: unsupportedAgentCapabilities(),
      send: command => Promise.resolve({ status: "accepted", commandId: command.commandId }),
      events: async function* (signal?: AbortSignal) {
        if (opens === 1 || signal?.aborted) return
        await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }))
      },
      close: () => Promise.resolve(),
    })
  }
}

class DelayedRestoreDriver implements AgentDriver {
  readonly descriptor = AgentDriverDescriptor.make({
    id: Schema.decodeUnknownSync(DriverId)("resume:test"),
    providerId: Schema.decodeUnknownSync(ProviderId)("resume"),
    name: "Delayed restore test driver",
    integration: "mock",
    priority: 1,
    supportsRemoteHost: true,
  })
  opens = 0
  closes = 0
  signal: AbortSignal | undefined
  private resolveOpen: ((connection: AgentThreadConnection) => void) | undefined

  detect(_context: AgentDriverDetectionContext) { return Promise.resolve({ available: true }) }
  openThread(context: AgentDriverContext): Promise<AgentThreadConnection> {
    this.opens += 1
    this.signal = context.signal
    return new Promise(resolve => { this.resolveOpen = resolve })
  }
  release(): void {
    this.resolveOpen?.({
      binding: {
        connectionId: Schema.decodeUnknownSync(AgentConnectionId)(`delayed-${this.opens}`),
        providerSessionId: Schema.decodeUnknownSync(ProviderSessionId)("provider-session-resume"),
      },
      capabilities: unsupportedAgentCapabilities(),
      send: command => Promise.resolve({ status: "accepted", commandId: command.commandId }),
      events: async function* (signal?: AbortSignal) {
        if (signal?.aborted) return
        await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }))
      },
      close: async () => { this.closes += 1 },
    })
  }
}

class TransientRestoreDriver extends ResumableDriver {
  opens = 0
  override openThread(context: AgentDriverContext, request: OpenAgentThreadRequest) {
    this.opens += 1
    if (this.opens === 1) return Promise.reject(new Error("temporarily unavailable"))
    return super.openThread(context, request)
  }
}

class NonResumableDriver extends ResumableDriver {
  opens = 0
  override openThread(_context: AgentDriverContext, _request: OpenAgentThreadRequest) {
    this.opens += 1
    return Promise.resolve({
      binding: {
        connectionId: Schema.decodeUnknownSync(AgentConnectionId)(`non-resumable-${this.opens}`),
        providerSessionId: Schema.decodeUnknownSync(ProviderSessionId)("provider-session-no-resume"),
      },
      capabilities: unsupportedAgentCapabilities(),
      send: (command: Schema.Schema.Type<typeof AgentCommandEnvelope>) =>
        Promise.resolve({ status: "accepted" as const, commandId: command.commandId }),
      events: async function* (signal?: AbortSignal) {
        if (signal?.aborted) return
        await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }))
      },
      close: () => Promise.resolve(),
    })
  }
}

class FailingOpenDriver extends ResumableDriver {
  signal: AbortSignal | undefined
  override openThread(context: AgentDriverContext) {
    this.signal = context.signal
    return Promise.reject(new Error("open failed after allocating resources"))
  }
}

async function seedOpenThread(file: string, threadId: string): Promise<void> {
  const db = new DatabaseSync(file)
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)")
  ensureAgentThreadSchema(db)
  const runtime = new AgentThreadRuntime({ db, drivers: [new ResumableDriver()], context: context() })
  await runtime.create({
    threadId,
    projectSessionId: "ses-1",
    driverId: "resume:test",
    cwdUri: "file:///tmp",
  })
  await runtime.shutdown()
  db.close()
}

test("command is durably claimed before provider dispatch and duplicate retries never re-dispatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaade-agent-command-ledger-"))
  const db = new DatabaseSync(join(dir, "t.sqlite"))
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)")
  ensureAgentThreadSchema(db)
  const driver = new BlockingDriver()
  const runtime = new AgentThreadRuntime({ db, drivers: [driver], context: context() })
  await runtime.create({
    threadId: "thread-ledger",
    projectSessionId: "ses-1",
    driverId: "blocking:test",
    cwdUri: "file:///tmp",
  })
  const command = Schema.decodeUnknownSync(AgentCommandEnvelope)({
    protocolVersion: 1,
    commandId: "command-ledger-1",
    threadId: "thread-ledger",
    issuedAt: new Date().toISOString(),
    command: { type: "turn.submit", input: [{ type: "text", text: "once" }] },
  })
  const first = runtime.sendCommand(command)
  await waitUntil(() => db.prepare(
    "SELECT state FROM agent_thread_commands WHERE thread_id=? AND command_id=?",
  ).get("thread-ledger", "command-ledger-1") !== undefined)
  const duplicate = await runtime.sendCommand(command)
  assert.equal(duplicate.status, "rejected")
  if (duplicate.status === "rejected") assert.equal(duplicate.error.code, "agent.command-outcome-unknown")
  assert.equal(driver.connection.calls, 1)
  driver.connection.release()
  assert.equal((await first).status, "accepted")
  assert.equal((await runtime.sendCommand(command)).status, "already-applied")
  assert.equal(driver.connection.calls, 1)
  await runtime.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test("a failed new-thread open aborts its driver context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaade-agent-open-failure-"))
  const db = new DatabaseSync(join(dir, "t.sqlite"))
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)")
  ensureAgentThreadSchema(db)
  const driver = new FailingOpenDriver()
  const runtime = new AgentThreadRuntime({ db, drivers: [driver], context: context() })
  await assert.rejects(
    runtime.create({
      threadId: "thread-open-failure",
      projectSessionId: "ses-1",
      driverId: "resume:test",
      cwdUri: "file:///tmp",
    }),
    /open failed after allocating resources/,
  )
  assert.equal(driver.signal?.aborted, true)
  await runtime.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test("host restart resumes the same provider binding and reports unavailable drivers without losing state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaade-agent-resume-"))
  const file = join(dir, "t.sqlite")
  const firstDb = new DatabaseSync(file)
  firstDb.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)")
  ensureAgentThreadSchema(firstDb)
  const firstDriver = new ResumableDriver()
  const first = new AgentThreadRuntime({ db: firstDb, drivers: [firstDriver], context: context() })
  const created = await first.create({
    threadId: "thread-resume",
    projectSessionId: "ses-1",
    driverId: "resume:test",
    cwdUri: "file:///tmp",
  })
  assert.equal(created.state.providerSessionId, "provider-session-resume")
  await first.shutdown()
  firstDb.close()

  const secondDb = new DatabaseSync(file)
  ensureAgentThreadSchema(secondDb)
  const secondDriver = new ResumableDriver()
  const second = new AgentThreadRuntime({ db: secondDb, drivers: [secondDriver], context: context() })
  await second.restore()
  assert.deepEqual(secondDriver.modes, [{
    type: "resume",
    providerSessionId: "provider-session-resume",
  }])
  assert.equal(second.getConnectionState("thread-resume").status, "connected")
  await second.shutdown()
  secondDb.close()

  const unavailableDb = new DatabaseSync(file)
  ensureAgentThreadSchema(unavailableDb)
  const unavailable = new AgentThreadRuntime({ db: unavailableDb, drivers: [], context: context() })
  await unavailable.restore()
  assert.equal(unavailable.getConnectionState("thread-resume").status, "unavailable")
  assert.ok(unavailable.getSnapshot("thread-resume"))
  unavailableDb.close()
  rmSync(dir, { recursive: true, force: true })
})

test("host restart preserves a non-resumable provider thread as unavailable without reopening it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaade-agent-no-resume-"))
  const file = join(dir, "t.sqlite")
  const firstDb = new DatabaseSync(file)
  firstDb.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)")
  ensureAgentThreadSchema(firstDb)
  const first = new AgentThreadRuntime({ db: firstDb, drivers: [new NonResumableDriver()], context: context() })
  await first.create({ threadId: "thread-no-resume", projectSessionId: "ses-1", driverId: "resume:test", cwdUri: "file:///tmp" })
  await first.shutdown()
  firstDb.close()

  const secondDb = new DatabaseSync(file)
  ensureAgentThreadSchema(secondDb)
  const driver = new NonResumableDriver()
  const second = new AgentThreadRuntime({ db: secondDb, drivers: [driver], context: context(), reconnectDelayMs: () => 60_000 })
  await second.restore()
  assert.equal(driver.opens, 0)
  assert.equal(second.getConnectionState("thread-no-resume").status, "unavailable")
  assert.ok(second.getSnapshot("thread-no-resume"))
  await second.shutdown()
  secondDb.close()
  rmSync(dir, { recursive: true, force: true })
})

test("a pending command recovered after a host crash is never re-dispatched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaade-agent-command-crash-"))
  const file = join(dir, "t.sqlite")
  const db = new DatabaseSync(file)
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)")
  ensureAgentThreadSchema(db)
  const runtime = new AgentThreadRuntime({ db, drivers: [new MockAgentDriver(simpleStreamScenario)], context: context() })
  await runtime.create({ threadId: "thread-crash", projectSessionId: "ses-1", driverId: "mock:canonical", cwdUri: "file:///tmp" })
  const command = Schema.decodeUnknownSync(AgentCommandEnvelope)({
    protocolVersion: 1, commandId: "cmd-crash", threadId: "thread-crash", issuedAt: new Date().toISOString(),
    command: { type: "turn.submit", input: [{ type: "text", text: "do not retry" }] },
  })
  db.prepare(`INSERT INTO agent_thread_commands(thread_id, command_id, result_json, state, command_json, created_at)
    VALUES(?,?,?,'pending',?,?)`).run("thread-crash", "cmd-crash", "null", JSON.stringify(command), new Date().toISOString())
  const result = await runtime.sendCommand(command)
  assert.equal(result.status, "rejected")
  if (result.status === "rejected") assert.equal(result.error.code, "agent.command-outcome-unknown")
  assert.equal(runtime.listEvents("thread-crash").filter(event => event.commandId === "cmd-crash").length, 0)
  await runtime.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test("a clean provider stream end publishes disconnect state and reconnects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaade-agent-reconnect-"))
  const db = new DatabaseSync(join(dir, "t.sqlite"))
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)")
  ensureAgentThreadSchema(db)
  const driver = new ReconnectingDriver()
  const states: string[] = []
  const runtime = new AgentThreadRuntime({
    db,
    drivers: [driver],
    context: context(),
    reconnectDelayMs: () => 0,
    publishConnection: (_threadId, state) => states.push(state.status),
  })
  await runtime.create({
    threadId: "thread-reconnect",
    projectSessionId: "ses-1",
    driverId: "reconnecting:test",
    cwdUri: "file:///tmp",
  })
  await waitUntil(() => driver.opens === 2 && runtime.getConnectionState("thread-reconnect").status === "connected")
  assert.ok(states.includes("disconnected"))
  assert.deepEqual(states.slice(-3), ["disconnected", "connecting", "connected"])
  await runtime.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

for (const action of ["close", "delete", "shutdown"] as const) {
  test(`${action} cancels an in-flight restore and closes its stale late result`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `yaade-agent-cancel-${action}-`))
    const file = join(dir, "t.sqlite")
    const threadId = `thread-cancel-${action}`
    await seedOpenThread(file, threadId)
    const db = new DatabaseSync(file)
    ensureAgentThreadSchema(db)
    const driver = new DelayedRestoreDriver()
    const runtime = new AgentThreadRuntime({
      db,
      drivers: [driver],
      context: context(),
      reconnectDelayMs: () => 0,
    })
    const restoring = runtime.restore()
    await waitUntil(() => driver.opens === 1)

    if (action === "close") await runtime.close(threadId)
    else if (action === "delete") await runtime.delete(threadId)
    else await runtime.shutdown()

    assert.equal(driver.signal?.aborted, true)
    driver.release()
    await restoring
    await waitUntil(() => driver.closes === 1)
    assert.notEqual(runtime.getConnectionState(threadId).status, "connected")
    if (action === "delete") assert.equal(runtime.getSnapshot(threadId), null)
    if (action !== "shutdown") await runtime.shutdown()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
}

test("a transient restore failure enters the bounded reconnect loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaade-agent-restore-retry-"))
  const file = join(dir, "t.sqlite")
  await seedOpenThread(file, "thread-restore-retry")
  const db = new DatabaseSync(file)
  ensureAgentThreadSchema(db)
  const driver = new TransientRestoreDriver()
  const states: string[] = []
  const runtime = new AgentThreadRuntime({
    db,
    drivers: [driver],
    context: context(),
    reconnectDelayMs: () => 0,
    publishConnection: (_threadId, state) => states.push(state.status),
  })
  await runtime.restore()
  await waitUntil(() => driver.opens === 2)
  assert.equal(runtime.getConnectionState("thread-restore-retry").status, "connected")
  assert.ok(states.includes("unavailable"))
  assert.deepEqual(states.slice(-2), ["connecting", "connected"])
  await runtime.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  throw new Error("condition was not reached")
}

test("attachment cleanup is thread-scoped, bounded, and tolerates missing files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaade-agent-attachment-cleanup-"))
  const db = new DatabaseSync(join(dir, "t.sqlite"))
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)")
  ensureAgentThreadSchema(db)
  const runtime = new AgentThreadRuntime({
    db,
    drivers: [new MockAgentDriver(simpleStreamScenario)],
    context: context(),
  })
  await runtime.create({
    threadId: "thread-cleanup-a",
    projectSessionId: "ses-1",
    driverId: "mock:canonical",
    cwdUri: "file:///tmp",
  })
  await runtime.create({
    threadId: "thread-cleanup-b",
    projectSessionId: "ses-1",
    driverId: "mock:canonical",
    cwdUri: "file:///tmp",
  })
  const old = await storeAgentAttachment(db, dir, {
    threadId: "thread-cleanup-a",
    name: "old.txt",
    mediaType: "text/plain",
    contentBase64: Buffer.from("old").toString("base64"),
  })
  const current = await storeAgentAttachment(db, dir, {
    threadId: "thread-cleanup-a",
    name: "current.txt",
    mediaType: "text/plain",
    contentBase64: Buffer.from("current").toString("base64"),
  })
  const other = await storeAgentAttachment(db, dir, {
    threadId: "thread-cleanup-b",
    name: "other.txt",
    mediaType: "text/plain",
    contentBase64: Buffer.from("other").toString("base64"),
  })
  db.prepare("UPDATE agent_attachments SET created_at=? WHERE attachment_id=?")
    .run("2000-01-01T00:00:00.000Z", old.id)
  rmSync(join(dir, "agent-attachments", old.id))
  const pruned = await pruneAgentAttachments(db, dir, {
    now: new Date("2026-01-01T00:00:00.000Z"),
    maxAgeMs: 1,
    limit: 1,
  })
  assert.deepEqual(pruned, { deleted: 1, missingFiles: 1 })
  assert.equal(db.prepare("SELECT 1 FROM agent_attachments WHERE attachment_id=?").get(old.id), undefined)
  assert.ok(db.prepare("SELECT 1 FROM agent_attachments WHERE attachment_id=?").get(current.id))
  assert.ok(db.prepare("SELECT 1 FROM agent_attachments WHERE attachment_id=?").get(other.id))
  const deleted = await deleteAgentAttachmentsForThread(db, dir, "thread-cleanup-a")
  assert.deepEqual(deleted, { deleted: 1, missingFiles: 0 })
  await assert.rejects(resolveAgentAttachment(db, dir, "thread-cleanup-a", current.id), /unknown agent attachment/)
  await resolveAgentAttachment(db, dir, "thread-cleanup-b", other.id)
  await runtime.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
