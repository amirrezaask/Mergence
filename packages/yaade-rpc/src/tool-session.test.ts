import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect, Schema } from "effect"
import {
  AgentToolInput,
  AppSession,
  MainCheckout,
  ProcessToolOutput,
  SearchResultsAppended,
  SearchToolInput,
  SearchToolOutput,
  SessionId,
  ToolUse,
  ToolUseId,
  ToolUseInput,
  ToolUseOutput,
  ToolUseStatus,
  TerminalToolInput,
} from "./tool-session.js"

const decode = <A>(schema: Schema.Schema<A>, value: unknown): A =>
  Effect.runSync(Schema.decodeUnknown(schema)(value))

const project = {
  projectId: "project-1",
  projectPath: "/tmp/project",
  projectName: "project",
}
const context = {
  project,
  checkoutKey: "main",
  checkoutPath: "/tmp/project",
  checkoutLabel: "Main",
  managedWorktree: false,
}

function processUse(input: unknown) {
  return {
    id: "use-process",
    sessionId: "ses-session",
    kind: "terminal",
    title: "Shell",
    position: 0,
    status: "created",
    context,
    input,
    inputRevision: 1,
    output: {
      _tag: "ProcessToolOutput",
      kind: "process",
      terminalInstanceId: "term-1",
      generation: 1,
      processState: "starting",
      activityState: "starting",
      replayAvailable: true,
      truncated: false,
    },
    revision: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }
}

describe("tool session contracts", () => {
  it("accepts valid branded ids and rejects malformed ids", () => {
    assert.equal(decode(SessionId, "ses-session"), "ses-session")
    assert.equal(decode(ToolUseId, "use-tool"), "use-tool")
    assert.throws(() => decode(SessionId, "project-session"))
    assert.throws(() => decode(ToolUseId, "tool"))
  })

  it("round-trips every input and output member", () => {
    const agent = decode(ToolUseInput, { _tag: "AgentToolInput", kind: "agent", provider: "pi" })
    const terminal = decode(ToolUseInput, { _tag: "TerminalToolInput", kind: "terminal" })
    const search = decode(ToolUseInput, {
      _tag: "SearchToolInput",
      kind: "search",
      query: "needle",
      options: { regex: false },
    })
    assert.equal(agent.kind, "agent")
    assert.equal(terminal.kind, "terminal")
    assert.equal(search.kind, "search")
    assert.equal(decode(ToolUseOutput, processUse(terminal).output).kind, "process")
    assert.equal(
      decode(ToolUseOutput, {
        _tag: "SearchToolOutput",
        kind: "search",
        resultRevision: 1,
        resultCount: 0,
        truncated: false,
        running: false,
      }).kind,
      "search",
    )
  })

  it("rejects a ToolUse whose input or output kind does not match", () => {
    assert.throws(() => decode(ToolUse, processUse({
      _tag: "AgentToolInput",
      kind: "agent",
      provider: "pi",
    })))
  })

  it("rejects oversized search event batches", () => {
    const result = { path: "src/a.ts", line: 1, column: 1, preview: "needle", ranges: [] }
    assert.throws(() => decode(SearchResultsAppended, {
      _tag: "SearchResultsAppended",
      eventId: "evt-1",
      toolUseId: "use-search",
      revision: 2,
      resultRevision: 1,
      occurredAt: "2026-01-01T00:00:00Z",
      results: Array.from({ length: 101 }, () => result),
    }))
  })

  it("preserves omitted optional fields", () => {
    const session = decode(AppSession, {
      id: "ses-session",
      title: "Session 1",
      position: 0,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    })
    assert.equal("activeToolUseId" in session, false)
  })

  it("keeps status and tagged input members type-safe", () => {
    const status = decode(ToolUseStatus, "waiting")
    const input = decode(AgentToolInput, { _tag: "AgentToolInput", kind: "agent", provider: "claude" })
    assert.equal(status, "waiting")
    assert.equal(input.provider, "claude")
    assert.equal(MainCheckout.make({ kind: "main" }).kind, "main")
    assert.equal(SearchToolInput.make({ kind: "search", query: "x", options: {} }).query, "x")
    assert.equal(TerminalToolInput.make({ kind: "terminal" }).kind, "terminal")
    assert.equal(ProcessToolOutput.make({
      kind: "process",
      terminalInstanceId: "term",
      generation: 1,
      processState: "running",
      activityState: "idle",
      replayAvailable: true,
      truncated: false,
    }).processState, "running")
    assert.equal(SearchToolOutput.make({
      kind: "search",
      resultRevision: 1,
      resultCount: 0,
      truncated: false,
      running: false,
    }).running, false)
  })
})
