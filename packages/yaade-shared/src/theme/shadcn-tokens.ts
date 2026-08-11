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
  // Zinc canvas with a slightly cooler rail — cards lift as white objects.
  background: "oklch(0.975 0.002 264)",
  foreground: "oklch(0.27 0.006 286)",
  card: "oklch(1 0 264)",
  cardForeground: "oklch(0.27 0.006 286)",
  popover: "oklch(1 0 264)",
  popoverForeground: "oklch(0.27 0.006 286)",
  primary: "oklch(0.49 0.205 264)",
  primaryForeground: "oklch(1 0 264)",
  secondary: "oklch(0.955 0.003 264)",
  secondaryForeground: "oklch(0.27 0.006 286)",
  muted: "oklch(0.955 0.003 264)",
  mutedForeground: "oklch(0.5 0.015 286)",
  accent: "oklch(0.94 0.004 264)",
  accentForeground: "oklch(0.22 0.006 286)",
  destructive: "oklch(0.58 0.19 24)",
  destructiveForeground: "oklch(1 0 264)",
  success: "oklch(0.62 0.13 162)",
  successForeground: "oklch(0.25 0.05 160)",
  warning: "oklch(0.75 0.14 70)",
  warningForeground: "oklch(0.3 0.06 54)",
  info: "oklch(0.55 0.18 262)",
  infoForeground: "oklch(1 0 264)",
  backdrop: "rgba(0, 0, 0, 0.4)",
  gitAdded: "oklch(0.62 0.13 162)",
  gitAddedForeground: "oklch(0.25 0.05 160)",
  gitModified: "oklch(0.55 0.18 262)",
  gitModifiedForeground: "oklch(1 0 264)",
  gitDeleted: "oklch(0.58 0.19 24)",
  gitDeletedForeground: "oklch(1 0 264)",
  gitConflict: "oklch(0.75 0.14 70)",
  gitConflictForeground: "oklch(0.3 0.06 54)",
  border: "oklch(0.9 0.005 286)",
  input: "oklch(0.58 0.012 286)",
  ring: "oklch(0.49 0.205 264)",
  sidebar: "oklch(0.96 0.003 264)",
  sidebarForeground: "oklch(0.27 0.006 286)",
  sidebarPrimary: "oklch(0.49 0.205 264)",
  sidebarPrimaryForeground: "oklch(1 0 264)",
  sidebarAccent: "oklch(0.94 0.004 264)",
  sidebarAccentForeground: "oklch(0.22 0.006 286)",
  sidebarBorder: "oklch(0.9 0.005 286)",
  sidebarRing: "oklch(0.49 0.205 264)",
}

export const shadcnDefaultDark: YaadeSemanticTokens = {
  // Soft graphite: canvas ≈ sidebar ≈ card; hairline borders do the separation.
  background: "oklch(0.155 0.004 264)",
  foreground: "oklch(0.93 0.006 264)",
  card: "oklch(0.17 0.004 264)",
  cardForeground: "oklch(0.93 0.006 264)",
  popover: "oklch(0.2 0.004 264)",
  popoverForeground: "oklch(0.93 0.006 264)",
  primary: "oklch(0.555 0.195 264)",
  primaryForeground: "oklch(0.99 0 264)",
  secondary: "oklch(0.178 0.004 264)",
  secondaryForeground: "oklch(0.93 0.006 264)",
  muted: "oklch(0.178 0.004 264)",
  mutedForeground: "oklch(0.62 0.012 264)",
  accent: "oklch(0.19 0.005 264)",
  accentForeground: "oklch(0.93 0.006 264)",
  destructive: "oklch(0.655 0.2 23.5)",
  destructiveForeground: "oklch(0.155 0.004 264)",
  success: "oklch(0.72 0.13 162)",
  successForeground: "oklch(0.24 0.05 160)",
  warning: "oklch(0.78 0.14 70)",
  warningForeground: "oklch(0.28 0.06 54)",
  info: "oklch(0.65 0.16 260)",
  infoForeground: "oklch(0.155 0.004 264)",
  backdrop: "rgba(0, 0, 0, 0.64)",
  gitAdded: "oklch(0.72 0.13 162)",
  gitAddedForeground: "oklch(0.24 0.05 160)",
  gitModified: "oklch(0.65 0.16 260)",
  gitModifiedForeground: "oklch(0.155 0.004 264)",
  gitDeleted: "oklch(0.655 0.2 23.5)",
  gitDeletedForeground: "oklch(0.155 0.004 264)",
  gitConflict: "oklch(0.78 0.14 70)",
  gitConflictForeground: "oklch(0.28 0.06 54)",
  border: "oklch(0.25 0.006 264)",
  input: "oklch(0.5 0.01 264)",
  ring: "oklch(0.555 0.195 264)",
  sidebar: "oklch(0.145 0.004 264)",
  sidebarForeground: "oklch(0.93 0.006 264)",
  sidebarPrimary: "oklch(0.555 0.195 264)",
  sidebarPrimaryForeground: "oklch(0.99 0 264)",
  sidebarAccent: "oklch(0.19 0.005 264)",
  sidebarAccentForeground: "oklch(0.93 0.006 264)",
  sidebarBorder: "oklch(0.215 0.005 264)",
  sidebarRing: "oklch(0.555 0.195 264)",
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
