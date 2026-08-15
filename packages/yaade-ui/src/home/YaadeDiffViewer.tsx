import { useMemo } from "react"
import {
  DEFAULT_THEMES,
  getSingularPatch,
  parseDiffFromFile,
  type DiffLineAnnotation,
} from "@pierre/diffs"
import { FileDiff, PatchDiff, UnresolvedFile, Virtualizer } from "@pierre/diffs/react"
import type { YaadeTheme } from "@yaade/shared"

import { cn } from "@/lib/utils.js"
import {
  buildHunkActionAnnotations,
  hunkIndexForLine,
  type HunkActionMeta,
} from "./pierre-hunk-patch.js"

export type YaadeHunkActions = {
  /** Staged area → Unstage only; unstaged → Stage + Discard. */
  staged: boolean
  disabled?: boolean
  onStageHunk?: (hunkIndex: number) => void
  onUnstageHunk?: (hunkIndex: number) => void
  onDiscardHunk?: (hunkIndex: number) => void
}

export type YaadeDiffViewerProps = {
  path: string
  /** Unified (stacked) or split (side-by-side). Ignored for merge conflicts. */
  mode: "unified" | "split"
  theme: YaadeTheme
  /** Editor font size in px (default 13). */
  fontSize?: number
  /**
   * Preferred for git staging: render via Pierre `PatchDiff` so hunk indexes
   * match `listApplyHunks` / `git apply` payloads from the same string.
   */
  patch?: string
  /** Two-file view (commit dialog, untracked). Ignored when `patch` is set. */
  original?: string
  modified?: string
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
  /** Inline hunk Stage / Unstage / Discard (patch-sourced diffs only). */
  hunkActions?: YaadeHunkActions
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

function pierreLineHeight(fontSize: number): number {
  // Pierre's default line height is 20 at 13px.
  return Math.max(1, Math.ceil(fontSize * (20 / 13)))
}

function pierreUnsafeCss(fontSize: number): string {
  const lineHeight = pierreLineHeight(fontSize)
  return [
    // Custom element host defaults to inline — block + bounded width so
    // Pierre's overflow-x:scroll on [data-code] can engage. Set Pierre's own
    // type variables as well as pre/code so gutters and code stay in sync.
    `:host { --diffs-font-size: ${fontSize}px; --diffs-line-height: ${lineHeight}px; --diffs-font-family: var(--font-mono, 'Geist Mono Variable', ui-monospace, monospace); display: block; width: 100%; max-width: 100%; min-width: 0; overflow-x: hidden; background: transparent; color: var(--foreground); }`,
    // Sit the diff on the workbench canvas — no raised panel fill behind hunks.
    `[data-diff], [data-file], [data-code] { background: transparent !important; }`,
    // Default `1fr` tracks are minmax(auto, 1fr) and grow with long lines,
    // which expands the host and gets clipped by our overflow-hidden parents.
    `[data-diff], [data-file] { --diffs-code-grid: var(--diffs-grid-number-column-width) minmax(0, 1fr); }`,
    `[data-diff-type="split"][data-overflow="scroll"] { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }`,
    `pre, code { font-size: ${fontSize}px; font-family: var(--font-mono, 'Geist Mono Variable', ui-monospace, monospace); }`,
    // Hunk action chips in annotation / gutter slots.
    `[data-yaade-hunk-actions] { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.125rem 0; }`,
    `[data-yaade-hunk-actions] button { font: inherit; font-size: 0.77rem; line-height: 1.2; border-radius: 0.25rem; border: 1px solid var(--border); background: var(--secondary); color: var(--foreground); padding: 0.125rem 0.375rem; cursor: pointer; }`,
    `[data-yaade-hunk-actions] button:hover { background: var(--accent); }`,
    `[data-yaade-hunk-actions] button:disabled { opacity: 0.5; cursor: not-allowed; }`,
    `[data-yaade-hunk-actions] button[data-variant="destructive"] { color: var(--destructive); }`,
  ].join("\n")
}

/**
 * Git file diff via `@pierre/diffs`.
 * Callers own chrome (path/status toolbar); Pierre’s file header is disabled.
 * Prefer wrapping ancestors in {@link PierreDiffPool}.
 *
 * Staging view should pass `patch` (from `git diff`) so rendering and
 * `git apply` share one hunk model. Commit / untracked views keep two-file
 * `original`/`modified`. Conflicts use {@link UnresolvedFile}.
 *
 * Scroll + line virtualization live on `Virtualizer`; Shiki runs in the worker pool.
 */
export function YaadeDiffViewer(props: YaadeDiffViewerProps) {
  const {
    path,
    mode,
    theme,
    fontSize = 13,
    patch,
    original = "",
    modified = "",
    conflict = false,
    onConflictResolved,
    hunkActions,
    className,
  } = props
  const themeType = theme.scheme === "light" ? "light" : "dark"
  const usePatch = Boolean(patch?.trim()) && !conflict

  const conflictFile = useMemo(() => {
    if (!conflict) return null
    const key = contentCacheKey("new", path, modified)
    return {
      name: path,
      contents: modified,
      cacheKey: `${key}:merge-conflict`,
    }
  }, [conflict, path, modified])

  const patchFileDiff = useMemo(() => {
    if (!usePatch || !patch?.trim()) return null
    try {
      const diff = getSingularPatch(patch)
      diff.cacheKey = `patch:${path}:${contentCacheKey("new", path, patch)}`
      return diff
    } catch {
      return null
    }
  }, [usePatch, patch, path])

  const fileDiff = useMemo(() => {
    if (conflict || usePatch) return null
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
  }, [conflict, usePatch, path, original, modified])

  const hunkAnnotations = useMemo((): DiffLineAnnotation<HunkActionMeta>[] | undefined => {
    if (!patchFileDiff || !hunkActions) return undefined
    return buildHunkActionAnnotations(patchFileDiff)
  }, [patchFileDiff, hunkActions])

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
      enableGutterUtility: Boolean(hunkActions && patchFileDiff),
    }),
    [themeType, fontSize, hunkActions, patchFileDiff],
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
      lineHeight: pierreLineHeight(fontSize),
      // Header disabled — keep region estimate at 0 via defaults + disableFileHeader.
      diffHeaderHeight: 0,
      spacing: 8,
    }),
    [fontSize],
  )

  const renderHunkAnnotation = (annotation: DiffLineAnnotation<HunkActionMeta>) => {
    if (!hunkActions || annotation.metadata == null) return null
    return (
      <HunkActionButtons
        hunkIndex={annotation.metadata.hunkIndex}
        actions={hunkActions}
      />
    )
  }

  const renderGutterUtility =
    hunkActions && patchFileDiff
      ? (
          getHoveredLine: () =>
            | { lineNumber: number; side: "additions" | "deletions" }
            | undefined,
        ) => {
          const hovered = getHoveredLine()
          if (!hovered) return null
          const hunkIndex = hunkIndexForLine(
            patchFileDiff,
            hovered.lineNumber,
            hovered.side,
          )
          if (hunkIndex == null) return null
          return <HunkActionButtons hunkIndex={hunkIndex} actions={hunkActions} gutter />
        }
      : undefined

  return (
    <div
      data-yaade-pierre-diff=""
      data-yaade-pierre-conflict={conflict ? "" : undefined}
      data-yaade-pierre-patch={usePatch ? "" : undefined}
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
        ) : usePatch && patch ? (
          <PatchDiff
            key={patchFileDiff?.cacheKey ?? `patch:${path}`}
            patch={patch}
            options={diffOptions}
            metrics={metrics}
            className="block h-full w-full min-w-0 max-w-full"
            lineAnnotations={hunkAnnotations}
            renderAnnotation={hunkActions ? renderHunkAnnotation : undefined}
            renderGutterUtility={renderGutterUtility}
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

function HunkActionButtons(props: {
  hunkIndex: number
  actions: YaadeHunkActions
  gutter?: boolean
}) {
  const { hunkIndex, actions, gutter = false } = props
  const disabled = Boolean(actions.disabled)
  return (
    <div
      data-yaade-hunk-actions=""
      data-yaade-hunk-index={String(hunkIndex)}
      data-yaade-hunk-gutter={gutter ? "" : undefined}
      className="inline-flex items-center gap-1"
    >
      {actions.staged ? (
        <button
          type="button"
          data-yaade-hunk-action="unstage"
          disabled={disabled || !actions.onUnstageHunk}
          onClick={event => {
            event.preventDefault()
            event.stopPropagation()
            actions.onUnstageHunk?.(hunkIndex)
          }}
        >
          Unstage
        </button>
      ) : (
        <>
          <button
            type="button"
            data-yaade-hunk-action="stage"
            disabled={disabled || !actions.onStageHunk}
            onClick={event => {
              event.preventDefault()
              event.stopPropagation()
              actions.onStageHunk?.(hunkIndex)
            }}
          >
            Stage
          </button>
          <button
            type="button"
            data-yaade-hunk-action="discard"
            data-variant="destructive"
            disabled={disabled || !actions.onDiscardHunk}
            onClick={event => {
              event.preventDefault()
              event.stopPropagation()
              actions.onDiscardHunk?.(hunkIndex)
            }}
          >
            Discard
          </button>
        </>
      )}
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
