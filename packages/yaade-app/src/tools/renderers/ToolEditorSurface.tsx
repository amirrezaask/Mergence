import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  ChevronRight,
  FileCode2,
  RefreshCcw,
  Save,
  X,
} from "lucide-react"
import type { ToolUse } from "@yaade/rpc"
import {
  fileUriToPath,
  languageIdFromPath,
  pathToFileUri,
} from "@yaade/shared"
import type { LspStatus } from "@yaade/lsp"
import {
  MonacoEditorHost,
  revealPosition,
  type MonacoEditorHandle,
} from "@yaade/monaco"
import { setPendingEditorNavigation } from "@yaade/monaco/pending"
import { PierreWorkspaceFileTree, QuickOpenOverlay, showYaadeToast } from "@yaade/ui"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@yaade/ui/primitives"
import {
  WorkspaceManager,
  WorkspaceService,
  type FileSystemProvider,
} from "@yaade/workspace"
import {
  editorBufferServiceFor,
  retainEditorBufferService,
} from "../../editor/editor-buffer-service.js"
import { ensureMonacoWorkersConfigured } from "../../editor/monaco-workers.js"
import { MuxLspHost, type MuxLspController } from "../../mux/MuxLspHost.js"
import type { YaadeTheme } from "@yaade/shared"

export type ToolEditorSurfaceProps = {
  readonly use: ToolUse
  readonly checkoutPath: string
  readonly theme: YaadeTheme
  readonly fontSize: number
  readonly toolbar?: ReactNode
  readonly visible?: boolean
  /** Optional left rail, used by Search to stay beside the editor. */
  /** Open this URI when the surface is first mounted. */
  readonly initialUri?: string
  readonly initialLine?: number
  readonly initialColumn?: number
  readonly onBack?: () => void
}

type PersistedEditorTabs = {
  readonly tabs: readonly string[]
  readonly activeUri: string | null
}

function absolutePath(root: string, relativePath: string): string {
  if (relativePath.startsWith("/")) return relativePath
  return `${root.replace(/\/+$/, "")}/${relativePath.replace(/^\/+/, "")}`
}

function relativePath(root: string, path: string): string {
  const normalizedRoot = root.replace(/\/+$/, "")
  return path.startsWith(`${normalizedRoot}/`)
    ? path.slice(normalizedRoot.length + 1)
    : path.replace(/^\/+/, "")
}

function fileName(uri: string): string {
  const path = fileUriToPath(uri).replace(/\/+$/, "")
  return path.split("/").at(-1) || path
}

function editorStateKey(useId: string, checkoutPath: string): string {
  return `yaade:editor-tool:${useId}:${checkoutPath}`
}

function loadEditorTabs(key: string): PersistedEditorTabs {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "null")
    if (!parsed || typeof parsed !== "object") return { tabs: [], activeUri: null }
    const rawTabs = Reflect.get(parsed, "tabs")
    const rawActive = Reflect.get(parsed, "activeUri")
    const tabs = Array.isArray(rawTabs)
      ? rawTabs.filter(
          (value): value is string =>
            typeof value === "string" && value.startsWith("file://"),
        )
      : []
    const activeUri =
      typeof rawActive === "string" && tabs.includes(rawActive)
        ? rawActive
        : (tabs.at(-1) ?? null)
    return { tabs, activeUri }
  } catch {
    return { tabs: [], activeUri: null }
  }
}

function saveEditorTabs(
  key: string,
  tabs: readonly string[],
  activeUri: string | null,
): void {
  try {
    localStorage.setItem(key, JSON.stringify({ tabs, activeUri }))
  } catch {
    /* localStorage may be unavailable */
  }
}

function platformFileSystem(): FileSystemProvider {
  const fs = window.yaade?.fs
  if (!fs) throw new Error("Host filesystem is unavailable")
  return {
    readFile: uri => fs.readFile(uri),
    writeFile: (uri, content) => fs.writeFile(uri, content),
    readDir: uri => fs.readDir(uri),
    stat: uri => fs.stat(uri),
    ...(fs.exists ? { exists: (uri: string) => fs.exists!(uri) } : {}),
  }
}

/**
 * The canonical Monaco surface for editor and search tools.
 *
 * Keeping file loading, buffer ownership, the explorer rail, and the LSP host
 * in one surface is intentional: opening a search result must be the same
 * editor experience as opening the file from the Editor tool.
 */
export function ToolEditorSurface(props: ToolEditorSurfaceProps) {
  const rootUri = pathToFileUri(props.checkoutPath)
  const ownerId = `tool-editor:${props.use.id}`
  const storageKey = editorStateKey(props.use.id, props.checkoutPath)
  const initialTabs = useMemo(() => {
    const loaded = loadEditorTabs(storageKey)
    if (!props.initialUri || loaded.tabs.includes(props.initialUri)) {
      return {
        tabs: loaded.tabs,
        activeUri: props.initialUri ?? loaded.activeUri,
      }
    }
    return {
      tabs: [...loaded.tabs, props.initialUri],
      activeUri: props.initialUri,
    }
  }, [props.initialUri, storageKey])
  const [tabs, setTabs] = useState<readonly string[]>(initialTabs.tabs)
  const [activeUri, setActiveUri] = useState<string | null>(initialTabs.activeUri)
  const [filePaths, setFilePaths] = useState<readonly string[]>([])
  const [fileTreeLoading, setFileTreeLoading] = useState(true)
  const [explorerOpen, setExplorerOpen] = useState(() =>
    window.matchMedia("(min-width: 1024px)").matches,
  )
  const [workspaceReady, setWorkspaceReady] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [opening, setOpening] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingCloseUri, setPendingCloseUri] = useState<string | null>(null)
  const [lspStatus, setLspStatus] = useState<LspStatus>("idle")
  const lspControllerRef = useRef<MuxLspController | null>(null)
  const [, refreshBuffers] = useReducer((revision: number) => revision + 1, 0)
  const mountedRef = useRef(true)
  const editorRef = useRef<MonacoEditorHandle | null>(null)
  const initialUriRef = useRef(props.initialUri)

  const workspaceManager = useMemo(() => new WorkspaceManager(platformFileSystem()), [])
  const workspace = useMemo(() => new WorkspaceService(workspaceManager), [workspaceManager])
  // Tool sessions are app_sessions, not the legacy project_sessions rows used
  // by the recovery HTTP API. Keep this shared surface's buffer lifecycle
  // session-neutral until recovery is keyed by ToolUse/session identity.
  const buffers = useMemo(() => editorBufferServiceFor(workspace), [workspace])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => retainEditorBufferService(workspace), [workspace])

  useEffect(() => {
    const subscription = buffers.onDidChange(() => refreshBuffers())
    return () => subscription.dispose()
  }, [buffers])

  useEffect(() => {
    let cancelled = false
    setWorkspaceReady(false)
    void workspace.openWorkspace(props.checkoutPath).then(
      () => {
        if (!cancelled) setWorkspaceReady(true)
      },
      cause => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not open the editor workspace",
          )
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [props.checkoutPath, workspace])

  useEffect(() => {
    let cancelled = false
    setFileTreeLoading(true)
    void window.yaade?.search
      ?.listFiles(rootUri)
      .then(page => {
        if (!cancelled) setFilePaths(page.items)
      })
      .catch(() => {
        if (!cancelled) setFilePaths([])
      })
      .finally(() => {
        if (!cancelled) setFileTreeLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [rootUri])

  useEffect(() => {
    saveEditorTabs(storageKey, tabs, activeUri)
  }, [activeUri, storageKey, tabs])

  useEffect(() => {
    if (!workspaceReady || tabs.length === 0) return
    let cancelled = false
    void Promise.all(
      tabs.map(async uri => {
        try {
          await ensureMonacoWorkersConfigured()
          if (uri === props.initialUri && props.initialLine != null) {
            setPendingEditorNavigation(uri, {
              line: props.initialLine,
              column: props.initialColumn ?? 1,
            })
          }
          await buffers.open({
            uri,
            languageId: languageIdFromPath(fileUriToPath(uri)),
            ownerId,
          })
          return uri
        } catch (cause) {
          if (uri === activeUri && !cancelled) {
            setError(
              cause instanceof Error
                ? cause.message
                : `Could not open ${fileName(uri)}`,
            )
          }
          return null
        }
      }),
    ).then(opened => {
      if (cancelled) return
      const available = opened.filter((uri): uri is string => uri != null)
      setTabs(available)
      setActiveUri(current =>
        current && available.includes(current)
          ? current
          : (available.at(-1) ?? null),
      )
    })
    return () => {
      cancelled = true
    }
    // Initial/restored tab hydration only. New tabs are opened by openUri.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceReady])

  const openUri = useCallback(
    async (uri: string, line?: number, column?: number) => {
      if (!workspaceReady) return
      if (line != null) {
        const nextColumn = column ?? 1
        setPendingEditorNavigation(uri, { line, column: nextColumn })
        const editor = editorRef.current
        if (editor?.getModel()?.uri.toString() === uri) {
          revealPosition(editor, line, nextColumn)
        }
      }
      setOpening(true)
      setError(null)
      try {
        await ensureMonacoWorkersConfigured()
        await buffers.open({
          uri,
          languageId: languageIdFromPath(fileUriToPath(uri)),
          ownerId,
        })
        if (!mountedRef.current) return
        setTabs(previous => (previous.includes(uri) ? previous : [...previous, uri]))
        setActiveUri(uri)
      } catch (cause) {
        if (mountedRef.current) {
          setError(
            cause instanceof Error ? cause.message : `Could not open ${fileName(uri)}`,
          )
        }
      } finally {
        if (mountedRef.current) setOpening(false)
      }
    },
    [buffers, ownerId, workspaceReady],
  )

  // Search results stay inside this surface. Changing the selected hit must
  // behave like opening another file in the Editor tool, not require a React
  // remount (which would lose the shared Monaco model and LSP ownership).
  useEffect(() => {
    const uri = props.initialUri
    if (!uri || !workspaceReady) return
    if (initialUriRef.current !== uri) {
      initialUriRef.current = uri
      void openUri(uri, props.initialLine, props.initialColumn)
      return
    }
    if (props.initialLine == null || activeUri !== uri) return
    const column = props.initialColumn ?? 1
    setPendingEditorNavigation(uri, { line: props.initialLine, column })
    const editor = editorRef.current
    if (editor?.getModel()?.uri.toString() === uri) {
      revealPosition(editor, props.initialLine, column)
    }
  }, [activeUri, openUri, props.initialColumn, props.initialLine, props.initialUri, workspaceReady])

  const openFile = useCallback(
    (nextPath: string) => {
      void openUri(pathToFileUri(absolutePath(props.checkoutPath, nextPath)))
    },
    [openUri, props.checkoutPath],
  )

  const saveUri = useCallback(
    async (uri: string) => {
      setSaving(true)
      try {
        await buffers.save(uri)
        showYaadeToast(`Saved ${fileName(uri)}`, { variant: "success" })
      } catch (cause) {
        showYaadeToast(
          cause instanceof Error ? cause.message : `Could not save ${fileName(uri)}`,
          { variant: "destructive" },
        )
        throw cause
      } finally {
        if (mountedRef.current) setSaving(false)
      }
    },
    [buffers],
  )

  const saveActive = useCallback(() => {
    if (activeUri) void saveUri(activeUri).catch(() => undefined)
  }, [activeUri, saveUri])

  const removeTab = useCallback(
    (uri: string) => {
      buffers.close(uri, { ownerId })
      setTabs(previous => {
        const index = previous.indexOf(uri)
        const next = previous.filter(candidate => candidate !== uri)
        setActiveUri(current =>
          current === uri
            ? (next[Math.min(index, next.length - 1)] ?? null)
            : current,
        )
        return next
      })
    },
    [buffers, ownerId],
  )

  const requestCloseTab = useCallback(
    (uri: string) => {
      if (buffers.snapshot(uri)?.dirty) {
        setPendingCloseUri(uri)
        return
      }
      removeTab(uri)
    },
    [buffers, removeTab],
  )

  const handleLspReady = useCallback(
    (controller: MuxLspController | null) => {
      lspControllerRef.current = controller
      buffers.setLspHooks(
        controller
          ? { open: controller.open, close: controller.close, save: controller.save }
          : null,
      )
    },
    [buffers],
  )

  const quickOpenSearch = useCallback(
    async (query: string, _workspaceId: string | null, signal: AbortSignal) => {
      const page = await window.yaade?.search?.fileSearch(rootUri, query, {
        pageSize: 100,
        ...(activeUri
          ? { currentFile: relativePath(props.checkoutPath, fileUriToPath(activeUri)) }
          : {}),
      })
      return signal.aborted ? [] : (page?.items ?? [])
    },
    [activeUri, props.checkoutPath, rootUri],
  )

  useEffect(() => {
    const showQuickOpen = () => setQuickOpen(true)
    window.addEventListener("yaade:quick-open", showQuickOpen)
    return () => window.removeEventListener("yaade:quick-open", showQuickOpen)
  }, [])

  const selectedPath = activeUri
    ? relativePath(props.checkoutPath, fileUriToPath(activeUri))
    : null
  const breadcrumbSegments = selectedPath?.split("/").filter(Boolean) ?? []
  const activeSnapshot = activeUri ? buffers.snapshot(activeUri) : null
  // Identify the file currently shown in the shared editor. Search's quick
  // open and explorer can change the active tab without changing the result
  // that the Back button returns to.
  const searchEditor = props.onBack && activeUri ? activeUri : undefined
  const activeLine =
    searchEditor && activeUri === props.initialUri ? props.initialLine : undefined

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-yaade-editor-tool
      {...(searchEditor ? { "data-yaade-search-editor": searchEditor } : {})}
    >
      {props.toolbar}
      {props.onBack ? (
        <div className="flex h-9 shrink-0 items-center border-b border-border px-2">
          <Button type="button" size="sm" variant="ghost" onClick={props.onBack}>
            <ChevronRight className="mr-1 size-3.5 rotate-180" aria-hidden />
            Search results
          </Button>
        </div>
      ) : null}
      {workspaceReady ? (
        <MuxLspHost
          workspace={workspace}
          processCwdUri={rootUri}
          onOpenFile={(uri, _path, line, column) => {
            void openUri(uri, line, column)
          }}
          onReady={handleLspReady}
          onStatusChange={setLspStatus}
        />
      ) : null}
      <div className="flex min-h-0 flex-1">
        <aside
          id={`editor-explorer-${props.use.id}`}
          className={
            explorerOpen
              ? "w-56 shrink-0 border-r border-sidebar-border sm:w-64"
              : "w-9 shrink-0 border-r border-sidebar-border"
          }
        >
          <PierreWorkspaceFileTree
            paths={filePaths}
            selectedPath={selectedPath}
            loading={fileTreeLoading}
            collapsed={!explorerOpen}
            explorerId={`editor-explorer-${props.use.id}`}
            onToggleExplorer={() => setExplorerOpen(open => !open)}
            onSelectPath={openFile}
          />
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            className="flex h-8 shrink-0 items-end border-b border-border bg-muted/25"
            role="tablist"
            aria-label="Open files"
            data-yaade-editor-tabs=""
          >
            <div className="flex min-w-0 flex-1 self-stretch overflow-x-auto">
              {tabs.map(uri => {
                const snapshot = buffers.snapshot(uri)
                const active = uri === activeUri
                return (
                  <div
                    key={uri}
                    className={
                      active
                        ? "group flex min-w-28 max-w-48 items-center border-r border-border bg-background text-foreground"
                        : "group flex min-w-28 max-w-48 items-center border-r border-border text-muted-foreground hover:bg-muted/45 hover:text-foreground"
                    }
                    data-yaade-editor-tab={uri}
                    data-active={active ? "true" : undefined}
                    data-dirty={snapshot?.dirty ? "true" : undefined}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      className="min-w-0 flex-1 self-stretch truncate px-2 text-left font-mono text-2xs outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={() => setActiveUri(uri)}
                      title={fileUriToPath(uri)}
                    >
                      {snapshot?.dirty ? "● " : ""}
                      {fileName(uri)}
                    </button>
                    <button
                      type="button"
                      className="mr-1 grid size-5 shrink-0 place-items-center rounded-sm opacity-0 outline-none hover:bg-muted group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring"
                      aria-label={`Close ${fileName(uri)}`}
                      onClick={() => requestCloseTab(uri)}
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </div>
                )
              })}
            </div>
            <div
              className="flex h-full shrink-0 items-center gap-0.5 border-l border-border px-1"
              data-yaade-editor-lsp-status={lspStatus}
            >
              {activeUri ? (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  disabled={!activeSnapshot?.dirty || saving}
                  aria-label="Save file"
                  onClick={saveActive}
                >
                  <Save className="size-3.5" />
                </Button>
              ) : null}
            </div>
          </div>

          {activeUri ? (
            <>
              <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border px-2">
                <nav
                  className="min-w-0 flex-1 overflow-hidden"
                  aria-label="File path"
                  data-yaade-editor-breadcrumbs=""
                >
                  <ol className="flex min-w-0 items-center overflow-hidden font-mono text-3xs">
                    {breadcrumbSegments.map((segment, index) => {
                      const current = index === breadcrumbSegments.length - 1
                      return (
                        <li key={`${segment}-${index}`} className="flex min-w-0 items-center">
                          {index > 0 ? (
                            <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" aria-hidden />
                          ) : (
                            <FileCode2 className="mr-1.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                          )}
                          <span
                            className={current ? "truncate text-foreground" : "truncate text-muted-foreground"}
                          >
                            {segment}
                            {current && activeLine != null ? `:${activeLine}` : ""}
                          </span>
                        </li>
                      )
                    })}
                  </ol>
                </nav>
              </div>
              {activeSnapshot?.externalConflict ? (
                <div
                  className="flex shrink-0 items-center gap-2 border-b border-warning/35 bg-warning/10 px-3 py-1 text-2xs"
                  role="alert"
                  data-yaade-editor-conflict="true"
                >
                  <span className="min-w-0 flex-1 truncate">
                    This file changed on disk while your edits were unsaved.
                  </span>
                  <Button size="xs" variant="ghost" onClick={() => void buffers.keepMine(activeUri)}>
                    Keep mine
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => void buffers.reloadFromDisk(activeUri)}>
                    Reload
                  </Button>
                </div>
              ) : null}
              <div className="min-h-0 flex-1">
                {error ? (
                  <div className="grid h-full place-items-center p-6 text-sm text-destructive">
                    {error}
                  </div>
                ) : buffers.get(activeUri) ? (
                  <MonacoEditorHost
                    uri={activeUri}
                    content=""
                    languageId={languageIdFromPath(fileUriToPath(activeUri))}
                    theme={props.theme}
                    fontSize={props.fontSize}
                    autoFocus={props.visible !== false}
                    viewStateId={`tool-editor:${props.use.id}`}
                    onReady={editor => {
                      editorRef.current = editor
                    }}
                    onQuickOpen={() => setQuickOpen(true)}
                    onSave={saveActive}
                  />
                ) : (
                  <div className="grid h-full place-items-center text-sm text-muted-foreground">
                    {opening ? "Opening editor…" : "Loading buffer…"}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="grid h-full place-items-center p-8 text-center">
              <div>
                <FileCode2 className="mx-auto mb-3 size-8 text-primary/70" aria-hidden />
                <p className="text-sm font-medium text-foreground">Open a file to start editing</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose a file from the explorer or use Quick Open.
                </p>
                <Button className="mt-4" size="sm" variant="outline" onClick={() => setQuickOpen(true)}>
                  Open Quick Open
                </Button>
              </div>
            </div>
          )}
        </div>

      </div>

      <QuickOpenOverlay
        open={quickOpen}
        onOpenChange={setQuickOpen}
        onSearch={quickOpenSearch}
        onSelect={(path, query) => {
          void window.yaade?.search?.trackFileAccess?.(rootUri, query, path)
          openFile(path)
        }}
      />

      <Dialog
        open={pendingCloseUri != null}
        onOpenChange={open => {
          if (!open) setPendingCloseUri(null)
        }}
      >
        <DialogContent size="prompt">
          <DialogHeader>
            <DialogTitle>Save changes?</DialogTitle>
            <DialogDescription>
              {pendingCloseUri
                ? `Save changes to ${fileName(pendingCloseUri)} before closing it?`
                : "Save changes before closing this file?"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingCloseUri(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const uri = pendingCloseUri
                if (!uri) return
                void buffers.discard(uri).then(() => {
                  removeTab(uri)
                  setPendingCloseUri(null)
                })
              }}
            >
              Don’t save
            </Button>
            <Button
              onClick={() => {
                const uri = pendingCloseUri
                if (!uri) return
                void saveUri(uri).then(() => {
                  removeTab(uri)
                  setPendingCloseUri(null)
                })
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {activeUri && lspStatus === "disconnected" ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="absolute right-3 bottom-11 gap-1.5 shadow-sm"
          onClick={() => void lspControllerRef.current?.restart(activeUri)}
        >
          <RefreshCcw className="size-3.5" />
          Restart language server
        </Button>
      ) : null}
    </div>
  )
}

export default ToolEditorSurface
