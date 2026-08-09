import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type {
  AgentCommandResolver,
  AgentDriver,
  AgentDriverContext,
  AgentProcessSpawner,
  AgentSpawnedProcess,
} from "../packages/yaade-agent-driver/src/index.js"
import {
  AcpAgentDriver,
  cursorAcpProfile,
  grokAcpProfile,
  opencodeAcpProfile,
} from "../packages/yaade-agent-driver-acp/src/index.js"
import { ClaudeAgentSdkDriver } from "../packages/yaade-agent-driver-claude/src/index.js"
import { CodexAppServerDriver } from "../packages/yaade-agent-driver-codex/src/index.js"
import {
  MockAgentDriver,
  mockScenarios,
} from "../packages/yaade-agent-driver-mock/src/index.js"
import {
  AgentCommandEnvelope,
  AgentEventEnvelope,
  type AgentEventEnvelope as AgentEventEnvelopeType,
  type AgentThreadSnapshot,
} from "../packages/yaade-agent-protocol/src/index.js"
import { reduceAgentThreadEvent } from "../packages/yaade-agent-runtime/src/index.js"
import { Schema } from "effect"

const LIVE_SCENARIO_ID = "smoke"
const LIVE_PROMPT = "Reply with exactly YAADE_AGENT_SMOKE_OK. Do not use tools and do not modify files."
const LIVE_TIMEOUT_MS = 120_000
const SAFE_ENV_KEYS = [
  "HOME",
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
] as const

const nativeDrivers = (): ReadonlyArray<AgentDriver> => [
  new CodexAppServerDriver(),
  new ClaudeAgentSdkDriver(),
  new AcpAgentDriver(cursorAcpProfile()),
  new AcpAgentDriver(grokAcpProfile()),
  new AcpAgentDriver(opencodeAcpProfile()),
]

type Options = {
  readonly driver: string
  readonly scenarioId: string
  readonly live: boolean
  readonly probe: boolean
  readonly outPath?: string
  readonly cwd?: string
}

type ScenarioResult = {
  readonly manifest: {
    readonly scenarioId: string
    readonly driverId: string
    readonly providerId: string
    readonly live: boolean
  }
  readonly detection?: {
    readonly available: boolean
    readonly version?: string
    readonly reason?: string
  }
  readonly trace: ReadonlyArray<AgentEventEnvelopeType>
  readonly finalState: AgentThreadSnapshot["state"] | null
  readonly invariants: {
    readonly sequenceMonotonic: boolean
    readonly pendingActions: number
    readonly status: string
    readonly violations: ReadonlyArray<string>
    readonly expectedReply: boolean | null
  }
}

function usage(): string {
  const native = nativeDrivers().map(driver => driver.descriptor.id).join(", ")
  return [
    "Usage:",
    "  pnpm agent:scenario [scenario] [--out=trace.json]",
    "  pnpm agent:scenario -- --driver=cursor --probe",
    "  pnpm agent:scenario -- --driver=cursor --live [--cwd=/path]",
    "  pnpm agent:scenario -- --driver=all --probe",
    "",
    "Mock scenarios:",
    `  ${Object.keys(mockScenarios).join(", ")}`,
    "",
    "Native drivers:",
    `  ${native}`,
    "",
    "Native probes are read-only and free. --live submits one tiny, tool-free turn per selected driver.",
  ].join("\n")
}

function parseOptions(argv: ReadonlyArray<string>): Options {
  const args = argv.filter(value => value !== "--")
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`)
    process.exit(0)
  }
  const valueFor = (name: string): string | undefined =>
    args.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)
  const driver = valueFor("--driver") ?? "mock"
  const positional = args.find(value => !value.startsWith("-"))
  return {
    driver,
    scenarioId: positional ?? (driver === "mock" ? "simple-stream" : LIVE_SCENARIO_ID),
    live: args.includes("--live"),
    probe: args.includes("--probe"),
    ...(valueFor("--out") ? { outPath: valueFor("--out") } : {}),
    ...(valueFor("--cwd") ? { cwd: path.resolve(valueFor("--cwd") ?? "") } : {}),
  }
}

function selectedDrivers(id: string): ReadonlyArray<AgentDriver> {
  const drivers = nativeDrivers()
  if (id === "all") return drivers
  const aliases: Readonly<Record<string, string>> = {
    codex: "codex:app-server",
    claude: "claude:agent-sdk",
    cursor: "cursor:acp",
    grok: "grok:acp",
    opencode: "opencode:acp",
  }
  const driverId = aliases[id] ?? id
  const selected = drivers.find(driver => driver.descriptor.id === driverId)
  if (!selected) {
    throw new Error(`unknown native driver ${id}; choose ${drivers.map(driver => driver.descriptor.id).join(", ")}, or all`)
  }
  return [selected]
}

function safeEnvironment(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  return { ...environment, ...extra }
}

function resolveExecutable(candidates: ReadonlyArray<string>): Promise<string | undefined> {
  return (async () => {
    for (const command of candidates) {
      const paths = path.isAbsolute(command) || command.includes(path.sep)
        ? [command]
        : (process.env.PATH ?? "")
            .split(path.delimiter)
            .filter(Boolean)
            .map(root => path.join(root, command))
      for (const candidate of paths) {
        try {
          await access(candidate, constants.X_OK)
          return candidate
        } catch {
          // Try the next candidate.
        }
      }
    }
    return undefined
  })()
}

function commandResolver(cwd: string, signal: AbortSignal): AgentCommandResolver {
  return {
    resolveExecutable,
    async probe(command, args) {
      if (signal.aborted) throw new Error("aborted")
      return await new Promise((resolve, reject) => {
        const child = spawn(command, [...args], {
          cwd,
          env: safeEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
        })
        let output = ""
        let settled = false
        const finish = (result: { readonly exitCode: number | null; readonly output: string } | Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener("abort", abort)
          if (result instanceof Error) reject(result)
          else resolve(result)
        }
        const abort = (): void => {
          child.kill("SIGKILL")
          finish(new Error("aborted"))
        }
        const append = (chunk: Buffer): void => {
          output += chunk.toString("utf8")
          if (Buffer.byteLength(output) > 64 * 1024) {
            child.kill("SIGKILL")
            finish(new Error("probe output exceeded 65536 bytes"))
          }
        }
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          finish(new Error("probe timed out"))
        }, 5_000)
        timer.unref()
        child.stdout.on("data", append)
        child.stderr.on("data", append)
        child.once("error", finish)
        child.once("exit", exitCode => finish({ exitCode, output }))
        signal.addEventListener("abort", abort, { once: true })
      })
    },
  }
}

function processSpawner(signal: AbortSignal): AgentProcessSpawner {
  const children = new Set<ReturnType<typeof spawn>>()
  const stopAll = (): void => {
    for (const child of children) child.kill("SIGKILL")
    children.clear()
  }
  signal.addEventListener("abort", stopAll, { once: true })
  return {
    async spawn(options): Promise<AgentSpawnedProcess> {
      if (signal.aborted) throw new Error("scenario context is closed")
      const child = spawn(options.command, [...options.args], {
        cwd: fileURLToPath(options.cwdUri),
        env: safeEnvironment(options.env),
        stdio: ["pipe", "pipe", "pipe"],
      })
      if (!child.stdin || !child.stdout || !child.stderr) {
        throw new Error("native agent did not expose stdio")
      }
      children.add(child)
      const settled = new Promise<{ readonly exitCode: number | null; readonly signal?: string }>(resolve => {
        child.once("exit", (exitCode, exitSignal) => {
          children.delete(child)
          resolve({ exitCode, ...(exitSignal ? { signal: exitSignal } : {}) })
        })
      })
      let stderr = ""
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 16_384) stderr += chunk.toString("utf8")
      })
      child.once("error", error => {
        children.delete(child)
        if (stderr) error.message = `${error.message}: ${stderr.slice(-2_000)}`
      })
      return {
        id: `scenario-process:${child.pid ?? "unknown"}`,
        stdout: child.stdout,
        stderr: child.stderr,
        async writeStdin(data) {
          await new Promise<void>((resolve, reject) => {
            child.stdin.write(data, error => error ? reject(error) : resolve())
          })
        },
        wait: () => settled,
        async stop(graceMs) {
          if (child.exitCode !== null || child.signalCode !== null) return
          child.kill("SIGTERM")
          const exited = await Promise.race([
            settled.then(() => true),
            new Promise<false>(resolve => setTimeout(() => resolve(false), graceMs)),
          ])
          if (!exited) child.kill("SIGKILL")
        },
      }
    },
  }
}

function liveContext(cwd: string, controller: AbortController): AgentDriverContext {
  const rootUri = pathToFileURL(cwd).toString()
  const assertAllowed = async (uri: string): Promise<string> => {
    const candidate = path.resolve(fileURLToPath(uri))
    const relative = path.relative(cwd, candidate)
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`scenario path is outside ${cwd}`)
    }
    return candidate
  }
  return {
    workspace: {
      rootUri,
      additionalRoots: [],
      async assertAllowed(uri) { await assertAllowed(uri) },
    },
    filesystem: {
      async readFile(uri) { return readFile(await assertAllowed(uri)) },
      async writeFile() { throw new Error("file writes are disabled in the cheap live scenario") },
      async stat(uri) {
        const result = await stat(await assertAllowed(uri))
        return { size: result.size }
      },
    },
    terminal: { async open() { throw new Error("terminal use is disabled in the cheap live scenario") } },
    processSpawner: processSpawner(controller.signal),
    commands: commandResolver(cwd, controller.signal),
    attachments: {
      async resolve() { throw new Error("attachments are disabled in the cheap live scenario") },
      async read() { throw new Error("attachments are disabled in the cheap live scenario") },
    },
    credentials: { async get() { return undefined } },
    mcp: { async listServers() { return [] } },
    clock: {
      now: () => new Date(),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: controller.signal,
  }
}

function mockContext(): AgentDriverContext {
  const controller = new AbortController()
  return {
    workspace: { rootUri: "file:///tmp", additionalRoots: [], assertAllowed: async () => {} },
    filesystem: { readFile: async () => new Uint8Array(), writeFile: async () => {}, stat: async () => ({ size: 0 }) },
    terminal: { open: async () => { throw new Error("unused") } },
    processSpawner: { spawn: async () => { throw new Error("unused") } },
    commands: { resolveExecutable: async candidates => candidates[0], probe: async () => ({ exitCode: 0, output: "mock" }) },
    attachments: { resolve: async () => { throw new Error("unused") }, read: async () => { throw new Error("unused") } },
    credentials: { get: async () => undefined },
    mcp: { listServers: async () => [] },
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z"), sleep: async () => {} },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: controller.signal,
  }
}

function command(commandId: string, commandValue: unknown): AgentCommandEnvelope {
  return Schema.decodeUnknownSync(AgentCommandEnvelope)({
    protocolVersion: 1,
    commandId,
    threadId: "scenario-thread",
    issuedAt: new Date().toISOString(),
    command: commandValue,
  })
}

async function runScenario(input: {
  readonly driver: AgentDriver
  readonly context: AgentDriverContext
  readonly scenarioId: string
  readonly cwdUri: string
  readonly live: boolean
  readonly timeoutMs?: number
}): Promise<ScenarioResult> {
  const connection = await input.driver.openThread(input.context, {
    mode: { type: "new" },
    cwdUri: input.cwdUri,
  })
  const trace: AgentEventEnvelopeType[] = []
  const violations: string[] = []
  const seenEventIds = new Set<string>()
  let snapshot: AgentThreadSnapshot | undefined
  let sequence = 0
  const append = (raw: unknown, metadata?: {
    readonly nativeEventId?: string
    readonly providerCursor?: string
  }): void => {
    const eventId = metadata?.nativeEventId ?? `scenario-event-${sequence + 1}`
    if (seenEventIds.has(eventId)) return
    seenEventIds.add(eventId)
    const envelope = Schema.decodeUnknownSync(AgentEventEnvelope)({
      protocolVersion: 1,
      eventId,
      threadId: "scenario-thread",
      sequence: ++sequence,
      occurredAt: "2026-01-01T00:00:00.000Z",
      receivedAt: "2026-01-01T00:00:00.000Z",
      connectionGeneration: 1,
      ...(metadata?.providerCursor ? { providerCursor: metadata.providerCursor } : {}),
      event: raw,
    })
    const reduced = reduceAgentThreadEvent(snapshot, envelope)
    if (reduced.status === "rejected") {
      violations.push(...reduced.violations.map(violation => violation.code))
      seenEventIds.delete(eventId)
      sequence -= 1
      return
    }
    if (!reduced.snapshot) throw new Error(`scenario produced no snapshot at ${sequence}`)
    snapshot = reduced.snapshot
    trace.push(envelope)
  }

  append({
    type: "thread.opened",
    projectSessionId: "scenario-session",
    providerId: input.driver.descriptor.providerId,
    driverId: input.driver.descriptor.id,
    ...(connection.binding.providerSessionId
      ? { providerSessionId: connection.binding.providerSessionId }
      : {}),
    cwdUri: input.cwdUri,
    capabilities: connection.capabilities,
    configuration: connection.configuration ?? [],
  })

  const eventsController = new AbortController()
  let terminalResolve: (() => void) | undefined
  let terminalReject: ((error: Error) => void) | undefined
  const terminal = new Promise<void>((resolve, reject) => {
    terminalResolve = resolve
    terminalReject = reject
  })
  const timer = input.timeoutMs
    ? setTimeout(() => {
        eventsController.abort()
        terminalReject?.(new Error(`scenario timed out after ${input.timeoutMs} ms`))
      }, input.timeoutMs)
    : undefined
  timer?.unref()
  const pump = (async () => {
    try {
      for await (const raw of connection.events(eventsController.signal)) {
        append(raw.event, {
          ...(raw.nativeEventId ? { nativeEventId: raw.nativeEventId } : {}),
          ...(raw.providerCursor ? { providerCursor: raw.providerCursor } : {}),
        })
        if (raw.event.type === "action.requested") {
          const action = raw.event.action
          const response = action.type === "permission"
            ? {
                type: "permission" as const,
                optionId: input.live
                  ? action.options.find(option => option.decision.startsWith("reject"))?.id ?? action.options[0]?.id ?? ""
                  : action.options.find(option => option.decision.startsWith("allow"))?.id ?? action.options[0]?.id ?? "",
              }
            : action.type === "authentication"
              ? {
                  type: "authentication" as const,
                  status: input.live ? "cancelled" as const : "completed" as const,
                }
              : { type: "elicitation" as const, values: {} }
          const result = await connection.send(command("scenario-action", {
            type: "action.respond",
            actionId: action.id,
            response,
          }))
          if (result.status === "rejected") throw new Error(result.error.message)
        }
        if (input.scenarioId === "interrupt" && raw.event.type === "item.delta") {
          const result = await connection.send(command("scenario-interrupt", {
            type: "turn.interrupt",
            turnId: "mock-turn-1",
          }))
          if (result.status === "rejected") throw new Error(result.error.message)
        }
        if (
          raw.event.type === "turn.completed" ||
          raw.event.type === "turn.failed" ||
          raw.event.type === "turn.interrupted"
        ) {
          terminalResolve?.()
          break
        }
      }
    } catch (error) {
      if (!eventsController.signal.aborted) {
        terminalReject?.(error instanceof Error ? error : new Error(String(error)))
      }
    }
  })()

  try {
    if (input.scenarioId === "configuration-change" || input.scenarioId === "configuration-rejection") {
      const result = await connection.send(command("scenario-configuration", {
        type: "configuration.set",
        optionId: "model",
        value: "mock-deep",
      }))
      if (result.status === "rejected") throw new Error(result.error.message)
    }
    const scenarioInput = input.scenarioId === "attachments"
      ? [{ type: "attachment" as const, attachmentId: "scenario-attachment", purpose: "context" as const }]
      : [{ type: "text" as const, text: input.live ? LIVE_PROMPT : input.scenarioId }]
    const result = await connection.send(command("scenario-submit", {
      type: "turn.submit",
      input: scenarioInput,
    }))
    if (result.status === "rejected") throw new Error(result.error.message)
    await terminal
  } finally {
    if (timer) clearTimeout(timer)
    eventsController.abort()
    await connection.close("user")
    await pump
  }

  return {
    manifest: {
      scenarioId: input.scenarioId,
      driverId: input.driver.descriptor.id,
      providerId: input.driver.descriptor.providerId,
      live: input.live,
    },
    trace,
    finalState: snapshot?.state ?? null,
    invariants: {
      sequenceMonotonic: trace.every((event, index) => event.sequence === index + 1),
      pendingActions: snapshot?.state.pendingActions.length ?? 0,
      status: snapshot?.state.status ?? "missing",
      violations,
      expectedReply: input.live
        ? Object.values(snapshot?.state.itemsById ?? {}).some(item =>
            item.type === "assistant-message" && item.text.trim() === "YAADE_AGENT_SMOKE_OK",
          )
        : null,
    },
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  if (options.driver === "mock") {
    const scenario = mockScenarios[options.scenarioId]
    if (!scenario) {
      throw new Error(`unknown scenario ${options.scenarioId}; choose ${Object.keys(mockScenarios).join(", ")}`)
    }
    const result = await runScenario({
      driver: new MockAgentDriver(scenario),
      context: mockContext(),
      scenarioId: options.scenarioId,
      cwdUri: "file:///tmp",
      live: false,
    })
    const json = `${JSON.stringify(result, null, 2)}\n`
    if (options.outPath) await writeFile(options.outPath, json, "utf8")
    process.stdout.write(json)
    return
  }

  if (options.scenarioId !== LIVE_SCENARIO_ID) {
    throw new Error(`native drivers currently support the ${LIVE_SCENARIO_ID} scenario only`)
  }
  if (!options.probe && !options.live) {
    throw new Error("native scenarios require --probe (free) or --live (one provider turn)")
  }
  const temporaryWorkspace = options.live && !options.cwd
    ? await mkdtemp(path.join(os.tmpdir(), "yaade-agent-scenario-"))
    : undefined
  const cwd = options.cwd ?? temporaryWorkspace ?? process.cwd()
  if (temporaryWorkspace) {
    await writeFile(path.join(temporaryWorkspace, "README.md"), "# YAADE native-agent smoke workspace\n", "utf8")
  }
  const results: ScenarioResult[] = []
  try {
    for (const driver of selectedDrivers(options.driver)) {
      const controller = new AbortController()
      const context = liveContext(cwd, controller)
      const detection = await driver.detect({
        cwdUri: context.workspace.rootUri,
        signal: controller.signal,
        commands: context.commands,
      })
      if (!options.live || !detection.available) {
        results.push({
          manifest: {
            scenarioId: options.scenarioId,
            driverId: driver.descriptor.id,
            providerId: driver.descriptor.providerId,
            live: false,
          },
          detection,
          trace: [],
          finalState: null,
          invariants: {
            sequenceMonotonic: true,
            pendingActions: 0,
            status: detection.available ? "available" : "unavailable",
            violations: [],
            expectedReply: null,
          },
        })
        controller.abort()
        continue
      }
      process.stderr.write(`Running one live, tool-free turn against ${driver.descriptor.name}; provider usage may apply.\n`)
      try {
        const result = await runScenario({
          driver,
          context,
          scenarioId: options.scenarioId,
          cwdUri: context.workspace.rootUri,
          live: true,
          timeoutMs: LIVE_TIMEOUT_MS,
        })
        results.push({ ...result, detection })
      } finally {
        controller.abort()
      }
    }
  } finally {
    if (temporaryWorkspace) await rm(temporaryWorkspace, { recursive: true, force: true })
  }
  const output = results.length === 1 ? results[0] : results
  const json = `${JSON.stringify(output, null, 2)}\n`
  if (options.outPath) await writeFile(options.outPath, json, "utf8")
  process.stdout.write(json)
  const failed = results.some(result =>
    result.detection?.available === false ||
    result.invariants.status === "failed" ||
    result.invariants.status === "missing" ||
    result.invariants.expectedReply === false ||
    result.invariants.violations.length > 0,
  )
  if (failed) process.exitCode = 1
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
