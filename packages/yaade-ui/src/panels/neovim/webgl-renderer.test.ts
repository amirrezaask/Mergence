import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { defaultYaadeTheme } from "@yaade/shared"
import { resolveNeovimHighlightColors } from "./webgl-renderer.js"

function rounded(values: readonly number[]): number[] {
  return values.map(value => Math.round(value * 255))
}

describe("Neovim highlight color resolution", () => {
  it("honors Neovim RGB and only uses the theme when a color is missing", () => {
    const normal = resolveNeovimHighlightColors({
      groupName: "Normal",
      foreground: 0x9cc7ff,
      background: 0x10151f,
    }, defaultYaadeTheme)
    const string = resolveNeovimHighlightColors({
      groupName: "String",
      foreground: 0x79d6b2,
      background: 0x10151f,
      italic: true,
    }, defaultYaadeTheme)
    assert.deepEqual(rounded(normal.foreground), [0x9c, 0xc7, 0xff, 0xff])
    assert.deepEqual(rounded(normal.background), [0x10, 0x15, 0x1f, 0xff])
    assert.deepEqual(rounded(string.foreground), [0x79, 0xd6, 0xb2, 0xff])
    assert.deepEqual(rounded(string.background), [0x10, 0x15, 0x1f, 0xff])

    const fromDefaults = resolveNeovimHighlightColors(
      { groupName: "Comment" },
      defaultYaadeTheme,
      { foreground: 0x112233, background: 0x445566 },
    )
    assert.deepEqual(rounded(fromDefaults.foreground), [0x11, 0x22, 0x33, 0xff])
    assert.deepEqual(rounded(fromDefaults.background), [0x44, 0x55, 0x66, 0xff])

    const fallback = resolveNeovimHighlightColors(undefined, defaultYaadeTheme)
    const themed = resolveNeovimHighlightColors({
      foreground: defaultYaadeTheme.colors.text.startsWith("#")
        ? Number.parseInt(defaultYaadeTheme.colors.text.slice(1), 16)
        : undefined,
      background: defaultYaadeTheme.colors.bg.startsWith("#")
        ? Number.parseInt(defaultYaadeTheme.colors.bg.slice(1), 16)
        : undefined,
    }, defaultYaadeTheme)
    assert.deepEqual(rounded(fallback.foreground), rounded(themed.foreground))
    assert.deepEqual(rounded(fallback.background), rounded(themed.background))
  })

  it("preserves explicit colors for unrecognized plugin groups", () => {
    const plugin = resolveNeovimHighlightColors({
      groupName: "MyPluginPrivateGroup",
      foreground: 0x112233,
      background: 0x445566,
    }, defaultYaadeTheme)
    assert.deepEqual(rounded(plugin.foreground), [0x11, 0x22, 0x33, 0xff])
    assert.deepEqual(rounded(plugin.background), [0x44, 0x55, 0x66, 0xff])
  })

  it("swaps colors for reverse highlights", () => {
    const reversed = resolveNeovimHighlightColors({
      foreground: 0xff0000,
      background: 0x00ff00,
      reverse: true,
    }, defaultYaadeTheme)
    assert.deepEqual(rounded(reversed.foreground), [0x00, 0xff, 0x00, 0xff])
    assert.deepEqual(rounded(reversed.background), [0xff, 0x00, 0x00, 0xff])
  })
})
