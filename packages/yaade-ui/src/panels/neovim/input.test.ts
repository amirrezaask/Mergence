import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { encodeNeovimKey, encodeNeovimText } from "./input.js"

const key = (value: string, modifiers: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({
  key: value,
  isComposing: false,
  ctrlKey: modifiers.ctrlKey ?? false,
  altKey: modifiers.altKey ?? false,
  metaKey: modifiers.metaKey ?? false,
  shiftKey: modifiers.shiftKey ?? false,
})

describe("Neovim input notation", () => {
  it("leaves printable Unicode for the textarea input event", () => {
    assert.deepEqual(encodeNeovimKey(key("λ")), { kind: "input" })
    assert.deepEqual(encodeNeovimKey(key("<")), { kind: "input" })
    assert.equal(encodeNeovimText("a<b"), "a<LT>b")
  })

  it("encodes navigation, editing, and function keys", () => {
    const cases: readonly [string, string][] = [
      ["Escape", "<Esc>"],
      ["Enter", "<CR>"],
      ["Tab", "<Tab>"],
      ["Backspace", "<BS>"],
      ["Delete", "<Del>"],
      ["Insert", "<Insert>"],
      ["ArrowUp", "<Up>"],
      ["ArrowDown", "<Down>"],
      ["ArrowLeft", "<Left>"],
      ["ArrowRight", "<Right>"],
      ["Home", "<Home>"],
      ["End", "<End>"],
      ["PageUp", "<PageUp>"],
      ["PageDown", "<PageDown>"],
      ["F1", "<F1>"],
      ["F10", "<F10>"],
    ]
    for (const [browserKey, notation] of cases) {
      assert.deepEqual(encodeNeovimKey(key(browserKey)), { kind: "input", value: notation })
    }
  })

  it("encodes modifier combinations without stealing plain printable input", () => {
    assert.deepEqual(encodeNeovimKey(key("Tab", { shiftKey: true })), { kind: "input", value: "<S-Tab>" })
    assert.deepEqual(encodeNeovimKey(key("c", { ctrlKey: true })), { kind: "input", value: "<C-c>" })
    assert.deepEqual(encodeNeovimKey(key("x", { altKey: true })), { kind: "input", value: "<M-x>" })
    assert.deepEqual(encodeNeovimKey(key("<", { metaKey: true })), { kind: "input", value: "<D-LT>" })
    assert.deepEqual(encodeNeovimKey(key("v", { ctrlKey: true })), { kind: "input", value: "<C-v>" })
  })

  it("keeps AltGraph and macOS Option printable text on the input path", () => {
    assert.deepEqual(encodeNeovimKey({ ...key("@", { ctrlKey: true, altKey: true }), altGraphKey: true }), { kind: "input" })
    assert.deepEqual(encodeNeovimKey({ ...key("å", { altKey: true }), platform: "MacIntel" }), { kind: "input" })
    assert.deepEqual(encodeNeovimKey(key("x", { ctrlKey: true, altKey: true })), { kind: "input", value: "<C-M-x>" })
  })

  it("does not steal browser fullscreen or developer-tool actions", () => {
    assert.deepEqual(encodeNeovimKey(key("F11")), { kind: "browser-action" })
    assert.deepEqual(encodeNeovimKey(key("F12")), { kind: "browser-action" })
  })
})
