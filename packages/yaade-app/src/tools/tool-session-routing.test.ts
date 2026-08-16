import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Schema } from "effect"
import { AppSession, SessionId, SessionTabId, ToolUseId } from "@yaade/rpc"
import {
  chooseSession,
  chooseToolUse,
  parseToolSessionRoute,
  toolSessionUrl,
} from "./tool-session-routing.js"

const sessionA = AppSession.make({ id: Schema.decodeUnknownSync(SessionId)("ses-a"), title: "A", position: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01" })
const sessionB = AppSession.make({ id: Schema.decodeUnknownSync(SessionId)("ses-b"), title: "B", position: 1, createdAt: "2026-01-02", updatedAt: "2026-01-03" })

describe("tool session routing", () => {
  it("parses and serializes the global session URL", () => {
    const sessionId = Schema.decodeUnknownSync(SessionId)("ses-a")
    const tabId = Schema.decodeUnknownSync(SessionTabId)("tab-a")
    const useId = Schema.decodeUnknownSync(ToolUseId)("use-a")
    assert.deepEqual(parseToolSessionRoute(toolSessionUrl(sessionId, tabId, useId)), { sessionId, tabId, toolUseId: useId })
    assert.deepEqual(parseToolSessionRoute(toolSessionUrl(sessionId, useId)), { sessionId, toolUseId: useId })
    assert.equal(parseToolSessionRoute("/dev/project").legacyPath, "/dev/project")
  })

  it("ignores malformed ids and chooses the latest visible session", () => {
    assert.equal(parseToolSessionRoute("/?s=project-id").sessionId, undefined)
    assert.equal(chooseSession(undefined, [sessionA, sessionB])?.id, sessionB.id)
    assert.equal(chooseSession(sessionA.id, [sessionA, sessionB])?.id, sessionA.id)
  })

  it("falls back to a session's persisted active use", () => {
    const useId = Schema.decodeUnknownSync(ToolUseId)("use-a")
    const active = AppSession.make({ ...sessionA, activeToolUseId: useId })
    assert.equal(chooseToolUse(undefined, active, [useId]), useId)
    assert.equal(chooseToolUse(undefined, sessionA, [useId]), useId)
  })
})
