import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBrowserReservedChord, isBrowserRiskyChord } from "@yaade/workspace";
import {
  SHELL_PREFIX,
  TOOL_SESSION_CONTEXT_BINDINGS,
  TOOL_SESSION_DIRECT_BINDINGS,
  TOOL_SESSION_PREFIX_BINDINGS,
  createToolSessionKeymapState,
  prefixLiteralByte,
  resolveToolSessionKeydown,
  toolSessionPrefixBindingKey,
  type ToolSessionKeyEvent,
} from "./keybindings.js";

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
  ];
}

function keyEvent(init: {
  key: string;
  code?: string;
  modKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}): ToolSessionKeyEvent {
  return {
    key: init.key,
    code: init.code ?? init.key,
    metaKey:
      init.metaKey ?? (init.modKey === true && process.platform === "darwin"),
    ctrlKey:
      init.ctrlKey ?? (init.modKey === true && process.platform !== "darwin"),
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    repeat: init.repeat ?? false,
    isComposing: init.isComposing ?? false,
  };
}

const shellContext = {
  overlayOpen: false,
  inEditable: false,
  inTerminal: false,
  inPrefixButton: false,
  zoomed: false,
};

describe("keybinding catalog", () => {
  it("lists every active command chord in one place", () => {
    assert.deepEqual(catalogRows(), [
      "toolSession prefix Mod-k t → tool.newTerminal",
      "toolSession prefix Mod-k g → tool.newGit",
      "toolSession prefix Mod-k j → tool.next",
      "toolSession prefix Mod-k k → tool.previous",
      "toolSession prefix Mod-k l → tab.next",
      "toolSession prefix Mod-k h → tab.previous",
      "toolSession prefix Mod-k z → pane.zoom",
      "toolSession prefix Mod-k u → tool.switch",
      "toolSession prefix Mod-k b → sidebar.toggle",
      "toolSession prefix Mod-k w → session.switch",
      "toolSession prefix Mod-k 1 → tool.jump",
      "toolSession prefix Mod-k c → session.new",
      "toolSession prefix Mod-k n → tab.new",
      "toolSession prefix Mod-k x → tool.close",
      "toolSession prefix Mod-k Shift-X → session.close",
      "toolSession prefix Mod-k , → settings.show",
      "toolSession direct Mod-, → settings.show",
      "toolSession direct Mod-d → pane.splitRight",
      "toolSession direct Mod-Shift-d → pane.splitDown",
    ]);
  });

  it("binds nothing the browser will swallow", () => {
    for (const row of catalogRows()) {
      const key = row
        .split(" → ")[0]!
        .replace(/^toolSession (prefix|direct|context) /, "")
        .replace(/ \[.*\]$/, "");
      assert.equal(isBrowserReservedChord(key), false, row);
    }
  });

  it("documents a reason for every risky direct or context chord", () => {
    for (const binding of [
      ...TOOL_SESSION_DIRECT_BINDINGS,
      ...TOOL_SESSION_CONTEXT_BINDINGS,
    ]) {
      if (isBrowserRiskyChord(binding.key)) {
        assert.ok(binding.riskyReason, binding.key);
      }
    }
  });

  it("uses Mod-k as the shell prefix (⌘K / Ctrl+K)", () => {
    assert.equal(SHELL_PREFIX, "Mod-k");
    assert.equal(isBrowserReservedChord(SHELL_PREFIX), false);
    assert.equal(isBrowserRiskyChord(SHELL_PREFIX), true);
    assert.equal(prefixLiteralByte(SHELL_PREFIX), "\x0b");
    assert.equal(prefixLiteralByte("Ctrl-k"), "\x0b");
    assert.equal(prefixLiteralByte("Ctrl-a"), "\x01");
    assert.equal(prefixLiteralByte("Mod-Shift-p"), null);
  });
});

describe("tool session keydown resolver", () => {
  it("resolves both direct pane split chords", () => {
    const state = createToolSessionKeymapState();
    assert.deepEqual(
      resolveToolSessionKeydown(
        keyEvent({ key: "d", modKey: true }),
        state,
        shellContext,
      ),
      { type: "command", command: "pane.splitRight" },
    );
    assert.deepEqual(
      resolveToolSessionKeydown(
        keyEvent({ key: "D", code: "KeyD", modKey: true, shiftKey: true }),
        state,
        shellContext,
      ),
      { type: "command", command: "pane.splitDown" },
    );
  });

  it("does not steal direct chords from ordinary editable fields", () => {
    assert.equal(
      resolveToolSessionKeydown(
        keyEvent({ key: "d", modKey: true }),
        createToolSessionKeymapState(),
        { ...shellContext, inEditable: true },
      ),
      null,
    );
  });

  it("allows direct pane commands from a terminal surface", () => {
    assert.deepEqual(
      resolveToolSessionKeydown(
        keyEvent({ key: "d", modKey: true }),
        createToolSessionKeymapState(),
        { ...shellContext, inEditable: true, inTerminal: true },
      ),
      { type: "command", command: "pane.splitRight" },
    );
  });

  it("consumes a repeated structural chord without splitting again", () => {
    assert.deepEqual(
      resolveToolSessionKeydown(
        keyEvent({ key: "d", modKey: true, repeat: true }),
        createToolSessionKeymapState(),
        shellContext,
      ),
      { type: "consume" },
    );
  });

  it("keeps a prefix active while focus moves through the HUD", () => {
    const state = createToolSessionKeymapState();
    assert.deepEqual(
      resolveToolSessionKeydown(
        keyEvent({ key: "k", modKey: true }),
        state,
        shellContext,
        100,
      ),
      { type: "prefix-started", prefix: "Mod-k" },
    );
    assert.equal(
      resolveToolSessionKeydown(
        keyEvent({ key: "Tab" }),
        state,
        shellContext,
        101,
      ),
      null,
    );
    assert.equal(state.prefix, "Mod-k");
  });

  it("clears an invalid prefix continuation instead of leaking the key", () => {
    const state = createToolSessionKeymapState();
    resolveToolSessionKeydown(
      keyEvent({ key: "k", modKey: true }),
      state,
      shellContext,
      100,
    );
    assert.deepEqual(
      resolveToolSessionKeydown(
        keyEvent({ key: "q" }),
        state,
        shellContext,
        101,
      ),
      { type: "consume" },
    );
    assert.equal(state.prefix, null);
  });
});
