import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  createChordState,
  isBrowserReservedChord,
  keyEventMatchesBindingPart,
  resolveKeydownBinding,
  type JetKeyBinding,
  type KeymapContext,
} from "@yaade/workspace"
import {
  MUX_DIRECT_BINDINGS,
  MUX_PREFIX,
  MUX_PREFIX_BINDINGS,
  muxPrefixBindingKey,
  prefixLiteralByte,
} from "./mux-keymap.js"

const terminalContext: KeymapContext = {
  editorFocus: false,
  paletteOpen: false,
  quickOpenOpen: false,
  bufferListOpen: false,
  openFileOpen: false,
  cdOpen: false,
  projectSwitcherOpen: false,
  gotoLineOpen: false,
  outlineOpen: false,
  terminalListOpen: false,
  agentCliPickerOpen: false,
  settingsOpen: false,
  workspaceOpen: true,
  explorerFocus: false,
  terminalExplorerFocus: false,
  outputFocus: false,
  terminalFocus: true,
  listFocus: false,
}

function keyEvent(init: {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}): KeyboardEvent {
  return {
    key: init.key,
    code: init.key,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
  } as KeyboardEvent
}

function muxBindings(): JetKeyBinding[] {
  return [
    ...MUX_DIRECT_BINDINGS.map(b => ({ key: b.key, run: () => {} })),
    ...MUX_PREFIX_BINDINGS.map(b => ({
      key: muxPrefixBindingKey(b.key),
      run: () => {},
    })),
    { key: muxPrefixBindingKey(MUX_PREFIX), run: () => {} },
  ]
}

describe("mux keymap", () => {
  it("binds nothing the browser will swallow", () => {
    for (const binding of muxBindings()) {
      assert.equal(isBrowserReservedChord(binding.key), false, binding.key)
    }
  })

  it("has no duplicate prefix keys", () => {
    const keys = MUX_PREFIX_BINDINGS.map(b => b.key)
    assert.equal(new Set(keys).size, keys.length)
  })

  it("keeps the planned editor-navigation prefix surface stable", () => {
    const planned = new Map(
      MUX_PREFIX_BINDINGS.map(binding => [binding.key, binding.command]),
    )
    assert.deepEqual(
      Object.fromEntries(
        ["f", "/", "b", "e", "o", "r", "[", "]", "s"].map(key => [
          key,
          planned.get(key),
        ]),
      ),
      {
        f: "editor.quickOpen",
        "/": "search.focus",
        b: "buffers.focus",
        e: "explorer.focus",
        o: "outline.focus",
        r: "references.focus",
        "[": "editor.navigateBack",
        "]": "editor.navigateForward",
        s: "editor.save",
      },
    )
  })

  it("does not claim Escape — terminals need it", () => {
    for (const binding of muxBindings()) {
      assert.notEqual(binding.key, "Escape")
    }
  })

  it("resolves the prefix, then the action", () => {
    const bindings = muxBindings()
    const chord = createChordState()

    const prefix = resolveKeydownBinding(
      keyEvent(
        process.platform === "darwin"
          ? { key: "k", metaKey: true }
          : { key: "k", ctrlKey: true },
      ),
      bindings,
      terminalContext,
      chord,
    )
    assert.equal(prefix, "chord-started")

    const action = resolveKeydownBinding(
      keyEvent({ key: "z" }),
      bindings,
      terminalContext,
      chord,
    )
    assert.ok(action !== null && action !== "chord-started")
    assert.equal(action.key, muxPrefixBindingKey("z"))
  })

  it("resolves the action while the prefix modifier is still held", () => {
    const bindings = muxBindings()
    const chord = createChordState()
    const mac = process.platform === "darwin"

    assert.equal(
      resolveKeydownBinding(
        keyEvent(mac ? { key: "k", metaKey: true } : { key: "k", ctrlKey: true }),
        bindings,
        terminalContext,
        chord,
      ),
      "chord-started",
    )

    const action = resolveKeydownBinding(
      keyEvent(mac ? { key: "d", metaKey: true } : { key: "d", ctrlKey: true }),
      bindings,
      terminalContext,
      chord,
    )
    assert.ok(action !== null && action !== "chord-started")
    assert.equal(action.key, muxPrefixBindingKey("d"))
  })

  it("routes a bare action key to the terminal when no prefix is pending", () => {
    const result = resolveKeydownBinding(
      keyEvent({ key: "z" }),
      muxBindings(),
      terminalContext,
      createChordState(),
    )
    assert.equal(result, null)
  })

  it("matches the shifted split-down key", () => {
    assert.equal(
      keyEventMatchesBindingPart(
        keyEvent({ key: "D", shiftKey: true }),
        "Shift-D",
      ),
      true,
    )
    assert.equal(
      keyEventMatchesBindingPart(keyEvent({ key: "d" }), "Shift-D"),
      false,
    )
  })

  it("matches the font-size keys", () => {
    assert.equal(keyEventMatchesBindingPart(keyEvent({ key: "-" }), "-"), true)
    assert.equal(keyEventMatchesBindingPart(keyEvent({ key: "=" }), "="), true)
  })

  it("sends the prefix through on a double tap", () => {
    assert.equal(prefixLiteralByte("Ctrl-a"), "\x01")
    assert.equal(prefixLiteralByte("Ctrl-b"), "\x02")
    assert.equal(prefixLiteralByte("Mod-k"), "\x0b")
    assert.equal(prefixLiteralByte("Mod-Shift-p"), null)
  })

  it("points every entry at a command id", () => {
    for (const b of [...MUX_PREFIX_BINDINGS, ...MUX_DIRECT_BINDINGS]) {
      assert.match(b.command, /^[a-z]+\.[A-Za-z]+$/, b.key)
      assert.ok(b.desc.length > 0, b.key)
    }
  })
})
