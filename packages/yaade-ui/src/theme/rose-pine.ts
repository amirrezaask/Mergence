import type { YaadeSemanticTokens, YaadeTheme } from "@yaade/shared"
import { makeTheme, paletteAnsi, paletteHighlights } from "./theme-palette.js"

type RosePinePalette = {
  base: string
  surface: string
  overlay: string
  muted: string
  subtle: string
  text: string
  love: string
  gold: string
  rose: string
  pine: string
  foam: string
  iris: string
  highlightLow: string
  highlightMed: string
  highlightHigh: string
  backdrop: string
}

const sourceUrl = "https://github.com/rose-pine/rose-pine-theme"

function semanticTokens(palette: RosePinePalette): YaadeSemanticTokens {
  return {
    background: palette.base,
    foreground: palette.text,
    card: palette.surface,
    cardForeground: palette.text,
    popover: palette.surface,
    popoverForeground: palette.text,
    primary: palette.rose,
    primaryForeground: palette.base,
    secondary: palette.overlay,
    secondaryForeground: palette.text,
    muted: palette.surface,
    mutedForeground: palette.subtle,
    accent: palette.highlightMed,
    accentForeground: palette.text,
    destructive: palette.love,
    destructiveForeground: palette.base,
    success: palette.foam,
    successForeground: palette.base,
    warning: palette.gold,
    warningForeground: palette.base,
    info: palette.pine,
    infoForeground: palette.base,
    backdrop: palette.backdrop,
    gitAdded: palette.foam,
    gitAddedForeground: palette.base,
    gitModified: palette.rose,
    gitModifiedForeground: palette.base,
    gitDeleted: palette.love,
    gitDeletedForeground: palette.base,
    gitConflict: palette.gold,
    gitConflictForeground: palette.base,
    border: palette.highlightHigh,
    input: palette.subtle,
    ring: palette.iris,
    sidebar: palette.base,
    sidebarForeground: palette.text,
    sidebarPrimary: palette.rose,
    sidebarPrimaryForeground: palette.base,
    sidebarAccent: palette.highlightLow,
    sidebarAccentForeground: palette.text,
    sidebarBorder: palette.highlightHigh,
    sidebarRing: palette.iris,
  }
}

function rosePineTheme(input: {
  id: string
  name: string
  scheme: "dark" | "light"
  palette: RosePinePalette
}): YaadeTheme {
  const { palette } = input
  return makeTheme({
    id: input.id,
    name: input.name,
    family: "Rosé Pine",
    scheme: input.scheme,
    sourceName: "Rosé Pine",
    sourceUrl,
    license: "MIT",
    tokens: semanticTokens(palette),
    terminal: {
      background: palette.base,
      foreground: palette.text,
      cursor: palette.muted,
      selectionBackground: palette.highlightMed,
    },
    highlights: paletteHighlights({
      keyword: palette.pine,
      controlKeyword: palette.pine,
      function: palette.love,
      type: palette.foam,
      string: palette.gold,
      number: palette.rose,
      boolean: palette.rose,
      comment: palette.muted,
      operator: palette.pine,
      variable: palette.text,
      attribute: palette.iris,
      constant: palette.pine,
      field: palette.rose,
      module: palette.foam,
      label: palette.iris,
    }),
    terminalAnsi: paletteAnsi({
      black: palette.overlay,
      red: palette.love,
      green: palette.pine,
      yellow: palette.gold,
      blue: palette.foam,
      magenta: palette.iris,
      cyan: palette.rose,
      white: palette.text,
      brightBlack: palette.subtle,
      brightRed: palette.love,
      brightGreen: palette.pine,
      brightYellow: palette.gold,
      brightBlue: palette.foam,
      brightMagenta: palette.iris,
      brightCyan: palette.rose,
      brightWhite: palette.text,
    }),
  })
}

const main = rosePineTheme({
  id: "rose-pine",
  name: "Rosé Pine",
  scheme: "dark",
  palette: {
    base: "#191724",
    surface: "#1f1d2e",
    overlay: "#26233a",
    muted: "#6e6a86",
    subtle: "#908caa",
    text: "#e0def4",
    love: "#eb6f92",
    gold: "#f6c177",
    rose: "#ebbcba",
    pine: "#31748f",
    foam: "#9ccfd8",
    iris: "#c4a7e7",
    highlightLow: "#21202e",
    highlightMed: "#403d52",
    highlightHigh: "#524f67",
    backdrop: "rgba(25, 23, 36, 0.78)",
  },
})

const moon = rosePineTheme({
  id: "rose-pine-moon",
  name: "Rosé Pine Moon",
  scheme: "dark",
  palette: {
    base: "#232136",
    surface: "#2a273f",
    overlay: "#393552",
    muted: "#6e6a86",
    subtle: "#908caa",
    text: "#e0def4",
    love: "#eb6f92",
    gold: "#f6c177",
    rose: "#ea9a97",
    pine: "#3e8fb0",
    foam: "#9ccfd8",
    iris: "#c4a7e7",
    highlightLow: "#2a283e",
    highlightMed: "#44415a",
    highlightHigh: "#56526e",
    backdrop: "rgba(35, 33, 54, 0.78)",
  },
})

const dawn = rosePineTheme({
  id: "rose-pine-dawn",
  name: "Rosé Pine Dawn",
  scheme: "light",
  palette: {
    base: "#faf4ed",
    surface: "#fffaf3",
    overlay: "#f2e9e1",
    muted: "#9893a5",
    subtle: "#797593",
    text: "#575279",
    love: "#b4637a",
    gold: "#ea9d34",
    rose: "#d7827e",
    pine: "#286983",
    foam: "#56949f",
    iris: "#907aa9",
    highlightLow: "#f4ede8",
    highlightMed: "#dfdad9",
    highlightHigh: "#cecacd",
    backdrop: "rgba(87, 82, 121, 0.32)",
  },
})

export const rosePineThemes = {
  [main.id]: main,
  [moon.id]: moon,
  [dawn.id]: dawn,
}

export const rosePineThemeList = [main, moon, dawn]
