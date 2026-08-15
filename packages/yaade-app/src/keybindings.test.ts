import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  isBrowserReservedChord,
  isBrowserRiskyChord,
} from "@yaade/workspace"
import {
  MUX_DIRECT_BINDINGS,
  MUX_PREFIX_BINDINGS,
  MUX_UNZOOM_BINDING,
  SHELL_PREFIX,
  TOOL_SESSION_CONTEXT_BINDINGS,
  TOOL_SESSION_DIRECT_BINDINGS,
  TOOL_SESSION_PREFIX_BINDINGS,
  muxPrefixBindingKey,
  prefixLiteralByte,
  toolSessionPrefixBindingKey,
} from "./keybindings.js"

function catalogRows(): string[] {
  return [
    ...TOOL_SESSION_PREFIX_BINDINGS.map(
      (binding) =>
        `toolSession prefix ${toolSessionPrefixBindingKey(binding.key)} → ${binding.command}`,
    ),
    ...TOOL_SESSION_DIRECT_BINDINGS.map(
      (binding) => `toolSession direct ${binding.key} → ${binding.command}`,
    ),
    ...TOOL_SESSION_CONTEXT_BINDINGS.map(
      (binding) =>
        `toolSession context ${binding.key} [${binding.when.join(",")}] → ${binding.command}`,
    ),
    ...MUX_PREFIX_BINDINGS.map(
      (binding) =>
        `mux prefix ${muxPrefixBindingKey(binding.key)} → ${binding.command}`,
    ),
    ...MUX_DIRECT_BINDINGS.map(
      (binding) => `mux direct ${binding.key} → ${binding.command}`,
    ),
    `mux context ${MUX_UNZOOM_BINDING.key} → ${MUX_UNZOOM_BINDING.command}`,
  ]
}

describe("keybinding catalog", () => {
  it("lists every command chord in one place", () => {
    assert.deepEqual(catalogRows(), [
      "toolSession prefix Mod-k t → tool.newTerminal",
      "toolSession prefix Mod-k s → tool.newSearch",
      "toolSession prefix Mod-k e → tool.newEditor",
      "toolSession prefix Mod-k g → tool.newGit",
      "toolSession prefix Mod-k b → sidebar.toggle",
      "toolSession prefix Mod-k j → tool.next",
      "toolSession prefix Mod-k k → tool.previous",
      "toolSession prefix Mod-k u → tool.switch",
      "toolSession prefix Mod-k w → session.switch",
      "toolSession prefix Mod-k 1 → tool.jump",
      "toolSession prefix Mod-k c → session.new",
      "toolSession prefix Mod-k x → tool.close",
      "toolSession prefix Mod-k Shift-X → session.close",
      "toolSession prefix Mod-k , → settings.show",
      "toolSession direct Mod-, → settings.show",
      "toolSession context Mod-p [editor,search] → editor.quickOpen",
      "mux prefix Mod-k c → terminal.new",
      "mux prefix Mod-k d → mux.splitRight",
      "mux prefix Mod-k Shift-D → mux.splitDown",
      "mux prefix Mod-k x → mux.closePane",
      "mux prefix Mod-k z → mux.zoomPane",
      "mux prefix Mod-k h → mux.focusLeft",
      "mux prefix Mod-k j → mux.focusDown",
      "mux prefix Mod-k k → mux.focusUp",
      "mux prefix Mod-k l → mux.focusRight",
      "mux prefix Mod-k ArrowLeft → mux.focusLeft",
      "mux prefix Mod-k ArrowDown → mux.focusDown",
      "mux prefix Mod-k ArrowUp → mux.focusUp",
      "mux prefix Mod-k ArrowRight → mux.focusRight",
      "mux prefix Mod-k w → terminal.list",
      "mux prefix Mod-k t → mux.newWindow",
      "mux prefix Mod-k n → mux.openNeovim",
      "mux prefix Mod-k g → mux.openGit",
      "mux prefix Mod-k e → explorer.focus",
      "mux prefix Mod-k f → editor.quickOpen",
      "mux prefix Mod-k / → search.focus",
      "mux prefix Mod-k b → buffers.focus",
      "mux prefix Mod-k o → outline.focus",
      "mux prefix Mod-k r → references.focus",
      "mux prefix Mod-k [ → editor.navigateBack",
      "mux prefix Mod-k ] → editor.navigateForward",
      "mux prefix Mod-k s → editor.save",
      "mux prefix Mod-k p → ui.showCommandPalette",
      "mux prefix Mod-k . → workspace.cd",
      "mux prefix Mod-k , → settings.show",
      "mux prefix Mod-k = → ui.zoomIn",
      "mux prefix Mod-k - → ui.zoomOut",
      "mux direct Mod-Shift-p → ui.showCommandPalette",
      "mux direct Mod-, → settings.show",
      "mux context Escape → mux.unzoom",
    ])
  })

  it("binds nothing the browser will swallow", () => {
    for (const row of catalogRows()) {
      const key = row.split(" → ")[0]!.replace(
        /^(toolSession|mux) (prefix|direct|context) /,
        "",
      )
        .replace(/ \[.*\]$/, "")
      assert.equal(isBrowserReservedChord(key), false, row)
    }
  })

  it("documents a reason for every risky Tool Session context chord", () => {
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
