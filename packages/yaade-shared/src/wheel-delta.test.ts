import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  APPLE_WEBKIT_WHEEL_GAIN,
  isAppleWebKitEngine,
  wheelDeltaPixels,
} from "./wheel-delta.js"

test("detects Apple WebKit without Chrome/Edge", () => {
  assert.equal(
    isAppleWebKitEngine(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
    ),
    true,
  )
  assert.equal(
    isAppleWebKitEngine(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ),
    false,
  )
})

test("line and page modes scale by metrics on every engine", () => {
  assert.equal(wheelDeltaPixels({ deltaY: 3, deltaMode: 1 }, 20, 800), 60)
  assert.equal(wheelDeltaPixels({ deltaY: -1, deltaMode: 2 }, 20, 800), -800)
})

test("Chromium pixel deltas stay 1:1", () => {
  assert.equal(
    wheelDeltaPixels(
      { deltaY: 720, deltaMode: 0 },
      16,
      800,
      { webkitEngine: false },
    ),
    720,
  )
})

test("WebKit pixel deltas stay 1:1 by default (no DPR divide)", () => {
  assert.equal(
    wheelDeltaPixels(
      { deltaY: 720, deltaMode: 0 },
      16,
      800,
      { webkitEngine: true, webkitGain: APPLE_WEBKIT_WHEEL_GAIN },
    ),
    720,
  )
})

test("WebKit gain scales pixel deltas", () => {
  assert.equal(
    wheelDeltaPixels(
      { deltaY: 720, deltaMode: 0 },
      16,
      800,
      { webkitEngine: true, webkitGain: 0.5 },
    ),
    360,
  )
})

test("caps a single event to one page height", () => {
  assert.equal(
    wheelDeltaPixels(
      { deltaY: 5000, deltaMode: 0 },
      16,
      800,
      { webkitEngine: false },
    ),
    800,
  )
})

test("reads deltaMode before deltaY for WebKit unit-switching quirk", () => {
  const order: string[] = []
  const event = {
    get deltaMode() {
      order.push("mode")
      return 0
    },
    get deltaY() {
      order.push("y")
      return 40
    },
  }
  wheelDeltaPixels(event, 16, 800, { webkitEngine: true })
  assert.deepEqual(order, ["mode", "y"])
})
