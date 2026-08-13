import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import { SearchIcon } from "lucide-react"
import { pathToFileUri } from "@yaade/shared"
import { FileIcon } from "@/lib/file-icon.js"
import {
  applyPathCompletion,
  deletePathSegmentBackward,
  isPathUnderRoot,
  parsePathCompletionContext,
  resolvePathForOpen,
} from "@yaade/workspace"
import {
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog.js"
import { Button } from "@/components/ui/button.js"
import { Input } from "@/components/ui/input.js"
import { KeyBindingKbd } from "./KeyBindingKbd.js"
import { formatKeyBinding } from "@/lib/format-key.js"
import { COMMAND_NO_SELECTION } from "@/lib/command-shell.js"
import { cn } from "@/lib/utils.js"

type DirEntry = {
  uri: string
  name: string
  isDirectory: boolean
}

const MAX_DIR_ENTRIES = 500

function isListNavModified(e: KeyboardEvent): boolean {
  return e.shiftKey || e.metaKey || e.ctrlKey || e.altKey
}

export type CdOverlayProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialPath: string | null
  onSelectFolder: (absPath: string) => void | Promise<void>
  onSelectFile?: (uri: string, absPath: string) => void | Promise<void>
  resolveHomeDir?: () => Promise<string>
  workspaceFolders?: { name: string; path: string }[]
  /** Include files in the list. Requires onSelectFile. */
  showFiles?: boolean
  title?: string
  description?: string
  primaryHint?: string
  /** Keep typed and completed paths inside this root (for scoped pickers). */
  restrictToRootPath?: string
}

export function CdOverlay({
  open,
  onOpenChange,
  initialPath,
  onSelectFolder,
  onSelectFile,
  resolveHomeDir,
  workspaceFolders,
  showFiles = false,
  title = "Change directory",
  description = "Path to folder",
  primaryHint = "Open",
  restrictToRootPath,
}: CdOverlayProps) {
  const [pathInput, setPathInput] = useState("")
  const [cursor, setCursor] = useState(0)
  const [homeDir, setHomeDir] = useState("")
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedValue, setSelectedValue] = useState<string>(COMMAND_NO_SELECTION)
  const [showWorkspaceRoots, setShowWorkspaceRoots] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const resolveHomeDirRef = useRef(resolveHomeDir)
  resolveHomeDirRef.current = resolveHomeDir

  const deferredPathInput = useDeferredValue(pathInput)
  const deferredCursor = useDeferredValue(cursor)

  const completionCtx = useMemo(() => {
    if (!homeDir) return null
    return parsePathCompletionContext(deferredPathInput, deferredCursor, homeDir)
  }, [deferredPathInput, deferredCursor, homeDir])

  useEffect(() => {
    if (!open) {
      setPathInput("")
      setCursor(0)
      setHomeDir("")
      setEntries([])
      setError(null)
      setLoading(false)
      setSelectedValue(COMMAND_NO_SELECTION)
      setShowWorkspaceRoots(false)
      return
    }

    const multiRoot = (workspaceFolders?.length ?? 0) > 1
    setShowWorkspaceRoots(multiRoot)

    let cancelled = false
    void (async () => {
      const resolve = resolveHomeDirRef.current
      let home = ""
      if (resolve) {
        try {
          home = await resolve()
        } catch {
          if (!cancelled) setError("Could not resolve a starting directory.")
          return
        }
      }
      if (cancelled) return
      setHomeDir(home)
      if (!multiRoot) {
        const start = initialPath ?? home
        const withSep = start.endsWith("/") || start.endsWith("\\") ? start : `${start}/`
        setPathInput(withSep)
        setCursor(withSep.length)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [open, initialPath, workspaceFolders])

  const readDirGen = useRef(0)

  useEffect(() => {
    if (!open || !completionCtx || !window.yaade?.fs || showWorkspaceRoots) {
      setEntries([])
      return
    }

    const gen = ++readDirGen.current
    let spinnerId: number | undefined
    const parentPath = completionCtx.parentPath
    const run = () => {
      spinnerId = window.setTimeout(() => {
        if (gen === readDirGen.current) setLoading(true)
      }, 60)
      setError(null)
      void window.yaade!.fs!
        .readDir(pathToFileUri(parentPath))
        .then(list => {
          if (spinnerId !== undefined) window.clearTimeout(spinnerId)
          if (gen !== readDirGen.current) return
          setEntries(
            list
              .filter(e => e.isDirectory || showFiles)
              .map(e => ({ uri: e.uri, name: e.name, isDirectory: e.isDirectory }))
              .sort((a, b) => {
                if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
                return a.name.localeCompare(b.name)
              })
              .slice(0, MAX_DIR_ENTRIES),
          )
          setLoading(false)
        })
        .catch(() => {
          if (spinnerId !== undefined) window.clearTimeout(spinnerId)
          if (gen !== readDirGen.current) return
          setEntries([])
          setError("Cannot read this directory.")
          setLoading(false)
        })
    }

    const id = window.setTimeout(run, 80)
    return () => {
      window.clearTimeout(id)
      if (spinnerId !== undefined) window.clearTimeout(spinnerId)
    }
  }, [open, completionCtx?.parentPath, showWorkspaceRoots, showFiles])

  const workspaceRootItems = useMemo(() => {
    if (!showWorkspaceRoots || !workspaceFolders) return []
    const q = pathInput.trim().toLowerCase()
    return workspaceFolders.filter(
      f =>
        !q ||
        f.name.toLowerCase().includes(q) ||
        f.path.toLowerCase().includes(q),
    )
  }, [showWorkspaceRoots, workspaceFolders, pathInput])

  const pickWorkspaceRoot = useCallback(
    (path: string) => {
      setShowWorkspaceRoots(false)
      const withSep = path.endsWith("/") || path.endsWith("\\") ? path : `${path}/`
      setPathInput(withSep)
      setCursor(withSep.length)
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(withSep.length, withSep.length)
      })
    },
    [],
  )

  const completions = useMemo(() => {
    if (!completionCtx) return []
    const prefix = completionCtx.partial.toLowerCase()
    return entries.filter(e => e.name.toLowerCase().startsWith(prefix))
  }, [completionCtx, entries])

  const ghostCompletion = useMemo(() => {
    if (!completionCtx || completions.length === 0) return ""
    const partial = completionCtx.partial
    const first = completions[0]!.name
    if (!partial) return ""
    if (!first.toLowerCase().startsWith(partial.toLowerCase())) return ""
    return first.slice(partial.length)
  }, [completionCtx, completions])

  useEffect(() => {
    if (showWorkspaceRoots) {
      if (workspaceRootItems.length === 0) {
        setSelectedValue(COMMAND_NO_SELECTION)
        return
      }
      const first = workspaceRootItems[0]!.path
      setSelectedValue(prev => (workspaceRootItems.some(f => f.path === prev) ? prev : first))
      return
    }
    if (completions.length === 0) {
      setSelectedValue(COMMAND_NO_SELECTION)
      return
    }
    const firstUri = completions[0]!.uri
    setSelectedValue(prev => {
      if (completions.some(e => e.uri === prev)) return prev
      return firstUri
    })
  }, [completions, showWorkspaceRoots, workspaceRootItems])

  const syncCursorFromInput = useCallback(() => {
    const el = inputRef.current
    if (el) setCursor(el.selectionStart ?? el.value.length)
  }, [])

  const applyCompletion = useCallback(
    (entry: DirEntry) => {
      if (!completionCtx) return
      if (entry.isDirectory) {
        const { value, cursor: nextCursor } = applyPathCompletion(pathInput, completionCtx, entry.name)
        setPathInput(value)
        setCursor(nextCursor)
        requestAnimationFrame(() => {
          const el = inputRef.current
          if (!el) return
          el.focus()
          el.setSelectionRange(nextCursor, nextCursor)
        })
        return
      }
      const sep = pathInput.includes("\\") ? "\\" : "/"
      const value =
        pathInput.slice(0, completionCtx.segmentStart) +
        entry.name +
        pathInput.slice(completionCtx.segmentEnd)
      void sep
      const nextCursor = completionCtx.segmentStart + entry.name.length
      setPathInput(value)
      setCursor(nextCursor)
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(nextCursor, nextCursor)
      })
    },
    [completionCtx, pathInput],
  )

  const submit = useCallback(() => {
    if (!homeDir || !pathInput.trim()) return
    const path = resolvePathForOpen(pathInput, homeDir)
    if (restrictToRootPath && !isPathUnderRoot(path, restrictToRootPath)) {
      setError(`Choose a path inside ${restrictToRootPath}.`)
      return
    }
    onOpenChange(false)
    const fs = window.yaade?.fs
    void (async () => {
      let isFile = false
      if (showFiles && onSelectFile && fs?.stat) {
        try {
          const uri = pathToFileUri(path)
          // A typed Save As target normally does not exist. Probe through the
          // non-throwing channel before stat so an expected miss does not emit
          // an HTTP 400/browser console error.
          const pathExists = fs.exists ? await fs.exists(uri) : true
          if (pathExists) {
            const info = await fs.stat(uri)
            isFile = !info.isDirectory
          }
        } catch {
          isFile = false
        }
      }
      const fn = isFile && onSelectFile ? () => onSelectFile(pathToFileUri(path), path) : () => onSelectFolder(path)
      try {
        await fn()
      } catch (err) {
        console.warn("Failed to select path:", err)
      }
    })()
  }, [
    homeDir,
    pathInput,
    onSelectFolder,
    onSelectFile,
    onOpenChange,
    restrictToRootPath,
    showFiles,
  ])

  const moveHighlight = useCallback(
    (delta: 1 | -1) => {
      if (showWorkspaceRoots) {
        if (workspaceRootItems.length === 0) return
        const idx = Math.max(
          0,
          workspaceRootItems.findIndex(f => f.path === selectedValue),
        )
        const next = (idx + delta + workspaceRootItems.length) % workspaceRootItems.length
        setSelectedValue(workspaceRootItems[next]!.path)
        return
      }
      if (completions.length === 0) return
      const idx = Math.max(0, completions.findIndex(c => c.uri === selectedValue))
      const next = (idx + delta + completions.length) % completions.length
      setSelectedValue(completions[next]!.uri)
    },
    [completions, selectedValue, showWorkspaceRoots, workspaceRootItems],
  )

  const highlightedEntry = useMemo(() => {
    if (showWorkspaceRoots) {
      return workspaceRootItems.find(f => f.path === selectedValue) ?? null
    }
    return completions.find(e => e.uri === selectedValue) ?? null
  }, [completions, selectedValue, showWorkspaceRoots, workspaceRootItems])

  const canSubmit = Boolean(homeDir && pathInput.trim())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-var(--yaade-quick-input-top)-1rem)] overflow-hidden rounded-md border-border bg-popover p-0 text-popover-foreground shadow-xl backdrop-blur-none"
        motion="instant"
        placement="quick-input"
        size="wide"
        showCloseButton={false}
        data-yaade-quick-input=""
        data-yaade-file-lister=""
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <Command
          shouldFilter={false}
          value={selectedValue}
          onValueChange={setSelectedValue}
          className="border-0"
        >
          <div
            data-slot="command-input-wrapper"
            data-yaade-quick-input-field=""
            className="m-1.5 flex h-8 items-center gap-2 rounded-sm border border-input bg-background px-2 shadow-xs focus-within:border-primary focus-within:ring-1 focus-within:ring-primary"
          >
            <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="relative min-w-0 flex-1">
              <Input
                ref={inputRef}
                type="text"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                placeholder="Path to folder…"
                value={pathInput}
                onChange={e => {
                  setPathInput(e.target.value)
                  setCursor(e.target.selectionStart ?? e.target.value.length)
                }}
                onKeyUp={syncCursorFromInput}
                onClick={syncCursorFromInput}
                onKeyDown={e => {
                  if (e.altKey && e.key === "Backspace") {
                    const el = inputRef.current
                    if (!el) return
                    const start = el.selectionStart ?? pathInput.length
                    const end = el.selectionEnd ?? pathInput.length
                    const result = deletePathSegmentBackward(pathInput, start, end)
                    if (!result) return
                    e.preventDefault()
                    setPathInput(result.value)
                    setCursor(result.cursor)
                    requestAnimationFrame(() => {
                      el.setSelectionRange(result.cursor, result.cursor)
                    })
                    return
                  }

                  if (e.key === "ArrowDown" && !isListNavModified(e)) {
                    e.preventDefault()
                    moveHighlight(1)
                    return
                  }
                  if (e.key === "ArrowUp" && !isListNavModified(e)) {
                    e.preventDefault()
                    moveHighlight(-1)
                    return
                  }

                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    submit()
                    return
                  }

                  if (e.key === "Enter" || e.key === "Tab") {
                    if (showWorkspaceRoots) {
                      const root = workspaceRootItems.find(f => f.path === selectedValue)
                      if (!root) return
                      e.preventDefault()
                      pickWorkspaceRoot(root.path)
                      return
                    }
                    if (!highlightedEntry || !("uri" in highlightedEntry)) return
                    e.preventDefault()
                    applyCompletion(highlightedEntry as DirEntry)
                  }
                }}
                className="h-full border-0 bg-transparent p-0 font-mono text-sm shadow-none focus-visible:ring-0"
                aria-controls="yaade-cd-list"
              />
              {ghostCompletion ? (
                <span
                  className="pointer-events-none absolute inset-0 flex items-center whitespace-pre font-mono text-sm text-muted-foreground/60"
                  aria-hidden
                >
                  <span className="invisible">{pathInput}</span>
                  <span>{ghostCompletion}</span>
                </span>
              ) : null}
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!canSubmit}
              onClick={submit}
              className="h-7 gap-1.5 whitespace-nowrap"
            >
              {primaryHint}
              <KeyBindingKbd binding={formatKeyBinding("Mod-Enter")} />
            </Button>
          </div>
          <CommandList
            id="yaade-cd-list"
            className="max-h-[min(var(--yaade-overlay-list-max),calc(100dvh-var(--yaade-quick-input-top)-7rem))] border-t border-border/70 py-1"
          >
            {error ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">{error}</div>
            ) : showWorkspaceRoots ? (
              <>
                <CommandEmpty>No matching workspace folders.</CommandEmpty>
                <CommandItem value={COMMAND_NO_SELECTION} className="hidden" aria-hidden />
                {workspaceRootItems.map(folder => (
                  <CommandItem
                    key={folder.path}
                    value={folder.path}
                    onSelect={() => pickWorkspaceRoot(folder.path)}
                    className="gap-2"
                  >
                    <FileIcon path={folder.name} isDirectory />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-mono text-foreground">{folder.name}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {folder.path}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </>
            ) : !homeDir || loading ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">Loading…</div>
            ) : (
              <>
                <CommandItem value={COMMAND_NO_SELECTION} className="hidden" aria-hidden />
                {completions.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    No matching directories.
                  </div>
                ) : null}
                {completions.map(entry => (
                  <CommandItem
                    key={entry.uri}
                    value={entry.uri}
                    onSelect={() => applyCompletion(entry)}
                    className="gap-2"
                  >
                    <FileIcon path={entry.name} isDirectory={entry.isDirectory} />
                    <span className="flex-1 truncate font-mono">{entry.name}</span>
                  </CommandItem>
                ))}
              </>
            )}
          </CommandList>
          <div
            className={cn(
              "flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-muted/30",
              "px-3 py-1.5 text-2xs text-muted-foreground",
            )}
          >
            <HintKey binding="ArrowUp" label="Navigate" extra="ArrowDown" />
            <HintKey binding="Tab" label="Autocomplete" extra="Enter" />
            <HintKey binding={formatKeyBinding("Mod-Enter")} label={primaryHint} />
            <HintKey binding={formatKeyBinding("Alt-Backspace")} label="Delete segment" />
            <HintKey binding="Escape" label="Close" />
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function HintKey({
  binding,
  label,
  extra,
}: {
  binding: string
  label: string
  extra?: string
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <KeyBindingKbd binding={binding} />
      {extra ? <KeyBindingKbd binding={extra} /> : null}
      <span>{label}</span>
    </span>
  )
}
