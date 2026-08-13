/**
 * Shadcn-compatible semantic palette for YAADE's workbench.
 *
 * Default dark/light are a 2026 graphite stack: one cool-neutral hue family,
 * tiny ΔL between canvas / sidebar / card / muted (no pure-black wells), and a
 * single blue primary for focus — closer to T3 Code's zinc ramp than to
 * high-contrast IDE chrome. Status + git colors stay purpose-built for badges.
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
  // Cool paper canvas with blue-tinted interaction states and crisp white tools.
  background: "oklch(0.965 0.004 264)",
  foreground: "oklch(0.24 0.012 274)",
  card: "oklch(0.995 0.002 264)",
  cardForeground: "oklch(0.24 0.012 274)",
  popover: "oklch(0.995 0.002 264)",
  popoverForeground: "oklch(0.24 0.012 274)",
  primary: "oklch(0.52 0.21 264)",
  primaryForeground: "oklch(0.99 0 264)",
  secondary: "oklch(0.925 0.01 264)",
  secondaryForeground: "oklch(0.24 0.012 274)",
  muted: "oklch(0.935 0.007 264)",
  mutedForeground: "oklch(0.46 0.018 274)",
  accent: "oklch(0.91 0.035 264)",
  accentForeground: "oklch(0.25 0.06 264)",
  destructive: "oklch(0.56 0.2 24)",
  destructiveForeground: "oklch(0.99 0 264)",
  success: "oklch(0.58 0.14 162)",
  successForeground: "oklch(0.15 0.04 160)",
  warning: "oklch(0.76 0.14 70)",
  warningForeground: "oklch(0.28 0.06 54)",
  info: "oklch(0.55 0.18 262)",
  infoForeground: "oklch(0.99 0 264)",
  backdrop: "rgba(10, 12, 20, 0.46)",
  gitAdded: "oklch(0.58 0.14 162)",
  gitAddedForeground: "oklch(0.15 0.04 160)",
  gitModified: "oklch(0.55 0.18 262)",
  gitModifiedForeground: "oklch(0.99 0 264)",
  gitDeleted: "oklch(0.56 0.2 24)",
  gitDeletedForeground: "oklch(0.99 0 264)",
  gitConflict: "oklch(0.76 0.14 70)",
  gitConflictForeground: "oklch(0.28 0.06 54)",
  border: "oklch(0.84 0.014 274)",
  input: "oklch(0.58 0.02 274)",
  ring: "oklch(0.52 0.21 264)",
  sidebar: "oklch(0.945 0.008 264)",
  sidebarForeground: "oklch(0.24 0.012 274)",
  sidebarPrimary: "oklch(0.52 0.21 264)",
  sidebarPrimaryForeground: "oklch(0.99 0 264)",
  sidebarAccent: "oklch(0.9 0.04 264)",
  sidebarAccentForeground: "oklch(0.25 0.06 264)",
  sidebarBorder: "oklch(0.84 0.014 274)",
  sidebarRing: "oklch(0.52 0.21 264)",
}

export const shadcnDefaultDark: YaadeSemanticTokens = {
  // Layered midnight graphite: tool chrome is legible without black-on-black wells.
  background: "oklch(0.145 0.009 270)",
  foreground: "oklch(0.94 0.009 264)",
  card: "oklch(0.185 0.01 270)",
  cardForeground: "oklch(0.94 0.009 264)",
  popover: "oklch(0.205 0.012 270)",
  popoverForeground: "oklch(0.94 0.009 264)",
  primary: "oklch(0.55 0.21 264)",
  primaryForeground: "oklch(0.99 0 264)",
  secondary: "oklch(0.215 0.014 270)",
  secondaryForeground: "oklch(0.94 0.009 264)",
  muted: "oklch(0.205 0.012 270)",
  mutedForeground: "oklch(0.68 0.018 264)",
  accent: "oklch(0.255 0.045 264)",
  accentForeground: "oklch(0.96 0.012 264)",
  destructive: "oklch(0.55 0.22 23.5)",
  destructiveForeground: "oklch(0.99 0 264)",
  success: "oklch(0.72 0.14 162)",
  successForeground: "oklch(0.16 0.04 160)",
  warning: "oklch(0.8 0.14 70)",
  warningForeground: "oklch(0.2 0.05 54)",
  info: "oklch(0.72 0.16 260)",
  infoForeground: "oklch(0.15 0.03 264)",
  backdrop: "rgba(5, 7, 14, 0.7)",
  gitAdded: "oklch(0.72 0.14 162)",
  gitAddedForeground: "oklch(0.16 0.04 160)",
  gitModified: "oklch(0.72 0.16 260)",
  gitModifiedForeground: "oklch(0.15 0.03 264)",
  gitDeleted: "oklch(0.55 0.22 23.5)",
  gitDeletedForeground: "oklch(0.99 0 264)",
  gitConflict: "oklch(0.8 0.14 70)",
  gitConflictForeground: "oklch(0.2 0.05 54)",
  border: "oklch(0.29 0.018 270)",
  input: "oklch(0.52 0.025 270)",
  ring: "oklch(0.55 0.21 264)",
  sidebar: "oklch(0.165 0.011 270)",
  sidebarForeground: "oklch(0.94 0.009 264)",
  sidebarPrimary: "oklch(0.55 0.21 264)",
  sidebarPrimaryForeground: "oklch(0.99 0 264)",
  sidebarAccent: "oklch(0.245 0.042 264)",
  sidebarAccentForeground: "oklch(0.96 0.012 264)",
  sidebarBorder: "oklch(0.265 0.016 270)",
  sidebarRing: "oklch(0.55 0.21 264)",
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
