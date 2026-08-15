/**
 * Wheel → CSS-pixel delta for Yaade's RAD scroll hijack.
 *
 * Chromium pixel deltas map ~1:1 to `scrollTop`.
 * Apple WebKit:
 * Must read `deltaMode` **before** `deltaY` — WebKit changes delta units
 * based on access order (MDN). Reading `deltaY` first then treating
 * `deltaMode === LINE` multiplies already-pixel values by lineHeight →
 * runaway scroll.
 *
 * Do **not** divide pixel deltas by `devicePixelRatio`. An earlier retina
 * ÷DPR pass over-damped trackpad scroll (~half speed on 2× displays). The
 * runaway was the deltaMode order quirk, not denser CSS pixels. Tune feel
 * with `APPLE_WEBKIT_WHEEL_GAIN` / `webkitGain` if needed.
 */

export function isAppleWebKitEngine(userAgent?: string): boolean {
  const ua = userAgent ?? globalThis.navigator?.userAgent ?? ""
  return /AppleWebKit/i.test(ua) && !/Chrome|Chromium|Edg\//i.test(ua)
}

export type WheelDeltaLike = {
  deltaY: number
  deltaMode: number
}

export type WheelDeltaPixelsOptions = {
  /** Override engine detection (tests). */
  webkitEngine?: boolean
  /**
   * Extra gain on WebKit pixel-mode only.
   * 1 = raw deltaY (default). Raise/lower if trackpad still feels off.
   */
  webkitGain?: number
}

const DOM_DELTA_PIXEL = 0
const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2

/** Default WebKit pixel-mode gain (1 = 1:1 with deltaY). */
export const APPLE_WEBKIT_WHEEL_GAIN = 1

export function wheelDeltaPixels(
  event: WheelDeltaLike,
  lineHeight: number,
  pageHeight: number,
  opts: WheelDeltaPixelsOptions = {},
): number {
  // WebKit: deltaMode MUST be read before deltaY (unit-switching quirk).
  const deltaMode = event.deltaMode
  const deltaY = event.deltaY
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0

  let pixels: number
  if (deltaMode === DOM_DELTA_LINE) {
    pixels = deltaY * Math.max(1, lineHeight)
  } else if (deltaMode === DOM_DELTA_PAGE) {
    pixels = deltaY * Math.max(1, pageHeight)
  } else {
    // DOM_DELTA_PIXEL (0) or unknown — treat as CSS pixels.
    pixels = deltaY
    const webkit = opts.webkitEngine ?? isAppleWebKitEngine()
    if (webkit && deltaMode === DOM_DELTA_PIXEL) {
      const gain = opts.webkitGain ?? APPLE_WEBKIT_WHEEL_GAIN
      pixels = deltaY * gain
    }
  }

  if (!Number.isFinite(pixels) || pixels === 0) return 0
  // One event should not jump more than a viewport — guards WebKit spikes.
  const cap = Math.max(1, pageHeight)
  if (Math.abs(pixels) > cap) {
    pixels = Math.sign(pixels) * cap
  }
  return pixels
}
