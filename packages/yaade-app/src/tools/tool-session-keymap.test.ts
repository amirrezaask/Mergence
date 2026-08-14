import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  isBrowserReservedChord,
  isBrowserRiskyChord,
} from "@yaade/workspace"
import {
  TOOL_SESSION_CONTEXT_BINDINGS,
  TOOL_SESSION_DIRECT_BINDINGS,
  TOOL_SESSION_DUAL_PATH_COMMANDS,
  TOOL_SESSION_PREFIX,
  TOOL_SESSION_PREFIX_BINDINGS,
  TOOL_SESSION_PREFIX_GROUPS,
  isToolSessionJumpKey,
  toolSessionDirectShortcutFor,
  toolSessionHudBindings,
  toolSessionPrefixBindingKey,
  toolSessionShortcutFor,
} from "./tool-session-keymap.js"

describe("tool session keymap", () => {
  it("binds nothing the browser will swallow", () => {
    for (const binding of TOOL_SESSION_DIRECT_BINDINGS) {
      assert.equal(isBrowserReservedChord(binding.key), false, binding.key)
    }
    for (const binding of TOOL_SESSION_CONTEXT_BINDINGS) {
      assert.equal(isBrowserReservedChord(binding.key), false, binding.key)
    }
    for (const binding of TOOL_SESSION_PREFIX_BINDINGS) {
      assert.equal(
        isBrowserReservedChord(toolSessionPrefixBindingKey(binding.key)),
        false,
        binding.key,
      )
    }
  })

  it("keeps direct chords off the risky list", () => {
    for (const binding of TOOL_SESSION_DIRECT_BINDINGS) {
      assert.equal(isBrowserRiskyChord(binding.key), false, binding.key)
    }
  })

  it("documents a reason for every risky context chord", () => {
    for (const binding of TOOL_SESSION_CONTEXT_BINDINGS) {
      if (isBrowserRiskyChord(binding.key)) {
        assert.ok(binding.riskyReason, binding.key)
      }
    }
  })

  it("has no duplicate prefix keys", () => {
    const keys = TOOL_SESSION_PREFIX_BINDINGS.map((binding) => binding.key)
    assert.equal(new Set(keys).size, keys.length)
  })

  it("has no duplicate HUD commands", () => {
    const commands = toolSessionHudBindings().map((binding) => binding.command)
    assert.equal(new Set(commands).size, commands.length)
  })

  it("has no duplicate direct keys", () => {
    const keys = TOOL_SESSION_DIRECT_BINDINGS.map((binding) => binding.key)
    assert.equal(new Set(keys).size, keys.length)
  })

  it("allows only settings as a prefix+direct dual path", () => {
    const prefixCommands = new Set(
      TOOL_SESSION_PREFIX_BINDINGS.map((binding) => binding.command),
    )
    const dual = TOOL_SESSION_DIRECT_BINDINGS.filter((binding) =>
      prefixCommands.has(binding.command),
    ).map((binding) => binding.command)
    assert.deepEqual(dual, [...TOOL_SESSION_DUAL_PATH_COMMANDS])
  })

  it("drops retired aliases", () => {
    const prefixKeys = new Set(
      TOOL_SESSION_PREFIX_BINDINGS.map((binding) => binding.key),
    )
    const directKeys = new Set(
      TOOL_SESSION_DIRECT_BINDINGS.map((binding) => binding.key),
    )
    assert.equal(prefixKeys.has("p"), false)
    assert.equal(directKeys.has("Mod-k"), false)
    assert.equal(directKeys.has("Mod-Shift-p"), false)
  })

  it("opens each tool kind with a mnemonic letter", () => {
    const byCommand = new Map(
      TOOL_SESSION_PREFIX_BINDINGS.map((binding) => [binding.command, binding]),
    )
    assert.equal(byCommand.get("tool.newAgent")?.key, "a")
    assert.equal(byCommand.get("tool.newTerminal")?.key, "t")
    assert.equal(byCommand.get("tool.newSearch")?.key, "s")
    assert.equal(byCommand.get("tool.newEditor")?.key, "e")
    assert.equal(byCommand.get("tool.newGit")?.key, "g")
    assert.equal(byCommand.get("sidebar.toggle")?.key, "b")
  })

  it("keeps HUD groups covering every visible binding", () => {
    const groupIds = new Set(TOOL_SESSION_PREFIX_GROUPS.map((group) => group.id))
    for (const binding of toolSessionHudBindings()) {
      assert.equal(groupIds.has(binding.group), true, binding.key)
    }
  })

  it("formats prefix and direct shortcuts from the binding tables", () => {
    assert.equal(
      toolSessionShortcutFor("tool.newAgent"),
      `${TOOL_SESSION_PREFIX} a`,
    )
    assert.equal(
      toolSessionShortcutFor("session.switch"),
      `${TOOL_SESSION_PREFIX} w`,
    )
    assert.equal(
      toolSessionShortcutFor("tool.switch"),
      `${TOOL_SESSION_PREFIX} u`,
    )
    assert.equal(
      toolSessionShortcutFor("sidebar.toggle"),
      `${TOOL_SESSION_PREFIX} b`,
    )
    assert.equal(toolSessionDirectShortcutFor("sidebar.toggle"), undefined)
    assert.equal(toolSessionDirectShortcutFor("settings.show"), "Mod-,")
  })

  it("treats 1–9 as jump keys without nine HUD rows", () => {
    assert.equal(isToolSessionJumpKey("1"), true)
    assert.equal(isToolSessionJumpKey("9"), true)
    assert.equal(isToolSessionJumpKey("0"), false)
    const jumpRows = toolSessionHudBindings().filter(
      (binding) => binding.command === "tool.jump",
    )
    assert.equal(jumpRows.length, 1)
    assert.equal(jumpRows[0]?.key, "1")
  })
})
