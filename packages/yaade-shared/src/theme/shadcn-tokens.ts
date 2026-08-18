/**
 * Semantic palette contract for YAADE's workbench.
 *
 * The default pair is one Liquid Glass language: a milky silver-blue field
 * in light, a near-black silver-blue void in dark, white-frost materials,
 * and one system-blue interaction color. Status and Git colors stay
 * purpose-built so they remain readable through translucent chrome.
 */
import { getDocumentElement } from "./dom-root.js"

export type YaadeSemanticTokens = {
  background: string
  foreground: string
  card: string
  cardForeground: string
  popover: string
  popoverForeground: string
  primary: string
  primaryForeground: string
  secondary: string
  secondaryForeground: string
  muted: string
  mutedForeground: string
  accent: string
  accentForeground: string
  destructive: string
  destructiveForeground: string
  success: string
  successForeground: string
  warning: string
  warningForeground: string
  info: string
  infoForeground: string
  backdrop: string
  gitAdded: string
  gitAddedForeground: string
  gitModified: string
  gitModifiedForeground: string
  gitDeleted: string
  gitDeletedForeground: string
  gitConflict: string
  gitConflictForeground: string
  border: string
  input: string
  ring: string
  sidebar: string
  sidebarForeground: string
  sidebarPrimary: string
  sidebarPrimaryForeground: string
  sidebarAccent: string
  sidebarAccentForeground: string
  sidebarBorder: string
  sidebarRing: string
}

/** @deprecated Use `YaadeSemanticTokens`. */
export type JetShadcnTokens = YaadeSemanticTokens

export const shadcnDefaultLight: YaadeSemanticTokens = {
  // Silver-blue daylight canvas with milky materials and system-blue focus.
  background: "oklch(0.955 0.012 248)",
  foreground: "oklch(0.22 0.018 258)",
  card: "oklch(0.992 0.006 248)",
  cardForeground: "oklch(0.22 0.018 258)",
  popover: "oklch(0.985 0.008 248)",
  popoverForeground: "oklch(0.22 0.018 258)",
  primary: "oklch(0.52 0.21 255)",
  primaryForeground: "oklch(0.99 0 255)",
  secondary: "oklch(0.915 0.022 248)",
  secondaryForeground: "oklch(0.22 0.018 258)",
  muted: "oklch(0.925 0.014 248)",
  mutedForeground: "oklch(0.45 0.026 258)",
  accent: "oklch(0.89 0.055 250)",
  accentForeground: "oklch(0.24 0.075 255)",
  destructive: "oklch(0.55 0.205 26)",
  destructiveForeground: "oklch(0.99 0 255)",
  success: "oklch(0.57 0.145 158)",
  successForeground: "oklch(0.14 0.045 158)",
  warning: "oklch(0.75 0.145 72)",
  warningForeground: "oklch(0.27 0.065 55)",
  info: "oklch(0.52 0.2 255)",
  infoForeground: "oklch(0.99 0 255)",
  backdrop: "rgba(16, 24, 40, 0.38)",
  gitAdded: "oklch(0.57 0.145 158)",
  gitAddedForeground: "oklch(0.14 0.045 158)",
  gitModified: "oklch(0.52 0.2 255)",
  gitModifiedForeground: "oklch(0.99 0 255)",
  gitDeleted: "oklch(0.55 0.205 26)",
  gitDeletedForeground: "oklch(0.99 0 255)",
  gitConflict: "oklch(0.75 0.145 72)",
  gitConflictForeground: "oklch(0.27 0.065 55)",
  border: "oklch(0.8 0.024 250)",
  input: "oklch(0.57 0.03 250)",
  ring: "oklch(0.52 0.21 255)",
  sidebar: "oklch(0.94 0.018 248)",
  sidebarForeground: "oklch(0.22 0.018 258)",
  sidebarPrimary: "oklch(0.52 0.21 255)",
  sidebarPrimaryForeground: "oklch(0.99 0 255)",
  sidebarAccent: "oklch(0.88 0.06 250)",
  sidebarAccentForeground: "oklch(0.24 0.075 255)",
  sidebarBorder: "oklch(0.8 0.024 250)",
  sidebarRing: "oklch(0.52 0.21 255)",
}

export const shadcnDefaultDark: YaadeSemanticTokens = {
  // Sibling of default-light: the same silver-blue family in a tight dark
  // milk range. Chrome frost is a lifted card film, not white-on-black
  // gray. Glass fills live in materials.css.
  background: "oklch(0.19 0.016 248)",
  foreground: "oklch(0.96 0.008 250)",
  card: "oklch(0.228 0.016 248)",
  cardForeground: "oklch(0.96 0.008 250)",
  popover: "oklch(0.248 0.018 248)",
  popoverForeground: "oklch(0.96 0.008 250)",
  primary: "oklch(0.54 0.20 255)",
  primaryForeground: "oklch(0.99 0 255)",
  secondary: "oklch(0.255 0.02 248)",
  secondaryForeground: "oklch(0.96 0.008 250)",
  muted: "oklch(0.235 0.016 248)",
  mutedForeground: "oklch(0.76 0.02 250)",
  accent: "oklch(0.28 0.045 250)",
  accentForeground: "oklch(0.96 0.01 250)",
  destructive: "oklch(0.55 0.205 26)",
  destructiveForeground: "oklch(0.99 0 255)",
  success: "oklch(0.74 0.14 155)",
  successForeground: "oklch(0.18 0.045 155)",
  warning: "oklch(0.8 0.14 72)",
  warningForeground: "oklch(0.22 0.055 55)",
  info: "oklch(0.72 0.16 255)",
  infoForeground: "oklch(0.16 0.04 255)",
  backdrop: "rgba(10, 16, 32, 0.48)",
  gitAdded: "oklch(0.74 0.14 155)",
  gitAddedForeground: "oklch(0.18 0.045 155)",
  gitModified: "oklch(0.72 0.16 255)",
  gitModifiedForeground: "oklch(0.16 0.04 255)",
  gitDeleted: "oklch(0.55 0.205 26)",
  gitDeletedForeground: "oklch(0.99 0 255)",
  gitConflict: "oklch(0.8 0.14 72)",
  gitConflictForeground: "oklch(0.22 0.055 55)",
  border: "oklch(0.32 0.02 250)",
  input: "oklch(0.52 0.028 250)",
  ring: "oklch(0.54 0.20 255)",
  sidebar: "oklch(0.205 0.016 248)",
  sidebarForeground: "oklch(0.96 0.008 250)",
  sidebarPrimary: "oklch(0.54 0.20 255)",
  sidebarPrimaryForeground: "oklch(0.99 0 255)",
  sidebarAccent: "oklch(0.275 0.048 250)",
  sidebarAccentForeground: "oklch(0.96 0.01 250)",
  sidebarBorder: "oklch(0.30 0.02 250)",
  sidebarRing: "oklch(0.54 0.20 255)",
}

/**
 * Canvas consumers such as xterm do not consistently parse CSS Color 4.
 * Convert authored OKLCH tokens to a clipped sRGB color for compatibility
 * views while leaving the canonical semantic values untouched.
 */
export function toSrgbColor(value: string): string {
  const match = value.trim().match(
    /^oklch\(\s*([+-]?[\d.]+)(%)?\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)(?:\s*\/\s*([+-]?[\d.]+)(%)?)?\s*\)$/i,
  )
  if (!match) return value

  const lightness = Number(match[1]) / (match[2] ? 100 : 1)
  const chroma = Number(match[3])
  const hue = (Number(match[4]) * Math.PI) / 180
  const alpha = match[5]
    ? Number(match[5]) / (match[6] ? 100 : 1)
    : 1
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)

  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b
  const l = lPrime ** 3
  const m = mPrime ** 3
  const s = sPrime ** 3

  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  const channels = linear.map(channel => {
    const encoded =
      channel <= 0.0031308
        ? 12.92 * channel
        : 1.055 * channel ** (1 / 2.4) - 0.055
    return Math.round(Math.min(1, Math.max(0, encoded)) * 255)
  })
  if (alpha < 1) {
    return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${Math.min(1, Math.max(0, alpha))})`
  }
  return `#${channels.map(channel => channel.toString(16).padStart(2, "0")).join("")}`
}

export function applySemanticTokens(tokens: YaadeSemanticTokens): void {
  const root = getDocumentElement()
  if (!root) return
  root.style.setProperty("--background", tokens.background)
  root.style.setProperty("--foreground", tokens.foreground)
  root.style.setProperty("--card", tokens.card)
  root.style.setProperty("--card-foreground", tokens.cardForeground)
  root.style.setProperty("--popover", tokens.popover)
  root.style.setProperty("--popover-foreground", tokens.popoverForeground)
  root.style.setProperty("--primary", tokens.primary)
  root.style.setProperty("--primary-foreground", tokens.primaryForeground)
  root.style.setProperty("--secondary", tokens.secondary)
  root.style.setProperty("--secondary-foreground", tokens.secondaryForeground)
  root.style.setProperty("--muted", tokens.muted)
  root.style.setProperty("--muted-foreground", tokens.mutedForeground)
  root.style.setProperty("--accent", tokens.accent)
  root.style.setProperty("--accent-foreground", tokens.accentForeground)
  root.style.setProperty("--destructive", tokens.destructive)
  root.style.setProperty("--destructive-foreground", tokens.destructiveForeground)
  root.style.setProperty("--success", tokens.success)
  root.style.setProperty("--success-foreground", tokens.successForeground)
  root.style.setProperty("--warning", tokens.warning)
  root.style.setProperty("--warning-foreground", tokens.warningForeground)
  root.style.setProperty("--info", tokens.info)
  root.style.setProperty("--info-foreground", tokens.infoForeground)
  root.style.setProperty("--backdrop", tokens.backdrop)
  root.style.setProperty("--git-added", tokens.gitAdded)
  root.style.setProperty("--git-added-foreground", tokens.gitAddedForeground)
  root.style.setProperty("--git-modified", tokens.gitModified)
  root.style.setProperty("--git-modified-foreground", tokens.gitModifiedForeground)
  root.style.setProperty("--git-deleted", tokens.gitDeleted)
  root.style.setProperty("--git-deleted-foreground", tokens.gitDeletedForeground)
  root.style.setProperty("--git-conflict", tokens.gitConflict)
  root.style.setProperty("--git-conflict-foreground", tokens.gitConflictForeground)
  root.style.setProperty("--border", tokens.border)
  root.style.setProperty("--input", tokens.input)
  root.style.setProperty("--ring", tokens.ring)
  root.style.setProperty("--sidebar", tokens.sidebar)
  root.style.setProperty("--sidebar-foreground", tokens.sidebarForeground)
  root.style.setProperty("--sidebar-primary", tokens.sidebarPrimary)
  root.style.setProperty("--sidebar-primary-foreground", tokens.sidebarPrimaryForeground)
  root.style.setProperty("--sidebar-accent", tokens.sidebarAccent)
  root.style.setProperty("--sidebar-accent-foreground", tokens.sidebarAccentForeground)
  root.style.setProperty("--sidebar-border", tokens.sidebarBorder)
  root.style.setProperty("--sidebar-ring", tokens.sidebarRing)
}

/** @deprecated Use `applySemanticTokens`. */
export const applyShadcnTokens = applySemanticTokens

export function jetColorsFromTokens(tokens: YaadeSemanticTokens) {
  return {
    bg: toSrgbColor(tokens.background),
    panel: toSrgbColor(tokens.sidebar),
    panelRaised: toSrgbColor(tokens.card),
    text: toSrgbColor(tokens.foreground),
    textMuted: toSrgbColor(tokens.mutedForeground),
    accent: toSrgbColor(tokens.primary),
    hover: toSrgbColor(tokens.accent),
    selection: toSrgbColor(tokens.secondary),
    border: toSrgbColor(tokens.border),
    focusBorder: toSrgbColor(tokens.ring),
    error: toSrgbColor(tokens.destructive),
    warning: toSrgbColor(tokens.warning),
    success: toSrgbColor(tokens.success),
    backdrop: toSrgbColor(tokens.backdrop),
  }
}

/** @deprecated Use `jetColorsFromTokens`. */
export function jetColorsFromShadcn(
  tokens: YaadeSemanticTokens,
  _scheme?: "dark" | "light",
) {
  return jetColorsFromTokens(tokens)
}
