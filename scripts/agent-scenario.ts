import { writeFile } from "node:fs/promises"
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

async function main(): Promise<void> {
const scenarioId = process.argv[2] ?? "simple-stream"
const outFlag = process.argv.find(value => value.startsWith("--out="))
const scenario = mockScenarios[scenarioId]
if (!scenario) {
  throw new Error(`unknown scenario ${scenarioId}; choose ${Object.keys(mockScenarios).join(", ")}`)
}

const driver = new MockAgentDriver(scenario)
const context: any = {
  workspace: { rootUri: "file:///tmp", additionalRoots: [], assertAllowed: async () => {} },
  filesystem: { readFile: async () => new Uint8Array(), writeFile: async () => {}, stat: async () => ({ size: 0 }) },
  terminal: { open: async () => { throw new Error("unused") } },
  processSpawner: { spawn: async () => { throw new Error("unused") } },
  attachments: { resolve: async () => { throw new Error("unused") } },
  credentials: { get: async () => undefined },
  mcp: { listServers: async () => [] },
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z"), sleep: async () => {} },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  signal: new AbortController().signal,
}
const connection = await driver.openThread(context, { mode: { type: "new" }, cwdUri: "file:///tmp" })
const trace: AgentEventEnvelopeType[] = []
const violations: string[] = []
const seenEventIds = new Set<string>()
let snapshot: AgentThreadSnapshot | undefined
let sequence = 0

const append = (
  event: unknown,
  commandId?: string,
  metadata?: { nativeEventId?: string; providerCursor?: string },
) => {
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
    ...(commandId ? { commandId } : {}),
    ...(metadata?.providerCursor ? { providerCursor: metadata.providerCursor } : {}),
    event,
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
  providerId: connection.binding.providerSessionId ? "mock" : "mock",
  driverId: driver.descriptor.id,
  ...(connection.binding.providerSessionId ? { providerSessionId: connection.binding.providerSessionId } : {}),
  cwdUri: "file:///tmp",
  capabilities: connection.capabilities,
  configuration: connection.configuration ?? [],
})

let terminalResolve!: () => void
const terminal = new Promise<void>(resolve => { terminalResolve = resolve })
const pump = (async () => {
  for await (const raw of connection.events()) {
    append(raw.event, undefined, {
      ...(raw.nativeEventId ? { nativeEventId: raw.nativeEventId } : {}),
      ...(raw.providerCursor ? { providerCursor: raw.providerCursor } : {}),
    })
    if (raw.event.type === "action.requested") {
      const action = raw.event.action
      const response = action.type === "permission"
        ? { type: "permission" as const, optionId: action.options.find(option => option.decision.startsWith("allow"))?.id ?? action.options[0]?.id ?? "" }
        : action.type === "authentication"
          ? { type: "authentication" as const, status: "completed" as const }
          : { type: "elicitation" as const, values: {} }
      await connection.send(Schema.decodeUnknownSync(AgentCommandEnvelope)({
        protocolVersion: 1,
        commandId: "scenario-action",
        threadId: "scenario-thread",
        issuedAt: "2026-01-01T00:00:00.000Z",
        command: { type: "action.respond", actionId: action.id, response },
      }))
    }
    if (scenarioId === "interrupt" && raw.event.type === "item.delta") {
      await connection.send(Schema.decodeUnknownSync(AgentCommandEnvelope)({
        protocolVersion: 1,
        commandId: "scenario-interrupt",
        threadId: "scenario-thread",
        issuedAt: "2026-01-01T00:00:00.000Z",
        command: { type: "turn.interrupt", turnId: "mock-turn-1" },
      }))
    }
    if (
      raw.event.type === "turn.completed" ||
      raw.event.type === "turn.failed" ||
      raw.event.type === "turn.interrupted"
    ) {
      terminalResolve()
      break
    }
  }
})()

if (scenarioId === "configuration-change" || scenarioId === "configuration-rejection") {
  await connection.send(Schema.decodeUnknownSync(AgentCommandEnvelope)({
    protocolVersion: 1,
    commandId: "scenario-configuration",
    threadId: "scenario-thread",
    issuedAt: "2026-01-01T00:00:00.000Z",
    command: { type: "configuration.set", optionId: "model", value: "mock-deep" },
  }))
}
const input = scenarioId === "attachments"
  ? [{ type: "attachment" as const, attachmentId: "scenario-attachment", purpose: "context" as const }]
  : [{ type: "text" as const, text: scenarioId }]
await connection.send(Schema.decodeUnknownSync(AgentCommandEnvelope)({
  protocolVersion: 1,
  commandId: "scenario-submit",
  threadId: "scenario-thread",
  issuedAt: "2026-01-01T00:00:00.000Z",
  command: { type: "turn.submit", input },
}))
await terminal
await connection.close("user")
await pump

const result = {
  manifest: { scenarioId, driverId: driver.descriptor.id, providerId: driver.descriptor.providerId },
  trace,
  finalState: snapshot?.state ?? null,
  invariants: {
    sequenceMonotonic: trace.every((event, index) => event.sequence === index + 1),
    pendingActions: snapshot?.state.pendingActions.length ?? 0,
    status: snapshot?.state.status ?? "missing",
    violations,
  },
}
const json = `${JSON.stringify(result, null, 2)}\n`
if (outFlag) await writeFile(outFlag.slice("--out=".length), json, "utf8")
process.stdout.write(json)
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
