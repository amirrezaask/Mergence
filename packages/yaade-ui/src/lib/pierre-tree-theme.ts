import type { CSSProperties } from "react"

export type PierreTreeTokenStyle = CSSProperties &
  Record<`--trees-${string}`, string>

/** Maps Pierre's shadow-DOM theme surface onto YAADE semantic tokens. */
export const pierreTreeTokenStyle: PierreTreeTokenStyle = {
  "--trees-theme-sidebar-bg": "var(--sidebar)",
  "--trees-theme-sidebar-fg": "var(--sidebar-foreground)",
  "--trees-theme-sidebar-header-fg": "var(--sidebar-foreground)",
  "--trees-theme-sidebar-border": "var(--sidebar-border)",
  "--trees-theme-input-bg": "var(--background)",
  "--trees-theme-input-border": "var(--input)",
  "--trees-theme-list-active-selection-bg": "var(--sidebar-accent)",
  "--trees-theme-list-active-selection-fg":
    "var(--sidebar-accent-foreground)",
  "--trees-theme-list-hover-bg": "var(--sidebar-accent)",
  "--trees-theme-focus-ring": "var(--sidebar-ring)",
  "--trees-theme-scrollbar-thumb": "var(--muted-foreground)",
  "--trees-theme-git-added-fg": "var(--git-added)",
  "--trees-theme-git-modified-fg": "var(--git-modified)",
  "--trees-theme-git-deleted-fg": "var(--git-deleted)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--yaade-fs-2xs)",
  color: "var(--sidebar-foreground)",
}
