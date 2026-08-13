import type { YaadeSemanticTokens, YaadeTheme } from "@yaade/shared"
import { makeTheme, paletteAnsi, paletteHighlights } from "./theme-palette.js"

type TokyoNightPalette = {
  bg: string
  bgDark: string
  bgHighlight: string
  terminalBlack: string
  fg: string
  fgDark: string
  fgGutter: string
  dark3: string
  dark5: string
  comment: string
  blue0: string
  blue: string
  blue1: string
  blue2: string
  blue5: string
  blue6: string
  blue7: string
  cyan: string
  magenta: string
  magenta2: string
  purple: string
  orange: string
  yellow: string
  green: string
  green1: string
  green2: string
  teal: string
  red: string
  red1: string
}

const sourceUrl = "https://github.com/folke/tokyonight.nvim"

function semanticTokens(
  palette: TokyoNightPalette,
  scheme: "dark" | "light",
): YaadeSemanticTokens {
  const backdrop =
    scheme === "light" ? "rgba(55, 96, 191, 0.24)" : "rgba(15, 15, 20, 0.76)"
  return {
    background: palette.bg,
    foreground: palette.fg,
    card: palette.bgDark,
    cardForeground: palette.fg,
    popover: palette.bgDark,
    popoverForeground: palette.fg,
    primary: palette.blue,
    primaryForeground: palette.bg,
    secondary: palette.bgHighlight,
    secondaryForeground: palette.fg,
    muted: palette.bgDark,
    mutedForeground: palette.dark5,
    accent: palette.bgHighlight,
    accentForeground: palette.fg,
    destructive: palette.red1,
    destructiveForeground: palette.bg,
    success: palette.green,
    successForeground: palette.bg,
    warning: palette.yellow,
    warningForeground: palette.bg,
    info: palette.cyan,
    infoForeground: palette.bg,
    backdrop,
    gitAdded: palette.green2,
    gitAddedForeground: palette.bg,
    gitModified: palette.blue,
    gitModifiedForeground: palette.bg,
    gitDeleted: palette.red1,
    gitDeletedForeground: palette.bg,
    gitConflict: palette.yellow,
    gitConflictForeground: palette.bg,
    border: palette.bgHighlight,
    input: palette.dark3,
    ring: palette.blue,
    sidebar: palette.bgDark,
    sidebarForeground: palette.fgDark,
    sidebarPrimary: palette.blue,
    sidebarPrimaryForeground: palette.bg,
    sidebarAccent: palette.bgHighlight,
    sidebarAccentForeground: palette.fg,
    sidebarBorder: palette.bgHighlight,
    sidebarRing: palette.blue,
  }
}

function tokyoNightTheme(input: {
  id: string
  name: string
  scheme: "dark" | "light"
  palette: TokyoNightPalette
}): YaadeTheme {
  const { palette, scheme } = input
  return makeTheme({
    id: input.id,
    name: input.name,
    family: "Tokyo Night",
    scheme,
    sourceName: "Tokyo Night",
    sourceUrl,
    license: "Apache-2.0",
    tokens: semanticTokens(palette, scheme),
    terminal: {
      background: palette.bgDark,
      foreground: palette.fg,
      cursor: palette.fg,
      selectionBackground: palette.bgHighlight,
    },
    highlights: paletteHighlights({
      keyword: palette.magenta,
      controlKeyword: palette.cyan,
      function: palette.blue,
      type: palette.blue2,
      string: palette.green,
      number: palette.orange,
      boolean: palette.orange,
      comment: palette.comment,
      operator: palette.blue5,
      variable: palette.fg,
      attribute: palette.magenta,
      constant: palette.orange,
      field: palette.green1,
      module: palette.cyan,
      label: palette.yellow,
    }),
    terminalAnsi: paletteAnsi({
      black: palette.terminalBlack,
      red: palette.red,
      green: palette.green1,
      yellow: palette.yellow,
      blue: palette.blue,
      magenta: palette.magenta,
      cyan: palette.cyan,
      white: palette.fgDark,
      brightBlack: palette.dark3,
      brightRed: palette.red,
      brightGreen: palette.green1,
      brightYellow: palette.yellow,
      brightBlue: palette.blue,
      brightMagenta: palette.magenta,
      brightCyan: palette.cyan,
      brightWhite: palette.fg,
    }),
  })
}

const nightPalette: TokyoNightPalette = {
  bg: "#1a1b26",
  bgDark: "#16161e",
  bgHighlight: "#292e42",
  terminalBlack: "#414868",
  fg: "#c0caf5",
  fgDark: "#a9b1d6",
  fgGutter: "#3b4261",
  dark3: "#545c7e",
  dark5: "#737aa2",
  comment: "#565f89",
  blue0: "#3d59a1",
  blue: "#7aa2f7",
  blue1: "#2ac3de",
  blue2: "#0db9d7",
  blue5: "#89ddff",
  blue6: "#b4f9f8",
  blue7: "#394b70",
  cyan: "#7dcfff",
  magenta: "#bb9af7",
  magenta2: "#ff007c",
  purple: "#9d7cd8",
  orange: "#ff9e64",
  yellow: "#e0af68",
  green: "#9ece6a",
  green1: "#73daca",
  green2: "#41a6b5",
  teal: "#1abc9c",
  red: "#f7768e",
  red1: "#db4b4b",
}

const stormPalette: TokyoNightPalette = {
  ...nightPalette,
  bg: "#24283b",
  bgDark: "#1f2335",
}

const moonPalette: TokyoNightPalette = {
  bg: "#222436",
  bgDark: "#1e2030",
  bgHighlight: "#2f334d",
  terminalBlack: "#444a73",
  fg: "#c8d3f5",
  fgDark: "#828bb8",
  fgGutter: "#3b4261",
  dark3: "#545c7e",
  dark5: "#737aa2",
  comment: "#636da6",
  blue0: "#3e68d7",
  blue: "#82aaff",
  blue1: "#65bcff",
  blue2: "#0db9d7",
  blue5: "#89ddff",
  blue6: "#b4f9f8",
  blue7: "#394b70",
  cyan: "#86e1fc",
  magenta: "#c099ff",
  magenta2: "#ff007c",
  purple: "#fca7ea",
  orange: "#ff966c",
  yellow: "#ffc777",
  green: "#c3e88d",
  green1: "#4fd6be",
  green2: "#41a6b5",
  teal: "#4fd6be",
  red: "#ff757f",
  red1: "#c53b53",
}

const dayPalette: TokyoNightPalette = {
  bg: "#e1e2e7",
  bgDark: "#d0d5e3",
  bgHighlight: "#c4c8da",
  terminalBlack: "#a8aecb",
  fg: "#3760bf",
  fgDark: "#6172b0",
  fgGutter: "#a8aecb",
  dark3: "#8990b3",
  dark5: "#68709a",
  comment: "#848cb5",
  blue0: "#7890dd",
  blue: "#2e7de9",
  blue1: "#188092",
  blue2: "#07879d",
  blue5: "#006a83",
  blue6: "#2e5857",
  blue7: "#92a6d5",
  cyan: "#007197",
  magenta: "#9854f1",
  magenta2: "#d20065",
  purple: "#7847bd",
  orange: "#b15c00",
  yellow: "#8c6c3e",
  green: "#587539",
  green1: "#387068",
  green2: "#38919f",
  teal: "#118c74",
  red: "#f52a65",
  red1: "#c64343",
}

const night = tokyoNightTheme({
  id: "tokyonight-night",
  name: "Tokyo Night",
  scheme: "dark",
  palette: nightPalette,
})
const storm = tokyoNightTheme({
  id: "tokyonight-storm",
  name: "Tokyo Night Storm",
  scheme: "dark",
  palette: stormPalette,
})
const moon = tokyoNightTheme({
  id: "tokyonight-moon",
  name: "Tokyo Night Moon",
  scheme: "dark",
  palette: moonPalette,
})
const day = tokyoNightTheme({
  id: "tokyonight-day",
  name: "Tokyo Night Day",
  scheme: "light",
  palette: dayPalette,
})

export const tokyoNightThemes = {
  [night.id]: night,
  [storm.id]: storm,
  [moon.id]: moon,
  [day.id]: day,
}

// Night is the stable dark sibling for Day when Auto mode changes scheme.
export const tokyoNightThemeList = [night, storm, moon, day]
