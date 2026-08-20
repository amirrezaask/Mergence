import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import {
  agentCliDriverId,
  agentDriverIdForMode,
  normalizeAgentId,
} from "./model.js"

describe("normalizeAgentId", () => {
  it("maps legacy aliases", () => {
    assert.equal(normalizeAgentId("claudeAgent"), "claude")
    assert.equal(normalizeAgentId("cursorAcp"), "cursor")
    assert.equal(normalizeAgentId("cursor-acp"), "cursor")
    assert.equal(normalizeAgentId(null), "codex")
    assert.equal(normalizeAgentId("codex"), "codex")
  })
})

describe("agentCliDriverId", () => {
  it("returns *:cli ids", () => {
    assert.equal(agentCliDriverId("codex"), "codex:cli")
    assert.equal(agentCliDriverId("claude"), "claude:cli")
    assert.equal(agentDriverIdForMode("cursor", "cli"), "cursor:cli")
    assert.equal(agentDriverIdForMode("grok", "native"), "grok:cli")
  })
})
