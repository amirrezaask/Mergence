import { useEffect, useMemo, useRef, type CSSProperties } from "react"
import type { GitCommitFile, GitFileStatus, GitStatusEntry } from "@yaade/shared"
import type { GitStatus as PierreGitStatus } from "@pierre/trees"
import { FileTree, useFileTree } from "@pierre/trees/react"

import { Button } from "@/components/ui/button.js"
import { cn } from "@/lib/utils.js"

export type PierreCommitFileTreeProps = {
  files: readonly GitCommitFile[]
  /** Working-tree staging metadata when the dialog is showing uncommitted changes. */
  workingTreeEntries?: readonly GitStatusEntry[]
  selectedPath: string | null
  onSelectPath: (path: string) => void
  workingTree?: boolean
  pendingPath?: string | null
  onToggleStage?: (file: GitCommitFile) => void
  className?: string
}

function toPierreGitStatus(status: GitFileStatus): PierreGitStatus {
  if (status === "conflict") return "modified"
  if (status === "untracked") return "untracked"
  if (status === "added") return "added"
  if (status === "deleted") return "deleted"
  if (status === "renamed") return "renamed"
  return "modified"
}

function filePathSet(files: readonly GitCommitFile[]): Set<string> {
  return new Set(files.map(file => file.path))
}

function ancestorDirs(paths: readonly string[]): string[] {
  const dirs = new Set<string>()
  for (const path of paths) {
    const parts = path.split("/")
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/"))
    }
  }
  return [...dirs]
}

/**
 * Pierre `@pierre/trees` file navigator for the commit / working-tree diff modal.
 * Selection drives the adjacent Pierre diff pane; stage/unstage lives in the
 * row context menu when `workingTree` is on.
 */
export function PierreCommitFileTree(props: PierreCommitFileTreeProps) {
  const {
    files,
    workingTreeEntries = [],
    selectedPath,
    onSelectPath,
    workingTree = false,
    pendingPath = null,
    onToggleStage,
    className,
  } = props

  const paths = useMemo(() => files.map(file => file.path), [files])
  const pathsKey = paths.join("\0")
  const expandedDirs = useMemo(() => ancestorDirs(paths), [paths])
  const expandedKey = expandedDirs.join("\0")
  const fileByPath = useMemo(() => new Map(files.map(file => [file.path, file])), [files])
  const filesRef = useRef(fileByPath)
  filesRef.current = fileByPath
  const onSelectPathRef = useRef(onSelectPath)
  onSelectPathRef.current = onSelectPath
  const workingTreeRef = useRef(workingTree)
  workingTreeRef.current = workingTree

  const gitStatus = useMemo(
    () =>
      files.map(file => ({
        path: file.path,
        status: toPierreGitStatus(file.status),
      })),
    [files],
  )
  const gitStatusKey = gitStatus.map(entry => `${entry.path}:${entry.status}`).join("\0")

  const stagedByPath = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const entry of workingTreeEntries) {
      map.set(entry.path, entry.staged)
    }
    return map
  }, [workingTreeEntries])
  const stagedByPathRef = useRef(stagedByPath)
  stagedByPathRef.current = stagedByPath
  const stagedKey = [...stagedByPath.entries()]
    .map(([path, staged]) => `${path}:${staged ? 1 : 0}`)
    .join("\0")

  const { model } = useFileTree({
    paths,
    initialExpansion: "open",
    initialExpandedPaths: expandedDirs,
    initialSelectedPaths: selectedPath ? [selectedPath] : undefined,
    gitStatus,
    search: files.length > 12,
    stickyFolders: true,
    composition: workingTree
      ? {
          contextMenu: {
            enabled: true,
            triggerMode: "both",
            buttonVisibility: "when-needed",
          },
        }
      : undefined,
    onSelectionChange: selectedPaths => {
      const next = selectedPaths.find(path => filesRef.current.has(path))
      if (next) onSelectPathRef.current(next)
    },
    renderRowDecoration: ({ item }) => {
      if (item.kind !== "file") return null
      const file = filesRef.current.get(item.path)
      if (!file) return null
      if (file.status === "conflict") {
        return { text: "!", title: "Merge conflict" }
      }
      if (workingTreeRef.current && stagedByPathRef.current.get(item.path)) {
        return { text: "S", title: "Staged" }
      }
      return null
    },
  })

  useEffect(() => {
    model.resetPaths(paths, { initialExpandedPaths: expandedDirs })
    // pathsKey / expandedKey track identity without depending on array reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, pathsKey, expandedKey])

  useEffect(() => {
    model.setGitStatus(gitStatus)
    // Re-apply after stage toggles so row decorations re-read staged refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, gitStatusKey, stagedKey])

  useEffect(() => {
    if (!selectedPath || !filePathSet(files).has(selectedPath)) return
    const current = model.getSelectedPaths()
    if (current.length === 1 && current[0] === selectedPath) return
    model.getItem(selectedPath)?.select()
    model.scrollToPath(selectedPath, { focus: false, offset: "nearest" })
  }, [model, selectedPath, pathsKey, files])

  if (files.length === 0) {
    return (
      <div className={cn("px-2 py-3 text-2xs text-muted-foreground", className)}>
        No files changed in this commit.
      </div>
    )
  }

  return (
    <FileTree
      model={model}
      data-yaade-pierre-file-tree=""
      className={cn("h-full min-h-0 w-full min-w-0 bg-transparent", className)}
      style={
        {
          "--trees-theme-list-active-selection-bg":
            "color-mix(in oklab, var(--accent) 22%, transparent)",
          "--trees-theme-list-hover-bg":
            "color-mix(in oklab, var(--accent) 10%, transparent)",
          "--trees-theme-focus-ring": "var(--ring)",
          "--trees-theme-git-modified": "var(--git-modified)",
          "--trees-theme-git-added": "var(--git-added)",
          "--trees-theme-git-deleted": "var(--git-deleted)",
          "--trees-theme-git-untracked": "var(--git-added)",
          "--trees-theme-git-renamed": "var(--git-modified)",
          fontFamily: "var(--font-mono, 'Commit Mono', ui-monospace, monospace)",
          fontSize: "var(--yaade-fs-2xs)",
        } as CSSProperties
      }
      renderContextMenu={
        workingTree && onToggleStage
          ? (item, context) => {
              if (item.kind !== "file") return null
              const file = fileByPath.get(item.path)
              if (!file) return null
              const staged = stagedByPath.get(item.path) ?? false
              const pending = pendingPath !== null
              return (
                <div
                  data-file-tree-context-menu-root="true"
                  className="rounded-md border border-border bg-popover p-1 shadow-md"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    className="w-full justify-start"
                    onClick={() => {
                      context.close({ restoreFocus: false })
                      onToggleStage(file)
                    }}
                  >
                    {staged ? "Unstage" : "Stage"}
                  </Button>
                </div>
              )
            }
          : undefined
      }
    />
  )
}
