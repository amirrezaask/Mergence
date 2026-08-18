import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  adjustFontSize,
  clampFontSize,
  DEFAULT_FONT_SIZE,
  FONT_SIZE_STEP,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
} from "./appearance-zoom.js"
import {
  resolveAppearanceZoomAction,
  type AppearanceZoomAction,
} from "./keybindings.js"

type ZoomEvent = Parameters<typeof resolveAppearanceZoomAction>[0]

function key(init: Partial<ZoomEvent> & Pick<ZoomEvent, "key">): ZoomEvent {
  return {
    key: init.key,
    code: init.code ?? init.key,
    altKey: init.altKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    isComposing: init.isComposing ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
  }
}

describe("appearance zoom shortcuts", () => {
  it("resolves zoom in, zoom out, and reset with either primary modifier", () => {
    const cases: Array<[ZoomEvent, AppearanceZoomAction]> = [
      [key({ key: "=", code: "Equal", metaKey: true }), "in"],
      [key({ key: "+", code: "Equal", metaKey: true, shiftKey: true }), "in"],
      [key({ key: "-", code: "Minus", ctrlKey: true }), "out"],
      [key({ key: "_", code: "Minus", ctrlKey: true, shiftKey: true }), "out"],
      [key({ key: "0", code: "Digit0", metaKey: true }), "reset"],
      [key({ key: "NumpadAdd", code: "NumpadAdd", ctrlKey: true }), "in"],
      [
        key({ key: "NumpadSubtract", code: "NumpadSubtract", ctrlKey: true }),
        "out",
      ],
    ]

    for (const [event, expected] of cases) {
      assert.equal(resolveAppearanceZoomAction(event), expected)
    }
  })

  it("does not steal ordinary terminal or text input keys", () => {
    for (const event of [
      key({ key: "=", code: "Equal" }),
      key({ key: "-", code: "Minus", altKey: true, ctrlKey: true }),
      key({ key: "=", code: "Equal", ctrlKey: true, metaKey: true }),
      key({ key: "0", code: "Digit0", ctrlKey: true, shiftKey: true }),
      key({ key: "=", code: "Equal", ctrlKey: true, isComposing: true }),
    ]) {
      assert.equal(resolveAppearanceZoomAction(event), null)
    }
  })
})

describe("appearance font size", () => {
  it("changes by the configured step and clamps at both bounds", () => {
    assert.equal(FONT_SIZE_STEP, 2)
    assert.equal(adjustFontSize(DEFAULT_FONT_SIZE, 1), 15)
    assert.equal(adjustFontSize(DEFAULT_FONT_SIZE, -1), 11)
    assert.equal(adjustFontSize(MAX_FONT_SIZE, 1), MAX_FONT_SIZE)
    assert.equal(adjustFontSize(MIN_FONT_SIZE, -1), MIN_FONT_SIZE)
    assert.equal(
      adjustFontSize(Number.NaN, 1),
      DEFAULT_FONT_SIZE + FONT_SIZE_STEP,
    )
  })

  it("normalizes invalid and out-of-range settings values", () => {
    assert.equal(clampFontSize(Number.NaN), DEFAULT_FONT_SIZE)
    assert.equal(clampFontSize(Number.POSITIVE_INFINITY), DEFAULT_FONT_SIZE)
    assert.equal(clampFontSize(MIN_FONT_SIZE - 1), MIN_FONT_SIZE)
    assert.equal(clampFontSize(MAX_FONT_SIZE + 1), MAX_FONT_SIZE)
  })
})
