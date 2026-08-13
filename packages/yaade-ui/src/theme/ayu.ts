import type { YaadeSemanticTokens, YaadeTheme } from "@yaade/shared"
import { makeTheme, paletteAnsi, paletteHighlights } from "./theme-palette.js"

type AyuPalette = {
  background: string
  sidebar: string
  card: string
  popover: string
  foreground: string
  muted: string
  border: string
  selection: string
  hover: string
  primary: string
  primaryForeground: string
  red: string
  error: string
  green: string
  yellow: string
  blue: string
  cyan: string
  magenta: string
  purple: string
  orange: string
  field: string
  comment: string
  black: string
  white: string
  brightBlack: string
  brightWhite: string
  backdrop: string
}

const sourceUrl = "https://github.com/ayu-theme/ayu-colors"

function semanticTokens(palette: AyuPalette): YaadeSemanticTokens {
  return {
    background: palette.background,
    foreground: palette.foreground,
    card: palette.card,
    cardForeground: palette.foreground,
    popover: palette.popover,
    popoverForeground: palette.foreground,
    primary: palette.primary,
    primaryForeground: palette.primaryForeground,
    secondary: palette.selection,
    secondaryForeground: palette.foreground,
    muted: palette.card,
    mutedForeground: palette.muted,
    accent: palette.hover,
    accentForeground: palette.foreground,
    destructive: palette.error,
    destructiveForeground: palette.background,
    success: palette.green,
    successForeground: palette.background,
    warning: palette.yellow,
    warningForeground: palette.background,
    info: palette.blue,
    infoForeground: palette.background,
    backdrop: palette.backdrop,
    gitAdded: palette.green,
    gitAddedForeground: palette.background,
    gitModified: palette.blue,
    gitModifiedForeground: palette.background,
    gitDeleted: palette.red,
    gitDeletedForeground: palette.background,
    gitConflict: palette.yellow,
    gitConflictForeground: palette.background,
    border: palette.border,
    input: palette.muted,
    ring: palette.primary,
    sidebar: palette.sidebar,
    sidebarForeground: palette.foreground,
    sidebarPrimary: palette.primary,
    sidebarPrimaryForeground: palette.primaryForeground,
    sidebarAccent: palette.hover,
    sidebarAccentForeground: palette.foreground,
    sidebarBorder: palette.border,
    sidebarRing: palette.primary,
  }
}

function ayuTheme(input: {
  id: string
  name: string
  scheme: "dark" | "light"
  palette: AyuPalette
}): YaadeTheme {
  const { palette } = input
  return makeTheme({
    id: input.id,
    name: input.name,
    family: "Ayu",
    scheme: input.scheme,
    sourceName: "Ayu Colors",
    sourceUrl,
    license: "MIT",
    tokens: semanticTokens(palette),
    terminal: {
      background: palette.sidebar,
      foreground: palette.foreground,
      cursor: palette.primary,
      selectionBackground: palette.selection,
    },
    highlights: paletteHighlights({
      keyword: palette.orange,
      controlKeyword: palette.orange,
      function: palette.yellow,
      type: palette.blue,
      string: palette.green,
      number: palette.purple,
      boolean: palette.purple,
      comment: palette.comment,
      operator: palette.red,
      variable: palette.foreground,
      attribute: palette.yellow,
      constant: palette.purple,
      field: palette.field,
      module: palette.green,
      label: palette.cyan,
    }),
    terminalAnsi: paletteAnsi({
      black: palette.black,
      red: palette.red,
      green: palette.green,
      yellow: palette.yellow,
      blue: palette.blue,
      magenta: palette.magenta,
      cyan: palette.cyan,
      white: palette.white,
      brightBlack: palette.brightBlack,
      brightRed: palette.field,
      brightGreen: palette.green,
      brightYellow: palette.yellow,
      brightBlue: palette.blue,
      brightMagenta: palette.purple,
      brightCyan: palette.cyan,
      brightWhite: palette.brightWhite,
    }),
  })
}

const dark = ayuTheme({
  id: "ayu-dark",
  name: "Ayu Dark",
  scheme: "dark",
  palette: {
    background: "#10141c",
    sidebar: "#0d1017",
    card: "#141821",
    popover: "#0f131a",
    foreground: "#bfbdb6",
    muted: "#5a6378",
    border: "#1b1f29",
    selection: "#3388ff40",
    hover: "#47526640",
    primary: "#e6b450",
    primaryForeground: "#765b24",
    red: "#f29668",
    error: "#d95757",
    green: "#70bf56",
    yellow: "#ffb454",
    blue: "#59c2ff",
    cyan: "#95e6cb",
    magenta: "#d0a1ff",
    purple: "#d2a6ff",
    orange: "#ff8f40",
    field: "#f07178",
    comment: "#5a6673",
    black: "#1b1f29",
    white: "#c7c7c7",
    brightBlack: "#686868",
    brightWhite: "#ffffff",
    backdrop: "rgba(13, 16, 23, 0.78)",
  },
})

const mirage = ayuTheme({
  id: "ayu-mirage",
  name: "Ayu Mirage",
  scheme: "dark",
  palette: {
    background: "#242936",
    sidebar: "#1f2430",
    card: "#282e3b",
    popover: "#1c212c",
    foreground: "#cccac2",
    muted: "#707a8c",
    border: "#171b24",
    selection: "#409fff40",
    hover: "#63759926",
    primary: "#ffcc66",
    primaryForeground: "#735923",
    red: "#f29e74",
    error: "#ff6666",
    green: "#87d96c",
    yellow: "#ffcd66",
    blue: "#73d0ff",
    cyan: "#95e6cb",
    magenta: "#ddbbff",
    purple: "#dfbfff",
    orange: "#ffa659",
    field: "#f28779",
    comment: "#6e7c8f",
    black: "#171b24",
    white: "#c7c7c7",
    brightBlack: "#686868",
    brightWhite: "#ffffff",
    backdrop: "rgba(23, 27, 36, 0.76)",
  },
})

const light = ayuTheme({
  id: "ayu-light",
  name: "Ayu Light",
  scheme: "light",
  palette: {
    background: "#fcfcfc",
    sidebar: "#f8f9fa",
    card: "#fafafa",
    popover: "#ffffff",
    foreground: "#5c6166",
    muted: "#828e9f",
    border: "#6b7d8f1f",
    selection: "#035bd626",
    hover: "#6b7d8f24",
    primary: "#f29718",
    primaryForeground: "#7e4b01",
    red: "#f2a191",
    error: "#e65050",
    green: "#6cbf43",
    yellow: "#eba400",
    blue: "#22a4e6",
    cyan: "#4cbf99",
    magenta: "#a176cb",
    purple: "#a37acc",
    orange: "#fa8532",
    field: "#f07171",
    comment: "#adaeb1",
    black: "#000000",
    white: "#c7c7c7",
    brightBlack: "#686868",
    brightWhite: "#d1d1d1",
    backdrop: "rgba(92, 97, 102, 0.28)",
  },
})

export const ayuThemes = {
  [dark.id]: dark,
  [mirage.id]: mirage,
  [light.id]: light,
}

export const ayuThemeList = [dark, mirage, light]
