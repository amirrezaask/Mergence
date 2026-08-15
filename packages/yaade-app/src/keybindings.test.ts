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
  TOOL_SESSION_CONTEXT_BINDINGS,
  TOOL_SESSION_DIRECT_BINDINGS,
  TOOL_SESSION_PREFIX_BINDINGS,
  muxPrefixBindingKey,
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
      "toolSession prefix Ctrl-a a → tool.newAgent",
      "toolSession prefix Ctrl-a t → tool.newTerminal",
      "toolSession prefix Ctrl-a s → tool.newSearch",
      "toolSession prefix Ctrl-a e → tool.newEditor",
      "toolSession prefix Ctrl-a g → tool.newGit",
      "toolSession prefix Ctrl-a b → sidebar.toggle",
      "toolSession prefix Ctrl-a j → tool.next",
      "toolSession prefix Ctrl-a k → tool.previous",
      "toolSession prefix Ctrl-a u → tool.switch",
      "toolSession prefix Ctrl-a w → session.switch",
      "toolSession prefix Ctrl-a 1 → tool.jump",
      "toolSession prefix Ctrl-a c → session.new",
      "toolSession prefix Ctrl-a x → tool.close",
      "toolSession prefix Ctrl-a Shift-X → session.close",
      "toolSession prefix Ctrl-a , → settings.show",
      "toolSession direct Mod-, → settings.show",
      "toolSession context Mod-p [editor,search] → editor.quickOpen",
      "mux prefix Ctrl-a c → terminal.new",
      "mux prefix Ctrl-a d → mux.splitRight",
      "mux prefix Ctrl-a Shift-D → mux.splitDown",
      "mux prefix Ctrl-a x → mux.closePane",
      "mux prefix Ctrl-a z → mux.zoomPane",
      "mux prefix Ctrl-a h → mux.focusLeft",
      "mux prefix Ctrl-a j → mux.focusDown",
      "mux prefix Ctrl-a k → mux.focusUp",
      "mux prefix Ctrl-a l → mux.focusRight",
      "mux prefix Ctrl-a ArrowLeft → mux.focusLeft",
      "mux prefix Ctrl-a ArrowDown → mux.focusDown",
      "mux prefix Ctrl-a ArrowUp → mux.focusUp",
      "mux prefix Ctrl-a ArrowRight → mux.focusRight",
      "mux prefix Ctrl-a w → terminal.list",
      "mux prefix Ctrl-a t → mux.newWindow",
      "mux prefix Ctrl-a n → mux.openNeovim",
      "mux prefix Ctrl-a g → mux.openGit",
      "mux prefix Ctrl-a e → explorer.focus",
      "mux prefix Ctrl-a f → editor.quickOpen",
      "mux prefix Ctrl-a / → search.focus",
      "mux prefix Ctrl-a b → buffers.focus",
      "mux prefix Ctrl-a o → outline.focus",
      "mux prefix Ctrl-a r → references.focus",
      "mux prefix Ctrl-a [ → editor.navigateBack",
      "mux prefix Ctrl-a ] → editor.navigateForward",
      "mux prefix Ctrl-a s → editor.save",
      "mux prefix Ctrl-a p → ui.showCommandPalette",
      "mux prefix Ctrl-a . → workspace.cd",
      "mux prefix Ctrl-a , → settings.show",
      "mux prefix Ctrl-a = → ui.zoomIn",
      "mux prefix Ctrl-a - → ui.zoomOut",
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
})
