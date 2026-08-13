import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { toSrgbColor } from "@yaade/shared"
import {
  bundledThemeList,
  bundledThemes,
  defaultThemeId,
  defaultThemeIdForScheme,
  getThemeById,
  siblingThemeForScheme,
  themePreviewSwatches,
} from "./default.js"

type Rgb = readonly [number, number, number]

function oklchToSrgb(value: string): Rgb {
  const match = value.match(
    /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*[\d.]+%?)?\)$/,
  )
  assert.ok(match, `expected an opaque oklch color, received ${value}`)
  const lightness = Number(match[1])
  const chroma = Number(match[2])
  const hue = Number(match[3]) * (Math.PI / 180)
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ] as const
  return linear.map(channel => {
    const encoded =
      channel <= 0.0031308
        ? 12.92 * channel
        : 1.055 * channel ** (1 / 2.4) - 0.055
    return Math.max(0, Math.min(1, encoded))
  }) as unknown as Rgb
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (value: string) =>
    oklchToSrgb(value)
      .map(channel =>
        channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4,
      )
      .reduce(
        (sum, channel, index) =>
          sum + channel * ([0.2126, 0.7152, 0.0722] as const)[index]!,
        0,
      )
  const foregroundLuminance = luminance(foreground)
  const backgroundLuminance = luminance(background)
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  )
}

const themeIds = [
  "default-dark",
  "default-light",
  "catppuccin-mocha",
  "catppuccin-macchiato",
  "catppuccin-frappe",
  "catppuccin-latte",
  "tokyonight-night",
  "tokyonight-storm",
  "tokyonight-moon",
  "tokyonight-day",
  "rose-pine",
  "rose-pine-moon",
  "rose-pine-dawn",
  "ayu-dark",
  "ayu-mirage",
  "ayu-light",
]

describe("bundled Yaade themes", () => {
  it("registers every bundled palette flavor", () => {
    assert.equal(defaultThemeId, "default-dark")
    assert.deepEqual(
      bundledThemeList.map(theme => theme.id),
      themeIds,
    )
    assert.equal(Object.keys(bundledThemes).length, themeIds.length)
  })

  it("falls back to Default Dark for missing or invalid theme ids", () => {
    assert.equal(getThemeById(null).id, "default-dark")
    assert.equal(getThemeById("missing").id, "default-dark")
    assert.equal(getThemeById("glass-blue").id, "default-dark")
    assert.equal(getThemeById("ayu-dark").id, "ayu-dark")
  })

  it("maps color schemes to matching Default themes", () => {
    assert.equal(defaultThemeIdForScheme("dark"), "default-dark")
    assert.equal(defaultThemeIdForScheme("light"), "default-light")
    assert.equal(siblingThemeForScheme("default-dark", "light").id, "default-light")
    assert.equal(siblingThemeForScheme("default-light", "dark").id, "default-dark")
    assert.equal(siblingThemeForScheme("catppuccin-mocha", "light").id, "catppuccin-latte")
    assert.equal(siblingThemeForScheme("catppuccin-latte", "dark").id, "catppuccin-mocha")
    assert.equal(siblingThemeForScheme("tokyonight-night", "light").id, "tokyonight-day")
    assert.equal(siblingThemeForScheme("rose-pine", "light").id, "rose-pine-dawn")
    assert.equal(siblingThemeForScheme("ayu-dark", "light").id, "ayu-light")
  })

  it("uses official palette values across shell, Git, Monaco, and terminal tokens", () => {
    const catppuccin = getThemeById("catppuccin-mocha")
    assert.equal(catppuccin.tokens.background, "#1e1e2e")
    assert.equal(catppuccin.highlights.keyword, "#cba6f7")
    assert.equal(catppuccin.terminal?.cursor, "#f5e0dc")
    assert.equal(catppuccin.terminalAnsi?.red, "#f38ba8")

    const tokyo = getThemeById("tokyonight-night")
    assert.equal(tokyo.tokens.background, "#1a1b26")
    assert.equal(tokyo.tokens.gitAdded, "#41a6b5")
    assert.equal(tokyo.highlights.function, "#7aa2f7")
    assert.equal(tokyo.terminal?.background, "#16161e")
    assert.equal(tokyo.terminalAnsi?.cyan, "#7dcfff")

    const rosePine = getThemeById("rose-pine")
    assert.equal(rosePine.tokens.background, "#191724")
    assert.equal(rosePine.tokens.gitDeleted, "#eb6f92")
    assert.equal(rosePine.highlights.string, "#f6c177")
    assert.equal(rosePine.terminal?.background, "#191724")
    assert.equal(rosePine.terminalAnsi?.magenta, "#c4a7e7")

    const ayu = getThemeById("ayu-mirage")
    assert.equal(ayu.tokens.background, "#242936")
    assert.equal(ayu.tokens.gitModified, "#73d0ff")
    assert.equal(ayu.highlights.keyword, "#ffa659")
    assert.equal(ayu.terminal?.background, "#1f2430")
    assert.equal(ayu.terminalAnsi?.yellow, "#ffcd66")
  })

  it("provides shell, editor, terminal, source, and swatch metadata for every theme", () => {
    for (const theme of bundledThemeList) {
      assert.ok(theme.scheme === "dark" || theme.scheme === "light")
      assert.ok(theme.family)
      assert.ok(theme.sourceUrl?.startsWith("https://"))
      assert.ok(theme.colors.bg)
      assert.ok(theme.colors.panel)
      assert.ok(theme.highlights.keyword)
      assert.ok(theme.highlights.string)
      assert.ok(theme.terminalAnsi?.red)
      assert.ok(theme.terminalAnsi?.brightWhite)
      assert.match(theme.terminalAnsi!.red, /^#[\da-f]{6}$/i)
      assert.match(theme.highlights.keyword, /^#[\da-f]{6}$/i)
      assert.ok(themePreviewSwatches(theme).length >= 4)
      assert.ok(theme.tokens)
      assert.deepEqual(
        Object.keys(theme.tokens).sort(),
        Object.keys(getThemeById("default-dark").tokens).sort(),
      )
    }
  })

  it("keeps both Default palettes readable and interaction colors consistent", () => {
    for (const themeId of ["default-dark", "default-light"]) {
      const theme = getThemeById(themeId)
      const tokens = theme.tokens

      const textPairs = [
        ["foreground", tokens.foreground, tokens.background, 7],
        ["muted", tokens.mutedForeground, tokens.background, 4.5],
        ["primary", tokens.primaryForeground, tokens.primary, 4.5],
        ["accent", tokens.accentForeground, tokens.accent, 4.5],
        [
          "destructive",
          tokens.destructiveForeground,
          tokens.destructive,
          4.5,
        ],
        ["success", tokens.successForeground, tokens.success, 4.5],
        ["warning", tokens.warningForeground, tokens.warning, 4.5],
        ["info", tokens.infoForeground, tokens.info, 4.5],
        ["git added", tokens.gitAddedForeground, tokens.gitAdded, 4.5],
        ["git modified", tokens.gitModifiedForeground, tokens.gitModified, 4.5],
        ["git deleted", tokens.gitDeletedForeground, tokens.gitDeleted, 4.5],
        ["git conflict", tokens.gitConflictForeground, tokens.gitConflict, 4.5],
        ["sidebar", tokens.sidebarForeground, tokens.sidebar, 7],
        [
          "sidebar primary",
          tokens.sidebarPrimaryForeground,
          tokens.sidebarPrimary,
          4.5,
        ],
        [
          "sidebar accent",
          tokens.sidebarAccentForeground,
          tokens.sidebarAccent,
          4.5,
        ],
      ] as const
      for (const [name, foreground, background, minimum] of textPairs) {
        assert.ok(
          contrastRatio(foreground, background) >= minimum,
          `${themeId} ${name} contrast must be at least ${minimum}:1`,
        )
      }

      assert.ok(
        contrastRatio(tokens.ring, tokens.background) >= 3,
        `${themeId} focus ring must have at least 3:1 contrast`,
      )
      assert.ok(
        contrastRatio(tokens.input, tokens.background) >= 3,
        `${themeId} input boundary must have at least 3:1 contrast`,
      )
      assert.equal(tokens.primary, tokens.sidebarPrimary)
      assert.equal(tokens.ring, tokens.primary)
      assert.equal(tokens.sidebarRing, tokens.primary)
      assert.notEqual(tokens.card, tokens.background)
      // Soft graphite / zinc stack: sidebar sits near the canvas, not a pure-black well.
      const parseLightness = (value: string) => {
        const match = value.match(/^oklch\(([\d.]+)/)
        assert.ok(match, `expected oklch lightness in ${value}`)
        return Number(match[1])
      }
      const bgL = parseLightness(tokens.background)
      const sidebarL = parseLightness(tokens.sidebar)
      const cardL = parseLightness(tokens.card)
      assert.ok(
        Math.abs(sidebarL - bgL) <= 0.04,
        `${themeId} sidebar/background ΔL must stay ≤ 0.04 (got ${Math.abs(sidebarL - bgL).toFixed(3)})`,
      )
      assert.ok(
        Math.abs(cardL - bgL) <= 0.05,
        `${themeId} card/background ΔL must stay ≤ 0.05 (got ${Math.abs(cardL - bgL).toFixed(3)})`,
      )
      assert.equal(theme.colors.bg, toSrgbColor(tokens.background))
      assert.equal(theme.colors.panelRaised, toSrgbColor(tokens.card))
      assert.equal(theme.colors.error, toSrgbColor(tokens.destructive))
      assert.equal(theme.colors.warning, toSrgbColor(tokens.warning))
      assert.equal(theme.colors.success, toSrgbColor(tokens.success))
    }
  })
})
