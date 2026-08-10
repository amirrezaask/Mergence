import type { YaadeSemanticTokens, YaadeTheme } from "@yaade/shared"
import { makeTheme, paletteAnsi, paletteHighlights } from "./theme-palette.js"

type CatppuccinPalette = {
  base: string
  mantle: string
  crust: string
  text: string
  subtext1: string
  subtext0: string
  overlay2: string
  overlay1: string
  overlay0: string
  surface2: string
  surface1: string
  surface0: string
  rosewater: string
  flamingo: string
  pink: string
  mauve: string
  red: string
  maroon: string
  peach: string
  yellow: string
  green: string
  teal: string
  sky: string
  sapphire: string
  blue: string
  lavender: string
}

const sourceUrl = "https://github.com/catppuccin/catppuccin"

function semanticTokens(
  palette: CatppuccinPalette,
  scheme: "dark" | "light",
): YaadeSemanticTokens {
  const light = scheme === "light"
  const primary = light ? palette.blue : palette.mauve
  const primaryForeground = light ? "#ffffff" : palette.base

  return {
    background: palette.base,
    foreground: palette.text,
    card: light ? palette.mantle : palette.surface0,
    cardForeground: palette.text,
    popover: light ? palette.base : palette.surface1,
    popoverForeground: palette.text,
    primary,
    primaryForeground,
    secondary: light ? palette.crust : palette.surface1,
    secondaryForeground: palette.text,
    muted: light ? palette.mantle : palette.surface0,
    mutedForeground: palette.subtext0,
    accent: light ? palette.surface0 : palette.surface1,
    accentForeground: palette.text,
    destructive: palette.red,
    destructiveForeground: light ? "#ffffff" : palette.base,
    success: palette.green,
    successForeground: palette.base,
    warning: palette.yellow,
    warningForeground: palette.base,
    info: palette.sapphire,
    infoForeground: palette.base,
    backdrop: light ? "rgba(76, 79, 105, 0.42)" : "rgba(17, 17, 27, 0.76)",
    gitAdded: palette.green,
    gitAddedForeground: palette.base,
    gitModified: palette.blue,
    gitModifiedForeground: light ? "#ffffff" : palette.base,
    gitDeleted: palette.red,
    gitDeletedForeground: light ? "#ffffff" : palette.base,
    gitConflict: palette.yellow,
    gitConflictForeground: palette.base,
    border: palette.surface1,
    input: light ? palette.overlay2 : palette.overlay0,
    ring: light ? palette.blue : palette.lavender,
    sidebar: palette.mantle,
    sidebarForeground: palette.text,
    sidebarPrimary: primary,
    sidebarPrimaryForeground: primaryForeground,
    sidebarAccent: light ? palette.crust : palette.surface0,
    sidebarAccentForeground: palette.text,
    sidebarBorder: palette.surface1,
    sidebarRing: light ? palette.blue : palette.lavender,
  }
}

function catppuccinTheme(input: {
  id: string
  name: string
  scheme: "dark" | "light"
  palette: CatppuccinPalette
}): YaadeTheme {
  const { palette, scheme } = input
  return makeTheme({
    id: input.id,
    name: input.name,
    family: "Catppuccin",
    scheme,
    sourceName: "Catppuccin",
    sourceUrl,
    license: "MIT",
    tokens: semanticTokens(palette, scheme),
    highlights: paletteHighlights({
      keyword: palette.mauve,
      controlKeyword: palette.pink,
      function: palette.blue,
      type: palette.yellow,
      string: palette.green,
      number: palette.peach,
      boolean: palette.peach,
      comment: palette.overlay0,
      operator: palette.sky,
      variable: palette.text,
      attribute: palette.teal,
      constant: palette.lavender,
      field: palette.sapphire,
      module: palette.flamingo,
      label: palette.rosewater,
    }),
    terminalAnsi: paletteAnsi({
      black: palette.surface1,
      red: palette.red,
      green: palette.green,
      yellow: palette.yellow,
      blue: palette.blue,
      magenta: palette.mauve,
      cyan: palette.teal,
      white: palette.text,
      brightBlack: palette.overlay0,
      brightRed: palette.red,
      brightGreen: palette.green,
      brightYellow: palette.yellow,
      brightBlue: palette.blue,
      brightMagenta: palette.pink,
      brightCyan: palette.sky,
      brightWhite: palette.text,
    }),
  })
}

// Palette values are the official Catppuccin colors.
const mocha = catppuccinTheme({
  id: "catppuccin-mocha",
  name: "Catppuccin Mocha",
  scheme: "dark",
  palette: {
    rosewater: "#f5e0dc", flamingo: "#f2cdcd", pink: "#f5c2e7", mauve: "#cba6f7",
    red: "#f38ba8", maroon: "#eba0ac", peach: "#fab387", yellow: "#f9e2af",
    green: "#a6e3a1", teal: "#94e2d5", sky: "#89dceb", sapphire: "#74c7ec",
    blue: "#89b4fa", lavender: "#b4befe", text: "#cdd6f4", subtext1: "#bac2de",
    subtext0: "#a6adc8", overlay2: "#9399b2", overlay1: "#7f849c", overlay0: "#6c7086",
    surface2: "#585b70", surface1: "#45475a", surface0: "#313244", base: "#1e1e2e",
    mantle: "#181825", crust: "#11111b",
  },
})

const macchiato = catppuccinTheme({
  id: "catppuccin-macchiato",
  name: "Catppuccin Macchiato",
  scheme: "dark",
  palette: {
    rosewater: "#f4dbd6", flamingo: "#f0c6c6", pink: "#f5bde6", mauve: "#c6a0f6",
    red: "#ed8796", maroon: "#ee99a0", peach: "#f5a97f", yellow: "#eed49f",
    green: "#a6da95", teal: "#8bd5ca", sky: "#91d7e3", sapphire: "#7dc4e4",
    blue: "#8aadf4", lavender: "#b7bdf8", text: "#cad3f5", subtext1: "#b8c0e0",
    subtext0: "#a5adcb", overlay2: "#939ab7", overlay1: "#8087a2", overlay0: "#6e738d",
    surface2: "#5b6078", surface1: "#494d64", surface0: "#363a4f", base: "#24273a",
    mantle: "#1e2030", crust: "#181926",
  },
})

const frappe = catppuccinTheme({
  id: "catppuccin-frappe",
  name: "Catppuccin Frappé",
  scheme: "dark",
  palette: {
    rosewater: "#f2d5cf", flamingo: "#eebebe", pink: "#f4b8e4", mauve: "#ca9ee6",
    red: "#e78284", maroon: "#ea999c", peach: "#ef9f76", yellow: "#e5c890",
    green: "#a6d189", teal: "#81c8be", sky: "#99d1db", sapphire: "#85c1dc",
    blue: "#8caaee", lavender: "#babbf1", text: "#c6d0f5", subtext1: "#b5bfe2",
    subtext0: "#a5adce", overlay2: "#949cbb", overlay1: "#838ba7", overlay0: "#737994",
    surface2: "#626880", surface1: "#51576d", surface0: "#414559", base: "#303446",
    mantle: "#292c3c", crust: "#232634",
  },
})

const latte = catppuccinTheme({
  id: "catppuccin-latte",
  name: "Catppuccin Latte",
  scheme: "light",
  palette: {
    rosewater: "#dc8a78", flamingo: "#dd7878", pink: "#ea76cb", mauve: "#8839ef",
    red: "#d20f39", maroon: "#e64553", peach: "#fe640b", yellow: "#df8e1d",
    green: "#40a02b", teal: "#179299", sky: "#04a5e5", sapphire: "#209fb5",
    blue: "#1e66f5", lavender: "#7287fd", text: "#4c4f69", subtext1: "#5c5f77",
    subtext0: "#6c6f85", overlay2: "#7c7f93", overlay1: "#8c8fa1", overlay0: "#9ca0b0",
    surface2: "#acb0be", surface1: "#bcc0cc", surface0: "#ccd0da", base: "#eff1f5",
    mantle: "#e6e9ef", crust: "#dce0e8",
  },
})

export const catppuccinThemes = {
  [mocha.id]: mocha,
  [macchiato.id]: macchiato,
  [frappe.id]: frappe,
  [latte.id]: latte,
}

// Keep dark flavors before Latte so Auto mode has stable Mocha ↔ Latte edges.
export const catppuccinThemeList = [mocha, macchiato, frappe, latte]
