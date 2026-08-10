import { useMemo } from "react"
import { DEFAULT_THEMES, parseDiffFromFile } from "@pierre/diffs"
import { FileDiff, Virtualizer } from "@pierre/diffs/react"
import type { YaadeTheme } from "@yaade/shared"

import { cn } from "@/lib/utils.js"

export type YaadeDiffViewerProps = {
  path: string
  original: string
  modified: string
  /** Unified (stacked) or split (side-by-side). */
  mode: "unified" | "split"
  theme: YaadeTheme
  /** Editor font size in px (default 13). */
  fontSize?: number
  className?: string
}

/**
 * O(1) content identity for Worker Pool AST LRU.
 * Full FNV over multi-MiB files was a main-thread stall; length + samples suffice
 * for cache keys (collision risk is acceptable for UI highlight cache).
 */
function contentCacheKey(side: "old" | "new", path: string, contents: string): string {
  const len = contents.length
  if (len === 0) return `${side}:${path}:0`
  const head = contents.charCodeAt(0) ^ contents.charCodeAt(Math.min(63, len - 1))
  const mid = contents.charCodeAt(len >>> 1)
  const tail = contents.charCodeAt(len - 1)
  return `${side}:${path}:${len}:${(head >>> 0).toString(36)}${mid.toString(36)}${tail.toString(36)}`
}

export { PierreDiffPool } from "./pierre-diff-pool.js"

/**
 * Read-only git file diff via `@pierre/diffs`.
 * Callers own chrome (path/status toolbar); Pierre’s file header is disabled.
 * Prefer wrapping ancestors in {@link PierreDiffPool}.
 *
 * Scroll + line virtualization live on `Virtualizer`; Shiki runs in the worker pool.
 */
export function YaadeDiffViewer(props: YaadeDiffViewerProps) {
  const { path, original, modified, mode, theme, fontSize = 13, className } = props
  const themeType = theme.scheme === "light" ? "light" : "dark"

  const fileDiff = useMemo(() => {
    const oldKey = contentCacheKey("old", path, original)
    const newKey = contentCacheKey("new", path, modified)
    const diff = parseDiffFromFile(
      {
        name: path,
        contents: original,
        cacheKey: oldKey,
      },
      {
        name: path,
        contents: modified,
        cacheKey: newKey,
      },
    )
    diff.cacheKey = `${path}:${oldKey}:${newKey}`
    return diff
  }, [path, original, modified])

  const options = useMemo(
    () => ({
      theme: DEFAULT_THEMES,
      themeType: themeType as "light" | "dark",
      diffStyle: mode,
      // Keep long lines on one row; scroll inside [data-code], not wrap.
      overflow: "scroll" as const,
      disableFileHeader: true,
      diffIndicators: "classic" as const,
      unsafeCSS: [
        // Custom element host defaults to inline — block + bounded width so
        // Pierre's overflow-x:scroll on [data-code] can engage.
        `:host { display: block; width: 100%; max-width: 100%; min-width: 0; overflow-x: hidden; }`,
        // Default `1fr` tracks are minmax(auto, 1fr) and grow with long lines,
        // which expands the host and gets clipped by our overflow-hidden parents.
        `[data-diff], [data-file] { --diffs-code-grid: var(--diffs-grid-number-column-width) minmax(0, 1fr); }`,
        `[data-diff-type="split"][data-overflow="scroll"] { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }`,
        `pre, code { font-size: ${fontSize}px; font-family: var(--font-mono, 'Commit Mono', ui-monospace, monospace); }`,
      ].join("\n"),
    }),
    [themeType, mode, fontSize],
  )

  const metrics = useMemo(
    () => ({
      hunkLineCount: 50,
      // Pierre default lineHeight is 20 at 13px; scale with our font size.
      lineHeight: Math.max(1, Math.ceil(fontSize * (20 / 13))),
      // Header disabled — keep region estimate at 0 via defaults + disableFileHeader.
      diffHeaderHeight: 0,
      spacing: 8,
    }),
    [fontSize],
  )

  return (
    <div
      data-yaade-pierre-diff=""
      className={cn(
        "h-full min-h-0 w-full min-w-0 [&_diffs-container]:block [&_diffs-container]:h-full [&_diffs-container]:w-full [&_diffs-container]:min-w-0 [&_diffs-container]:max-w-full",
        className,
      )}
    >
      {/* Vertical scroll on Virtualizer; horizontal scroll stays on Pierre's
          [data-code] panes (overflow-x:hidden here so trackpad swipes aren't eaten). */}
      <Virtualizer className="h-full min-h-0 w-full min-w-0 overflow-x-hidden overflow-y-auto">
        <FileDiff
          fileDiff={fileDiff}
          options={options}
          metrics={metrics}
          className="block h-full w-full min-w-0 max-w-full"
        />
      </Virtualizer>
    </div>
  )
}
