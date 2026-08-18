import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  findReservedBindings,
  isBrowserReservedChord,
  isBrowserRiskyChord,
} from "./browser-reserved-keys.js"
import { KeymapService, bind } from "./keymaps.js"

describe("isBrowserReservedChord", () => {
  it("flags chords the browser consumes before the page", () => {
    for (const key of [
      "Mod-t",
      "Mod-n",
      "Mod-w",
      "Mod-l",
      "Mod-1",
      "Mod-Shift-t",
      "Mod-Alt-ArrowLeft",
      "Mod-Alt-ArrowRight",
      "Mod-=",
      "Mod-Shift-=",
      "Mod--",
      "Mod-Shift--",
      "F12",
    ]) {
      assert.equal(isBrowserReservedChord(key), true, key)
    }
  })

  it("leaves app-owned chords alone", () => {
    for (const key of ["Mod-Shift-p", "Mod-,", "Ctrl-a", "Alt-j", "Escape"]) {
      assert.equal(isBrowserReservedChord(key), false, key)
    }
  })

  it("allows reserved keys as the tail of a prefix chord", () => {
    // The browser never sees a bare `t` after `Mod-k` opened the namespace.
    assert.equal(isBrowserReservedChord("Mod-k t"), false)
    assert.equal(isBrowserReservedChord("Mod-k w"), false)
    assert.equal(isBrowserReservedChord("Mod-k -"), false)
    assert.equal(isBrowserReservedChord("Ctrl-a t"), false)
  })

  it("still flags a chord whose prefix is itself reserved", () => {
    assert.equal(isBrowserReservedChord("Mod-t x"), true)
  })

  it("normalizes modifier order and key case", () => {
    assert.equal(isBrowserReservedChord("Shift-Mod-T"), true)
  })
})

describe("isBrowserRiskyChord", () => {
  it("separates cross-browser collisions from hard reservations", () => {
    assert.equal(isBrowserRiskyChord("Mod-k"), true)
    assert.equal(isBrowserRiskyChord("Mod-d"), true)
    assert.equal(isBrowserRiskyChord("Mod-Shift-d"), true)
    assert.equal(isBrowserReservedChord("Mod-k"), false)
  })
})

describe("findReservedBindings", () => {
  it("returns offending keys in registration order", () => {
    assert.deepEqual(
      findReservedBindings([
        { key: "Mod-Shift-p" },
        { key: "Mod-w" },
        { key: "Ctrl-a z" },
        { key: "Mod-t" },
      ]),
      ["Mod-w", "Mod-t"],
    )
  })
})

describe("KeymapService reserved-chord guard", () => {
  it("rejects reserved chords instead of registering a silent no-op", () => {
    const keymaps = new KeymapService()
    assert.throws(
      () => keymaps.registerUser([bind("Mod-w", () => {})]),
      /browser-reserved/,
    )
  })

  it("accepts prefix chords built from reserved keys", () => {
    const keymaps = new KeymapService()
    keymaps.registerUser([bind("Ctrl-a t", () => {})])
    assert.equal(keymaps.allBindings().length, 1)
  })
})
