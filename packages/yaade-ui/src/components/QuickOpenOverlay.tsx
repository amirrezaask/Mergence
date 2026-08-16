import { useEffect, useMemo, useRef, useState } from "react"
import { Spinner } from "@/components/ui/spinner.js"
import { Button } from "@/components/ui/button.js"
import { FileIcon } from "@/lib/file-icon.js"
import { cn } from "@/lib/utils.js"
import { PaletteShell, type PaletteShellItem } from "./palette/PaletteShell.js"

export type QuickOpenWorkspace = {
  id: string
  name: string
}

const EMPTY_WORKSPACES: readonly QuickOpenWorkspace[] = []

type QuickOpenEntry = {
  path: string
  name: string
  directory: string
}

function quickOpenEntry(path: string): QuickOpenEntry {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  if (separator < 0) return { path, name: path, directory: "" }
  return {
    path,
    name: path.slice(separator + 1) || path,
    directory: path.slice(0, separator),
  }
}

export function QuickOpenOverlay({
  open,
  onOpenChange,
  onSearch,
  scanReady = true,
  workspaces = EMPTY_WORKSPACES,
  defaultWorkspaceId = null,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSearch: (
    query: string,
    workspaceId: string | null,
    signal: AbortSignal,
  ) => Promise<string[]>
  scanReady?: boolean
  workspaces?: readonly QuickOpenWorkspace[]
  defaultWorkspaceId?: string | null
  onSelect: (path: string, query: string, workspaceId: string | null) => void
}) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<string[]>([])
  const [searching, setSearching] = useState(false)
  const [workspaceId, setWorkspaceId] = useState<string | null>(defaultWorkspaceId)
  const searchGen = useRef(0)
  const searchController = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) {
      setQuery("")
      setResults([])
      setSearching(false)
      setWorkspaceId(defaultWorkspaceId)
    }
  }, [open, defaultWorkspaceId])

  useEffect(() => {
    if (!open || !scanReady) {
      searchGen.current += 1
      searchController.current?.abort()
      searchController.current = null
      setResults([])
      setSearching(false)
      return
    }

    const gen = ++searchGen.current
    searchController.current?.abort()
    const controller = new AbortController()
    searchController.current = controller
    const spinnerId = window.setTimeout(() => {
      if (gen === searchGen.current) setSearching(true)
    }, 60)
    void onSearch(query, workspaceId, controller.signal).then(
      paths => {
        if (!controller.signal.aborted && gen === searchGen.current) setResults(paths)
      },
      () => {
        if (!controller.signal.aborted && gen === searchGen.current) setResults([])
      },
    ).finally(() => {
      window.clearTimeout(spinnerId)
      if (searchController.current === controller) searchController.current = null
      if (!controller.signal.aborted && gen === searchGen.current) setSearching(false)
    })
    return () => {
      window.clearTimeout(spinnerId)
      controller.abort()
    }
  }, [open, scanReady, query, onSearch, workspaceId])

  const items = useMemo<PaletteShellItem<QuickOpenEntry>[]>(
    () => results.map(path => ({ key: path, value: path, data: quickOpenEntry(path) })),
    [results],
  )

  const statusRow = workspaces.length > 1 || !scanReady || searching ? (
    <div className="flex min-h-9 items-center justify-between gap-2 border-b px-2 py-1 text-xs text-muted-foreground">
      {workspaces.length > 1 ? (
        <div
          role="group"
          aria-label="Filter files by workspace"
          className="flex min-w-0 items-center gap-0.5 overflow-x-auto"
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("h-7 shrink-0 px-2 text-xs", workspaceId === null && "bg-accent text-accent-foreground")}
            aria-pressed={workspaceId === null}
            onClick={() => setWorkspaceId(null)}
          >
            All
          </Button>
          {workspaces.map(workspace => (
            <Button
              key={workspace.id}
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                "h-7 max-w-[11rem] shrink-0 px-2 text-xs",
                workspaceId === workspace.id && "bg-accent text-accent-foreground",
              )}
              aria-pressed={workspaceId === workspace.id}
              aria-label={`Only ${workspace.name}`}
              onClick={() => setWorkspaceId(workspace.id)}
            >
              <span className="truncate">{workspace.name}</span>
            </Button>
          ))}
        </div>
      ) : <span />}
      {!scanReady ? (
        <span className="flex items-center gap-2 px-1"><Spinner />Indexing workspace…</span>
      ) : searching ? (
        <span className="flex items-center gap-2 px-1"><Spinner />Searching…</span>
      ) : null}
    </div>
  ) : undefined

  return (
    <PaletteShell
      open={open}
      onOpenChange={onOpenChange}
      title="Quick open"
      description="Type a file name…"
      placeholder={scanReady ? "Type a file name…" : "Indexing workspace…"}
      disabled={!scanReady}
      query={query}
      onQueryChange={setQuery}
      items={items}
      shouldFilter={false}
      onSelect={entry => onSelect(entry.path, query, workspaceId)}
      emptyLabel={scanReady ? "No matching files." : "Waiting for index…"}
      statusRow={statusRow}
      contentWidthMono
      renderItem={entry => (
        <>
          <FileIcon path={entry.path} />
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs text-foreground"
            title={entry.path}
          >
            {entry.path}
          </span>
        </>
      )}
    />
  )
}
