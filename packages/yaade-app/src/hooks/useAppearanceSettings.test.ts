import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  normalizeColorSchemeMode,
  normalizePreferredEditor,
  normalizeThemeId,
  themeIdForColorSchemeMode,
} from "./useAppearanceSettings.js"

describe("normalizeThemeId", () => {
  it("migrates persisted legacy themes to their Default scheme", () => {
    for (const id of ["catppuccin-latte", "tokyonight-day"]) {
      assert.equal(normalizeThemeId(id), "default-light")
    }
    for (const id of [
      "catppuccin-mocha",
      "catppuccin-macchiato",
      "tokyonight-night",
      "tokyonight-storm",
    ]) {
      assert.equal(normalizeThemeId(id), "default-dark")
    }
  })

  it("uses the stored scheme for unknown ids", () => {
    assert.equal(normalizeThemeId("removed-theme", "light"), "default-light")
    assert.equal(normalizeThemeId("removed-theme", "dark"), "default-dark")
  })
})

describe("preferred editor", () => {
  it("normalizes monaco and neovim", () => {
    assert.equal(normalizePreferredEditor("monaco"), "monaco")
    assert.equal(normalizePreferredEditor("neovim"), "neovim")
    assert.equal(normalizePreferredEditor("vim", "neovim"), "neovim")
    assert.equal(normalizePreferredEditor(undefined), "monaco")
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
