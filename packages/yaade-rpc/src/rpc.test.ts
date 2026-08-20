import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import { Effect, Schema } from "effect"
import {
  HostRpcRequest,
  HostEvent,
  FileChangedError,
  TextFileReadResult,
  TextFileWriteOptions,
  decodeHostRpcRequest,
  hostErrorWire,
  PathOutsideRootsError,
  unknownChannel,
  tryDecodeSessionRoster,
  decodeSessionRosterUnknown,
  EMPTY_SESSION_ROSTER,
  encodeSessionRoster,
  MAX_ARCHIVED_TRANSCRIPT_CHARS,
} from "./index.js"

describe("yaade-rpc schemas", () => {
  it("round-trips host RPC request defaults", async () => {
    const decoded = await Effect.runPromise(decodeHostRpcRequest({ channel: "fs:stat" }))
    assert.equal(decoded.channel, "fs:stat")
    assert.deepEqual(decoded.args, [])
    assert.equal(decoded.clientId, "browser")
  })

  it("encodes host event", async () => {
    const encoded = await Effect.runPromise(
      Schema.encode(HostEvent)({
        protocolVersion: 1,
        sequence: 3,
        channel: "terminal:data",
        args: ["pty-1", "hi"],
      }),
    )
    assert.equal(encoded.sequence, 3)
    assert.equal(encoded.channel, "terminal:data")
  })

  it("hot-path skips schema for terminal:data", async () => {
    const { isHotPathHostEvent, tryDecodeRealtimeHostEvent, decodeRealtimeHostEvent } =
      await import("./host.js")
    const raw = {
      protocolVersion: 1,
      sequence: 1,
      channel: "terminal:data",
      args: ["id", "x", 1],
    }
    assert.equal(isHotPathHostEvent(raw), true)
    assert.equal(tryDecodeRealtimeHostEvent(raw)?.sequence, 1)
    const viaEffect = await Effect.runPromise(decodeRealtimeHostEvent(raw))
    assert.equal(viaEffect.channel, "terminal:data")
  })

  it("maps path errors to wire codes", () => {
    const wire = hostErrorWire(
      new PathOutsideRootsError({ message: "PATH_OUTSIDE_ALLOWED_ROOTS", path: "/tmp" }),
    )
    assert.equal(wire.code, "PATH_OUTSIDE_ALLOWED_ROOTS")
  })

  it("builds unknown channel error", () => {
    const err = unknownChannel("nope:x")
    assert.equal(err.code, "UNKNOWN_OPERATION")
    assert.match(err.message, /nope:x/)
  })

  it("rejects bad host request", async () => {
    await assert.rejects(() => Effect.runPromise(decodeHostRpcRequest({ args: [] })))
  })

  it("HostRpcRequest schema type is struct", () => {
    assert.ok(HostRpcRequest)
  })

  it("validates versioned text-file contracts", () => {
    const read = Schema.decodeUnknownSync(TextFileReadResult)({
      content: "hello",
      version: "123:5",
      size: 5,
    })
    assert.equal(read.version, "123:5")
    assert.deepEqual(
      Schema.decodeUnknownSync(TextFileWriteOptions)({ expectedVersion: "123:5" }),
      { expectedVersion: "123:5" },
    )
    assert.deepEqual(
      Schema.decodeUnknownSync(TextFileWriteOptions)({ create: true }),
      { create: true },
    )
  })

  it("preserves FILE_CHANGED conflict details on the wire", () => {
    const wire = hostErrorWire(
      new FileChangedError({
        message: "file changed on disk",
        uri: "file:///tmp/file.ts",
        expectedVersion: "1:3",
        actualVersion: "2:3",
      }),
    )
    assert.equal(wire.code, "FILE_CHANGED")
    assert.deepEqual(wire.details, {
      uri: "file:///tmp/file.ts",
      expectedVersion: "1:3",
      actualVersion: "2:3",
    })
  })
})

describe("SessionRoster compat decode", () => {
  it("round-trips a valid roster via Schema encode", async () => {
    const roster = {
      version: 2 as const,
      sessions: [
        {
          tabId: "yaade:terminal:a",
          cwdRootUri: "file:///tmp/a",
          label: "Codex",
          status: "running" as const,
          launchCommand: "codex",
          agentId: "codex",
          agentTitle: "Review session state",
        },
      ],
      modal: { tabId: "yaade:terminal:a", sessionMode: "terminal" as const },
    }
    const encoded = await Effect.runPromise(encodeSessionRoster(roster))
    const decoded = tryDecodeSessionRoster(encoded)
    assert.deepEqual(decoded, roster)
  })

  it("upgrades version 1 to version 2", () => {
    const decoded = tryDecodeSessionRoster({
      version: 1,
      sessions: [
        {
          tabId: "yaade:terminal:legacy",
          cwdRootUri: "file:///legacy",
          label: "Shell",
          status: "exited",
        },
      ],
      modal: null,
    })
    assert.equal(decoded?.version, 2)
    assert.equal(decoded?.sessions.length, 1)
  })

  it("bounds archived transcript payloads", () => {
    const decoded = tryDecodeSessionRoster({
      version: 2,
      sessions: [
        {
          tabId: "yaade:terminal:archive",
          cwdRootUri: "file:///tmp/archive",
          label: "Archive",
          status: "exited",
          transcript: `prefix${"x".repeat(MAX_ARCHIVED_TRANSCRIPT_CHARS)}`,
        },
      ],
      modal: null,
    })
    assert.equal(
      decoded?.sessions[0]?.transcript?.length,
      MAX_ARCHIVED_TRANSCRIPT_CHARS,
    )
    assert.equal(decoded?.sessions[0]?.transcript?.startsWith("prefix"), false)
  })

  it("returns null for corrupt structure; unknown decode yields empty", () => {
    assert.equal(tryDecodeSessionRoster(null), null)
    assert.equal(tryDecodeSessionRoster({ version: 9, sessions: [] }), null)
    assert.equal(tryDecodeSessionRoster({ version: 2 }), null)
    assert.deepEqual(decodeSessionRosterUnknown({ version: 9 }), EMPTY_SESSION_ROSTER)
    assert.deepEqual(decodeSessionRosterUnknown("nope"), EMPTY_SESSION_ROSTER)
  })

  it("drops agent stub without launchCommand; keeps blank shells", () => {
    const decoded = tryDecodeSessionRoster({
      version: 2,
      sessions: [
        {
          tabId: "yaade:terminal:blank",
          cwdRootUri: "file:///blank",
          label: "Terminal",
          status: "running",
        },
        {
          tabId: "yaade:terminal:stub",
          cwdRootUri: "file:///stub",
          label: "Stub",
          status: "starting",
          agentId: "codex",
        },
      ],
      modal: null,
    })
    assert.equal(decoded?.sessions.length, 1)
    assert.equal(decoded?.sessions[0]?.tabId, "yaade:terminal:blank")
  })

  it("drops native-driver agent sessions without launchCommand", () => {
    const decoded = tryDecodeSessionRoster({
      version: 2,
      sessions: [
        {
          tabId: "yaade:terminal:native",
          cwdRootUri: "file:///native",
          label: "Codex",
          status: "running",
          agentId: "codex",
          agentDriverId: "codex:app-server",
          agentThreadId: "thread-1",
        },
        {
          tabId: "yaade:terminal:cli-stub",
          cwdRootUri: "file:///cli-stub",
          label: "Codex",
          status: "starting",
          agentId: "codex",
          agentDriverId: "codex:cli",
        },
      ],
      modal: null,
    })
    assert.equal(decoded?.sessions.length, 0)
  })

  it("clears orphan modal and dedupes tab ids", () => {
    const decoded = tryDecodeSessionRoster({
      version: 2,
      sessions: [
        {
          tabId: "yaade:terminal:a",
          cwdRootUri: "file:///a",
          label: "A",
          status: "running",
        },
        {
          tabId: "yaade:terminal:a",
          cwdRootUri: "file:///b",
          label: "Dup",
          status: "failed",
        },
      ],
      modal: { tabId: "yaade:terminal:missing", sessionMode: "terminal" },
    })
    assert.equal(decoded?.sessions.length, 1)
    assert.equal(decoded?.sessions[0]?.label, "A")
    assert.equal(decoded?.modal, null)
  })

  it("defaults unknown status; maps interrupted; ignores unknown fields", () => {
    const decoded = tryDecodeSessionRoster({
      version: 2,
      sessions: [
        {
          tabId: "yaade:terminal:a",
          cwdRootUri: "file:///a",
          label: "A",
          status: "weird",
          extraNoise: true,
        },
        {
          tabId: "yaade:terminal:b",
          cwdRootUri: "file:///b",
          label: "B",
          status: "interrupted",
        },
      ],
      modal: null,
      projects: [{ ignore: true }],
    })
    assert.equal(decoded?.sessions[0]?.status, "starting")
    assert.equal(decoded?.sessions[1]?.status, "failed")
  })

  it("filters non-string launchArgs", () => {
    const decoded = tryDecodeSessionRoster({
      version: 2,
      sessions: [
        {
          tabId: "yaade:terminal:a",
          cwdRootUri: "file:///a",
          label: "A",
          status: "running",
          launchCommand: "codex",
          launchArgs: ["ok", 12, "also"],
        },
      ],
      modal: null,
    })
    assert.deepEqual(decoded?.sessions[0]?.launchArgs, ["ok", "also"])
  })
})
