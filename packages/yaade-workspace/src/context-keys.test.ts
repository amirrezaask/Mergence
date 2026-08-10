import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  keyEventMatchesBinding,
  keyEventMatchesBindingPart,
  isChordBinding,
  parseBindingKey,
  jetKeyToCodeMirrorKey,
  resolveKeydownBinding,
  createChordState,
  isEditorKeyBinding,
} from "./context-keys.js"
import type { KeymapContext } from "./context-keys.js"
import { bind } from "./keymaps.js"
import type { JetKeyBinding } from "./keymaps.js"
import { createDefaultKeybindings } from "./default-keybindings.js"

function keyEvent(init: {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  code?: string
}): KeyboardEvent {
  return {
    key: init.key,
    code: init.code ?? init.key,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
  } as KeyboardEvent
}

const baseCtx: KeymapContext = {
  editorFocus: true,
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
  terminalFocus: false,
  listFocus: false,
}

describe("keyEventMatchesBindingPart", () => {
  it("matches Cmd-f", () => {
    assert.equal(keyEventMatchesBindingPart(keyEvent({ key: "f", metaKey: true }), "Cmd-f"), true)
  })

  it("matches Ctrl-g without meta", () => {
    assert.equal(keyEventMatchesBindingPart(keyEvent({ key: "g", ctrlKey: true }), "Ctrl-g"), true)
    assert.equal(
      keyEventMatchesBindingPart(keyEvent({ key: "g", metaKey: true, ctrlKey: true }), "Ctrl-g"),
      false,
    )
  })

  it("rejects Cmd-g for Ctrl-g binding", () => {
    assert.equal(keyEventMatchesBindingPart(keyEvent({ key: "g", metaKey: true }), "Ctrl-g"), false)
  })

  it("matches Cmd-Alt-f", () => {
    assert.equal(
      keyEventMatchesBindingPart(keyEvent({ key: "f", metaKey: true, altKey: true }), "Cmd-Alt-f"),
      true,
    )
  })

  it("matches Ctrl-backquote", () => {
    assert.equal(
      keyEventMatchesBindingPart(keyEvent({ key: "`", ctrlKey: true, code: "Backquote" }), "Ctrl-`"),
      true,
    )
  })

  it("matches Cmd-- (zoom out minus key)", () => {
    assert.equal(
      keyEventMatchesBindingPart(keyEvent({ key: "-", metaKey: true, code: "Minus" }), "Cmd--"),
      true,
    )
    assert.equal(
      keyEventMatchesBindingPart(keyEvent({ key: "Minus", metaKey: true, code: "Minus" }), "Cmd--"),
      true,
    )
  })

  it("matches Mod-backslash", () => {
    const mac = process.platform === "darwin"
    assert.equal(
      keyEventMatchesBindingPart(
        keyEvent({ key: "\\", metaKey: mac, ctrlKey: !mac, code: "Backslash" }),
        "Mod-\\",
      ),
      true,
    )
    assert.equal(
      keyEventMatchesBindingPart(
        keyEvent({
          key: "\\",
          metaKey: mac,
          ctrlKey: !mac,
          shiftKey: true,
          code: "Backslash",
        }),
        "Mod-Shift-\\",
      ),
      true,
    )
  })

  it("Mod uses platform primary modifier", () => {
    const mac = process.platform === "darwin"
    assert.equal(
      keyEventMatchesBindingPart(
        keyEvent({ key: "n", metaKey: true, ctrlKey: false }),
        "Mod-n",
      ),
      mac,
    )
    assert.equal(
      keyEventMatchesBindingPart(
        keyEvent({ key: "n", metaKey: false, ctrlKey: true }),
        "Mod-n",
      ),
      !mac,
    )
  })
})

describe("keyEventMatchesBinding", () => {
  it("rejects chord strings as single binding", () => {
    assert.equal(keyEventMatchesBinding(keyEvent({ key: "k", metaKey: true }), "Cmd-k Cmd-o"), false)
  })
})

describe("isChordBinding", () => {
  it("detects chords", () => {
    assert.equal(isChordBinding("Cmd-k Cmd-o"), true)
    assert.equal(isChordBinding("Cmd-p"), false)
  })
})

describe("jetKeyToCodeMirrorKey", () => {
  it("maps Cmd and Ctrl modifiers", () => {
    assert.equal(jetKeyToCodeMirrorKey("Cmd-f"), "Mod-f")
    assert.equal(jetKeyToCodeMirrorKey("Ctrl-g"), "Ctrl-g")
    assert.equal(jetKeyToCodeMirrorKey("Cmd-k Cmd-o"), null)
    assert.equal(jetKeyToCodeMirrorKey("Ctrl-Shift-ArrowUp"), "Ctrl-Shift-ArrowUp")
    assert.equal(jetKeyToCodeMirrorKey("Ctrl-Cmd-g"), "Mod-Ctrl-g")
  })
})

describe("resolveKeydownBinding", () => {
  const openFolder = () => {}

  it("starts chord on first key", () => {
    const chordState = createChordState()
    const bindings: JetKeyBinding[] = [bind("Cmd-k Cmd-o", openFolder)]
    const result = resolveKeydownBinding(
      keyEvent({ key: "k", metaKey: true }),
      bindings,
      baseCtx,
      chordState,
    )
    assert.equal(result, "chord-started")
    assert.equal(chordState.prefix, "Cmd-k")
  })

  it("completes chord on second key", () => {
    const chordState = createChordState()
    chordState.prefix = "Cmd-k"
    chordState.expiresAt = Date.now() + 5000
    const bindings: JetKeyBinding[] = [bind("Cmd-k Cmd-o", openFolder)]
    const result = resolveKeydownBinding(
      keyEvent({ key: "o", metaKey: true }),
      bindings,
      baseCtx,
      chordState,
    )
    assert.notEqual(result, "chord-started")
    assert.notEqual(result, null)
    if (result && result !== "chord-started") {
      assert.equal(result.run, openFolder)
    }
  })

  it("completes editor chord when editor is focused", () => {
    const skip = () => {}
    const editorCtx: KeymapContext = { ...baseCtx, editorFocus: true }
    const chordState = createChordState()
    chordState.prefix = "Cmd-k"
    chordState.expiresAt = Date.now() + 5000
    const bindings: JetKeyBinding[] = [
      bind("Cmd-k Cmd-d", skip, ctx => ctx.editorFocus),
    ]
    const result = resolveKeydownBinding(
      keyEvent({ key: "d", metaKey: true }),
      bindings,
      editorCtx,
      chordState,
    )
    assert.notEqual(result, null)
    if (result && result !== "chord-started") {
      assert.equal(result.run, skip)
    }
  })
})

describe("parseBindingKey", () => {
  it("splits chord parts", () => {
    assert.deepEqual(parseBindingKey("Cmd-k Cmd-o"), ["Cmd-k", "Cmd-o"])
  })
})

describe("isEditorKeyBinding", () => {
  const noop = () => {}
  const cmds = {
    quickOpen: noop,
    palette: noop,
    find: noop,
  }

  it("treats Cmd-p as shell binding", () => {
    const bindings = createDefaultKeybindings(cmds as never)
    const quickOpen = bindings.find(b => b.key === "Cmd-p")
    assert.ok(quickOpen)
    assert.equal(isEditorKeyBinding(quickOpen!, baseCtx), false)
  })

  it("treats Cmd-Shift-p as shell binding", () => {
    const bindings = createDefaultKeybindings(cmds as never)
    const palette = bindings.find(b => b.key === "Cmd-Shift-p")
    assert.ok(palette)
    assert.equal(isEditorKeyBinding(palette!, baseCtx), false)
  })

  it("treats Cmd-f as editor binding", () => {
    const bindings = createDefaultKeybindings(cmds as never)
    const find = bindings.find(b => b.key === "Cmd-f")
    assert.ok(find)
    assert.equal(isEditorKeyBinding(find!, baseCtx), true)
  })
})
