export const DEFAULT_FONT_SIZE = 13
export const FONT_SIZE_STEP = 2
export const MIN_FONT_SIZE = 10
export const MAX_FONT_SIZE = 24

export function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FONT_SIZE
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, value))
}

export function adjustFontSize(value: number, delta: number): number {
  const current = Number.isFinite(value) ? value : DEFAULT_FONT_SIZE
  const change = Number.isFinite(delta) ? delta * FONT_SIZE_STEP : 0
  return clampFontSize(current + change)
}
