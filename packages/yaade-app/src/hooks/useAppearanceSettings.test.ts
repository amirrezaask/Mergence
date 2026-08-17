import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  normalizeColorSchemeMode,
  normalizeInterfaceMaterial,
  normalizeSessionLayout,
  normalizeThemeId,
  themeIdForColorSchemeMode,
} from "./useAppearanceSettings.js"

describe("normalizeThemeId", () => {
  it("keeps every bundled palette family", () => {
    for (const id of [
      "catppuccin-latte",
      "catppuccin-mocha",
      "tokyonight-day",
      "tokyonight-night",
      "tokyonight-moon",
      "rose-pine",
      "rose-pine-dawn",
      "ayu-dark",
      "ayu-light",
    ]) {
      assert.equal(normalizeThemeId(id), id)
    }
  })

  it("uses the stored scheme for unknown ids", () => {
    assert.equal(normalizeThemeId("removed-theme", "light"), "default-light")
    assert.equal(normalizeThemeId("removed-theme", "dark"), "default-dark")
  })
})

describe("interface material", () => {
  it("accepts the named material modes and falls back safely", () => {
    assert.equal(normalizeInterfaceMaterial("liquid-glass"), "liquid-glass")
    assert.equal(normalizeInterfaceMaterial("classic"), "classic")
    assert.equal(normalizeInterfaceMaterial("removed"), "liquid-glass")
    assert.equal(normalizeInterfaceMaterial("removed", "classic"), "classic")
  })
})

describe("session layout", () => {
  it("migrates every stored layout to the top tab bar", () => {
    assert.equal(normalizeSessionLayout("tabs"), "tabs")
    assert.equal(normalizeSessionLayout("two-sidebars"), "tabs")
    assert.equal(normalizeSessionLayout("single-sidebar"), "tabs")
    assert.equal(normalizeSessionLayout("sidebar"), "tabs")
    assert.equal(normalizeSessionLayout("cards"), "tabs")
  })
})

describe("color scheme mode", () => {
  it("normalizes persisted modes", () => {
    assert.equal(normalizeColorSchemeMode("system"), "system")
    assert.equal(normalizeColorSchemeMode("light"), "light")
    assert.equal(normalizeColorSchemeMode("dark"), "dark")
    assert.equal(normalizeColorSchemeMode("removed", "light"), "light")
  })

  it("uses the system scheme only in auto mode", () => {
    assert.equal(
      themeIdForColorSchemeMode("default-dark", "system", "light"),
      "default-light",
    )
    assert.equal(
      themeIdForColorSchemeMode("default-light", "system", "dark"),
      "default-dark",
    )
    assert.equal(
      themeIdForColorSchemeMode("default-dark", "light", "dark"),
      "default-light",
    )
  })
})
