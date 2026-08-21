import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import { Schema } from "effect"
import { AppSession, SessionId, SessionTab, SessionTabId, ToolUseId } from "@yaade/rpc"
import {
  chooseSession,
  chooseTab,
  chooseToolUse,
  isLiveSessionTab,
  parseToolSessionRoute,
  persistToolSessionRoute,
  resolveToolSessionRoute,
  shouldHoldRequestedRoute,
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

  it("resolves host-local deep links against multi-server scoped ids", () => {
    const local = Schema.decodeUnknownSync(SessionId)("ses-aaaa1111")
    const scoped = Schema.decodeUnknownSync(SessionId)("ses-local--aaaa1111")
    const other = Schema.decodeUnknownSync(SessionId)("ses-local--bbbb2222")
    const scopedSession = AppSession.make({
      id: scoped,
      title: "A02",
      position: 1,
      createdAt: "2026-01-04",
      updatedAt: "2026-01-04",
    })
    const otherSession = AppSession.make({
      id: other,
      title: "Session 1",
      position: 0,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    })
    assert.equal(chooseSession(local, [otherSession, scopedSession])?.id, scoped)
    assert.equal(chooseSession(local, [otherSession]), undefined)
    const route = parseToolSessionRoute(`/?s=${local}`)
    const loaded = {
      sessionsById: new Map([[scoped, scopedSession]]),
      tabsById: new Map(),
      usesById: new Map(),
    }
    assert.equal(shouldHoldRequestedRoute(route, loaded, "connecting"), false)
    assert.equal(
      shouldHoldRequestedRoute(route, { sessionsById: new Map(), tabsById: new Map(), usesById: new Map() }, "connecting"),
      true,
    )
  })

  it("holds a deep link until the requested session is loaded", () => {
    const route = parseToolSessionRoute(toolSessionUrl(sessionA.id))
    const empty = {
      sessionsById: new Map(),
      tabsById: new Map(),
      usesById: new Map(),
    }
    const loaded = {
      sessionsById: new Map([[sessionA.id, sessionA]]),
      tabsById: new Map(),
      usesById: new Map(),
    }
    assert.equal(shouldHoldRequestedRoute(route, empty, "connecting"), true)
    assert.equal(shouldHoldRequestedRoute(route, empty, "reconciling"), true)
    assert.equal(shouldHoldRequestedRoute(route, empty, "connected"), false)
    assert.equal(shouldHoldRequestedRoute(route, loaded, "connecting"), false)
    assert.equal(shouldHoldRequestedRoute(route, loaded, "connected"), false)
  })

  it("falls back to a session's persisted active use", () => {
    const useId = Schema.decodeUnknownSync(ToolUseId)("use-a")
    const active = AppSession.make({ ...sessionA, activeToolUseId: useId })
    assert.equal(chooseToolUse(undefined, active, [useId]), useId)
    assert.equal(chooseToolUse(undefined, sessionA, [useId]), useId)
  })

  it("resolves a tool's owning window when the URL omits t", () => {
    const tabA = SessionTab.make({
      id: Schema.decodeUnknownSync(SessionTabId)("tab-a"),
      sessionId: sessionA.id,
      title: "Window 1",
      position: 0,
      createdAt: sessionA.createdAt,
      updatedAt: sessionA.updatedAt,
    })
    const tabB = SessionTab.make({
      id: Schema.decodeUnknownSync(SessionTabId)("tab-b"),
      sessionId: sessionA.id,
      title: "Window 2",
      position: 1,
      createdAt: sessionA.createdAt,
      updatedAt: sessionA.updatedAt,
    })
    const chosen = chooseTab(undefined, sessionA, [tabA, tabB], tabB.id)
    assert.equal(chosen?.id, tabB.id)
  })

  it("restores the last session route when the URL has no s", () => {
    const memory = new Map<string, string>()
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value)
      },
    }
    const url = toolSessionUrl(sessionA.id, Schema.decodeUnknownSync(SessionTabId)("tab-a"))
    persistToolSessionRoute(url, storage)
    assert.equal(resolveToolSessionRoute("/", storage).sessionId, sessionA.id)
    assert.equal(resolveToolSessionRoute("/?s=ses-b", storage).sessionId, sessionB.id)
  })

  it("rejects archived or cross-session tabs as tool targets", () => {
    const tab = SessionTab.make({
      id: Schema.decodeUnknownSync(SessionTabId)("tab-a"),
      sessionId: sessionA.id,
      title: "Window 1",
      position: 0,
      createdAt: sessionA.createdAt,
      updatedAt: sessionA.updatedAt,
    })
    assert.equal(isLiveSessionTab(sessionA, tab), true)
    assert.equal(isLiveSessionTab(sessionB, tab), false)
    assert.equal(
      isLiveSessionTab(sessionA, { ...tab, archivedAt: "2026-01-04" }),
      false,
    )
  })
})
