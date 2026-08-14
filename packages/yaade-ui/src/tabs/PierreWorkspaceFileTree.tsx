import { useEffect, useMemo, useRef } from "react"
import { FileTree, useFileTree } from "@pierre/trees/react"
import { FolderTree } from "lucide-react"
import { pierreTreeTokenStyle } from "@/lib/pierre-tree-theme.js"
import { forwardPierreTreeWheel } from "@/lib/pierre-tree-scroll.js"
import { cn } from "@/lib/utils.js"

const explorerTreeStyle = {
  ...pierreTreeTokenStyle,
  "--trees-font-size-override": "var(--yaade-fs-base)",
}

export type PierreWorkspaceFileTreeProps = {
  paths: readonly string[]
  selectedPath: string | null
  onSelectPath: (path: string) => void
  loading?: boolean
  className?: string
}

function parentDirectories(path: string): string[] {
  const segments = path.split("/")
  const directories: string[] = []
  for (let index = 1; index < segments.length; index++) {
    directories.push(segments.slice(0, index).join("/"))
  }
  return directories
}

/** A compact Pierre project navigator for editor sidebars. */
export function PierreWorkspaceFileTree(props: PierreWorkspaceFileTreeProps) {
  const { paths, selectedPath, onSelectPath, loading = false, className } = props
  const pathsKey = paths.join("\0")
  const files = useMemo(() => new Set(paths), [paths])
  const filesRef = useRef(files)
  filesRef.current = files
  const onSelectPathRef = useRef(onSelectPath)
  onSelectPathRef.current = onSelectPath
  const selectedPathRef = useRef(selectedPath)
  selectedPathRef.current = selectedPath
  const syncingSelectionRef = useRef(false)
  const selectedDirectories = useMemo(() => {
    const directories = new Set(selectedPath ? parentDirectories(selectedPath) : [])
    // Keep the first project level visible so files can be opened directly,
    // while leaving deeper folders collapsed until the user expands them.
    for (const path of paths) {
      const firstSlash = path.indexOf("/")
      if (firstSlash > 0) directories.add(path.slice(0, firstSlash))
    }
    return [...directories]
  }, [paths, selectedPath])

  const { model } = useFileTree({
    paths,
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    initialExpandedPaths: selectedDirectories,
    initialSelectedPaths: selectedPath ? [selectedPath] : undefined,
    search: true,
    searchBlurBehavior: "retain",
    stickyFolders: true,
    onSelectionChange: selectedPaths => {
      if (syncingSelectionRef.current) return
      const previous = selectedPathRef.current
      const next =
        selectedPaths.find(
          path => path !== previous && filesRef.current.has(path),
        ) ?? selectedPaths.find(path => filesRef.current.has(path))
      if (!next || next === previous) return
      selectedPathRef.current = next
      onSelectPathRef.current(next)
    },
  })

  useEffect(() => {
    model.resetPaths(paths, { initialExpandedPaths: selectedDirectories })
    // Stable string keys prevent resets when callers recreate equivalent arrays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, pathsKey])

  useEffect(() => {
    if (!selectedPath || !files.has(selectedPath)) return
    for (const directory of parentDirectories(selectedPath)) {
      const item = model.getItem(directory)
      if (item && "expand" in item) item.expand()
    }
    const current = model.getSelectedPaths()
    if (current.length !== 1 || current[0] !== selectedPath) {
      syncingSelectionRef.current = true
      try {
        for (const path of current) model.getItem(path)?.deselect()
        model.getItem(selectedPath)?.select()
      } finally {
        syncingSelectionRef.current = false
      }
    }
    model.scrollToPath(selectedPath, { focus: false, offset: "nearest" })
  }, [files, model, selectedPath])

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col bg-sidebar", className)}
      data-yaade-editor-file-tree=""
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-sidebar-border px-3 text-sm font-medium text-sidebar-foreground">
        <FolderTree className="size-4 text-sidebar-primary" aria-hidden />
        <span className="min-w-0 flex-1 truncate">Explorer</span>
        <span className="font-mono text-3xs text-muted-foreground">
          {loading ? "…" : paths.length}
        </span>
      </div>
      {paths.length === 0 ? (
        <div className="px-3 py-4 text-xs text-muted-foreground">
          {loading ? "Indexing project files…" : "No project files found."}
        </div>
      ) : (
        <FileTree
          model={model}
          aria-label="Project files"
          onWheel={forwardPierreTreeWheel}
          className="h-full min-h-0 w-full min-w-0 bg-transparent"
          style={explorerTreeStyle}
        />
      )}
    </div>
  )
}
