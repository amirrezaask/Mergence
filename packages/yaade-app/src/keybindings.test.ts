import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  isBrowserReservedChord,
  isBrowserRiskyChord,
} from "@yaade/workspace"
import {
  SHELL_PREFIX,
  TOOL_SESSION_CONTEXT_BINDINGS,
  TOOL_SESSION_DIRECT_BINDINGS,
  TOOL_SESSION_PREFIX_BINDINGS,
  prefixLiteralByte,
  toolSessionPrefixBindingKey,
} from "./keybindings.js"

function catalogRows(): string[] {
  return [
    ...TOOL_SESSION_PREFIX_BINDINGS.map(
      binding =>
        `toolSession prefix ${toolSessionPrefixBindingKey(binding.key)} → ${binding.command}`,
    ),
    ...TOOL_SESSION_DIRECT_BINDINGS.map(
      binding => `toolSession direct ${binding.key} → ${binding.command}`,
    ),
    ...TOOL_SESSION_CONTEXT_BINDINGS.map(
      binding =>
        `toolSession context ${binding.key} [${binding.when.join(",")}] → ${binding.command}`,
    ),
  ]
}

describe("keybinding catalog", () => {
  it("lists every active command chord in one place", () => {
    assert.deepEqual(catalogRows(), [
      "toolSession prefix Mod-k t → tool.newTerminal",
      "toolSession prefix Mod-k s → tool.newSearch",
      "toolSession prefix Mod-k g → tool.newGit",
      "toolSession prefix Mod-k e → tool.newNeovim",
      "toolSession prefix Mod-k j → tool.next",
      "toolSession prefix Mod-k k → tool.previous",
      "toolSession prefix Mod-k l → tab.next",
      "toolSession prefix Mod-k h → tab.previous",
      "toolSession prefix Mod-k z → pane.zoom",
      "toolSession prefix Mod-k u → tool.switch",
      "toolSession prefix Mod-k w → session.switch",
      "toolSession prefix Mod-k 1 → tool.jump",
      "toolSession prefix Mod-k c → session.new",
      "toolSession prefix Mod-k n → tab.new",
      "toolSession prefix Mod-k x → tool.close",
      "toolSession prefix Mod-k Shift-X → session.close",
      "toolSession prefix Mod-k , → settings.show",
      "toolSession direct Mod-, → settings.show",
    ])
  })

  it("binds nothing the browser will swallow", () => {
    for (const row of catalogRows()) {
      const key = row.split(" → ")[0]!.replace(/^toolSession (prefix|direct|context) /, "")
        .replace(/ \[.*\]$/, "")
      assert.equal(isBrowserReservedChord(key), false, row)
    }
  })

  it("documents a reason for every risky context chord", () => {
    for (const binding of TOOL_SESSION_CONTEXT_BINDINGS) {
      if (isBrowserRiskyChord(binding.key)) {
        assert.ok(binding.riskyReason, binding.key)
      }
    }
  })

  it("uses Mod-k as the shell prefix (⌘K / Ctrl+K)", () => {
    assert.equal(SHELL_PREFIX, "Mod-k")
    assert.equal(isBrowserReservedChord(SHELL_PREFIX), false)
    assert.equal(isBrowserRiskyChord(SHELL_PREFIX), true)
    assert.equal(prefixLiteralByte(SHELL_PREFIX), "\x0b")
    assert.equal(prefixLiteralByte("Ctrl-k"), "\x0b")
    assert.equal(prefixLiteralByte("Ctrl-a"), "\x01")
    assert.equal(prefixLiteralByte("Mod-Shift-p"), null)
  })
})
