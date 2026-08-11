import { useMemo } from "react"
import { DEFAULT_THEMES, parseDiffFromFile } from "@pierre/diffs"
import { FileDiff, UnresolvedFile, Virtualizer } from "@pierre/diffs/react"
import type { YaadeTheme } from "@yaade/shared"

import { cn } from "@/lib/utils.js"

export type YaadeDiffViewerProps = {
  path: string
  original: string
  modified: string
  /** Unified (stacked) or split (side-by-side). Ignored for merge conflicts. */
  mode: "unified" | "split"
  theme: YaadeTheme
  /** Editor font size in px (default 13). */
  fontSize?: number
  /**
   * When true, `modified` is a working-tree file that may contain Git conflict
   * markers — render via Pierre `UnresolvedFile` instead of a 2-way file diff.
   */
  conflict?: boolean
  /**
   * After the user picks Current / Incoming / Both, receive updated file
   * contents. Update `modified` (and optionally write the working tree) so the
   * viewer remounts with the resolved text.
   */
  onConflictResolved?: (contents: string) => void
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

function pierreUnsafeCss(fontSize: number): string {
  return [
    // Custom element host defaults to inline — block + bounded width so
    // Pierre's overflow-x:scroll on [data-code] can engage.
    `:host { display: block; width: 100%; max-width: 100%; min-width: 0; overflow-x: hidden; background: transparent; color: var(--foreground); }`,
    // Sit the diff on the workbench canvas — no raised panel fill behind hunks.
    `[data-diff], [data-file], [data-code] { background: transparent !important; }`,
    // Default `1fr` tracks are minmax(auto, 1fr) and grow with long lines,
    // which expands the host and gets clipped by our overflow-hidden parents.
    `[data-diff], [data-file] { --diffs-code-grid: var(--diffs-grid-number-column-width) minmax(0, 1fr); }`,
    `[data-diff-type="split"][data-overflow="scroll"] { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }`,
    `pre, code { font-size: ${fontSize}px; font-family: var(--font-mono, 'Commit Mono', ui-monospace, monospace); }`,
  ].join("\n")
}

/**
 * Read-only git file diff via `@pierre/diffs`.
 * Callers own chrome (path/status toolbar); Pierre’s file header is disabled.
 * Prefer wrapping ancestors in {@link PierreDiffPool}.
 *
 * Conflicted working-tree files use {@link UnresolvedFile} so merge markers are
 * parsed by Pierre instead of a naive HEAD↔worktree two-way diff.
 *
 * Scroll + line virtualization live on `Virtualizer`; Shiki runs in the worker pool.
 */
export function YaadeDiffViewer(props: YaadeDiffViewerProps) {
  const {
    path,
    original,
    modified,
    mode,
    theme,
    fontSize = 13,
    conflict = false,
    onConflictResolved,
    className,
  } = props
  const themeType = theme.scheme === "light" ? "light" : "dark"

  const conflictFile = useMemo(() => {
    if (!conflict) return null
    const key = contentCacheKey("new", path, modified)
    return {
      name: path,
      contents: modified,
      cacheKey: `${key}:merge-conflict`,
    }
  }, [conflict, path, modified])

  const fileDiff = useMemo(() => {
    if (conflict) return null
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
  }, [conflict, path, original, modified])

  const sharedOptions = useMemo(
    () => ({
      theme: DEFAULT_THEMES,
      themeType: themeType as "light" | "dark",
      overflow: "scroll" as const,
      disableFileHeader: true,
      diffIndicators: "classic" as const,
      unsafeCSS: pierreUnsafeCss(fontSize),
      // Built-in Current / Incoming / Both when no custom utility is supplied.
      mergeConflictActionsType: "default" as const,
    }),
    [themeType, fontSize],
  )

  const diffOptions = useMemo(
    () => ({
      ...sharedOptions,
      diffStyle: mode,
    }),
    [sharedOptions, mode],
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
      data-yaade-pierre-conflict={conflict ? "" : undefined}
      className={cn(
        "h-full min-h-0 w-full min-w-0 [&_diffs-container]:block [&_diffs-container]:h-full [&_diffs-container]:w-full [&_diffs-container]:min-w-0 [&_diffs-container]:max-w-full",
        className,
      )}
    >
      {/* Vertical scroll on Virtualizer; horizontal scroll stays on Pierre's
          [data-code] panes (overflow-x:hidden here so trackpad swipes aren't eaten). */}
      <Virtualizer className="h-full min-h-0 w-full min-w-0 overflow-x-hidden overflow-y-auto">
        {conflict && conflictFile ? (
          <UnresolvedFile
            key={conflictFile.cacheKey}
            file={conflictFile}
            options={sharedOptions}
            metrics={metrics}
            className="block h-full w-full min-w-0 max-w-full"
            renderMergeConflictUtility={
              onConflictResolved
                ? (action, getInstance) => (
                    <ConflictResolveButtons
                      conflictIndex={action.conflictIndex}
                      getInstance={getInstance}
                      onResolved={onConflictResolved}
                    />
                  )
                : undefined
            }
          />
        ) : fileDiff ? (
          <FileDiff
            fileDiff={fileDiff}
            options={diffOptions}
            metrics={metrics}
            className="block h-full w-full min-w-0 max-w-full"
          />
        ) : null}
      </Virtualizer>
    </div>
  )
}

function ConflictResolveButtons(props: {
  conflictIndex: number
  getInstance: () =>
    | {
        resolveConflict(
          index: number,
          resolution: "current" | "incoming" | "both",
        ): { file: { contents: string } } | undefined
      }
    | undefined
  onResolved: (contents: string) => void
}) {
  const { conflictIndex, getInstance, onResolved } = props
  const run = (resolution: "current" | "incoming" | "both") => {
    const result = getInstance()?.resolveConflict(conflictIndex, resolution)
    if (result?.file.contents != null) onResolved(result.file.contents)
  }
  return (
    <div className="flex flex-wrap items-center gap-1" data-yaade-merge-conflict-actions="">
      <button
        type="button"
        className="rounded-sm border border-border bg-secondary px-1.5 py-0.5 text-3xs"
        onClick={() => run("current")}
      >
        Current
      </button>
      <button
        type="button"
        className="rounded-sm border border-border bg-secondary px-1.5 py-0.5 text-3xs"
        onClick={() => run("incoming")}
      >
        Incoming
      </button>
      <button
        type="button"
        className="rounded-sm border border-border bg-secondary px-1.5 py-0.5 text-3xs"
        onClick={() => run("both")}
      >
        Both
      </button>
    </div>
  )
}
