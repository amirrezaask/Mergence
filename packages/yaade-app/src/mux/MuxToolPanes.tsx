import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import {
  AlertCircle,
  Braces,
  FileCode2,
  ListTree,
  Network,
  RefreshCw,
  ScrollText,
} from "lucide-react"
import { fileUriToPath } from "@yaade/shared"
import {
  DefinitionsLocationList,
  DiagnosticsLocationList,
  Lister,
  LocationList,
  ReferencesLocationList,
  showYaadeToast,
  type ListerNode,
} from "@yaade/ui"
import { Button, Input } from "@yaade/ui/primitives"
import type {
  ListDocument,
  ListItem,
  LspLogEntry,
  WorkspaceService,
} from "@yaade/workspace"
import { muxToolPane, type MuxToolKind } from "./tool-pane.js"
import type { MuxLspController } from "./MuxLspHost.js"
import {
  getLspUiSnapshot,
  subscribeLspUi,
  type LspUiOutput,
} from "../lsp-ui-store.js"

type LspPosition = { line: number; character: number }
type LspRange = { start: LspPosition; end: LspPosition }
type LspLocation = { uri: string; range: LspRange }
type LspLocationLink = {
  targetUri: string
  targetRange: LspRange
  targetSelectionRange?: LspRange
}
type LspDocumentSymbol = {
  name: string
  detail?: string
  range: LspRange
  selectionRange: LspRange
  children?: LspDocumentSymbol[]
}
type LspSymbolInformation = {
  name: string
  containerName?: string
  location: LspLocation
}
type LspWorkspaceSymbol = {
  name: string
  containerName?: string
  location:
    | LspLocation
    | { uri: string; range?: LspRange }
}
type LspHierarchyItem = {
  name: string
  detail?: string
  uri: string
  range: LspRange
  selectionRange: LspRange
  [key: string]: unknown
}
type LspCallIncoming = { from: LspHierarchyItem; fromRanges?: LspRange[] }
type LspCallOutgoing = { to: LspHierarchyItem; fromRanges?: LspRange[] }

type LspOutputRow = {
  timestamp: number
  serverId: string
  stream: string
  message: string
  searchText: string
}

export type MuxActiveDocument = {
  uri: string
  line: number
  column: number
}

export type MuxToolPanesProps = {
  kind: MuxToolKind
  revision: number
  workspace: WorkspaceService
  getActiveDocument: () => Promise<MuxActiveDocument | null>
  getLspController: () => MuxLspController | null
  onOpenLocation: (uri: string, line?: number, column?: number) => void
  onOpenBuffer: (uri: string) => void
}

type AsyncItems = {
  items: ListItem[]
  loading: boolean
  error: string | null
}

const EMPTY_ASYNC_ITEMS: AsyncItems = {
  items: [],
  loading: false,
  error: null,
}

function messageForError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function displayPath(uri: string): string {
  try {
    return fileUriToPath(uri)
  } catch {
    return uri
  }
}

function basename(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/")
  return parts.at(-1) || path
}

function locationItem(
  location: LspLocation,
  index: number,
  label?: string,
  detail?: string,
): ListItem {
  const path = displayPath(location.uri)
  const line = location.range.start.line + 1
  const column = location.range.start.character + 1
  return {
    id: `${location.uri}:${line}:${column}:${index}`,
    fileUri: location.uri,
    path,
    line,
    column,
    label: label ?? `${basename(path)}:${line}`,
    ...(detail ? { detail } : {}),
  }
}

function normalizeLocation(
  location: LspLocation | LspLocationLink,
): LspLocation {
  if ("targetUri" in location) {
    return {
      uri: location.targetUri,
      range: location.targetSelectionRange ?? location.targetRange,
    }
  }
  return location
}

function ensureListDocument(
  workspace: WorkspaceService,
  kind: "references" | "definitions",
): ListDocument {
  const tool = muxToolPane(kind)
  const existing = workspace.listStore.get(tool.tabId)
  if (existing) return existing
  const document: ListDocument = {
    id: tool.tabId,
    title: tool.label,
    feed: kind,
    items: [],
  }
  workspace.listStore.create(document)
  return document
}

async function waitForLspController(
  read: () => MuxLspController | null,
): Promise<MuxLspController | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const controller = read()
    if (controller) return controller
    await new Promise<void>(resolve => window.setTimeout(resolve, 50))
  }
  return read()
}

async function activeLsp(
  props: MuxToolPanesProps,
): Promise<{
  document: MuxActiveDocument
  client: NonNullable<Awaited<ReturnType<MuxLspController["resolve"]>>>
}> {
  const document = await props.getActiveDocument()
  if (!document) throw new Error("Focus an editor before using this view")
  const controller = await waitForLspController(props.getLspController)
  const client = await controller?.resolve(document.uri)
  if (!client) throw new Error("No language server is available for this file")
  await client.ready
  return { document, client }
}

function ToolFrame(props: {
  kind: MuxToolKind
  title: string
  icon: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background text-foreground outline-none"
      data-yaade-tool-pane={props.kind}
      tabIndex={-1}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <span className="text-muted-foreground">{props.icon}</span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {props.title}
        </span>
        {props.actions}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{props.children}</div>
    </div>
  )
}

function AsyncLocationView(props: {
  kind: MuxToolKind
  title: string
  icon: ReactNode
  listId: string
  state: AsyncItems
  emptyTitle: string
  emptyDescription: string
  onOpenLocation: MuxToolPanesProps["onOpenLocation"]
  filterPlaceholder?: string
}) {
  return (
    <ToolFrame kind={props.kind} title={props.title} icon={props.icon}>
      {props.state.error ? (
        <div className="border-b border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
          {props.state.error}
        </div>
      ) : null}
      <LocationList
        listId={props.listId}
        items={props.state.items}
        loading={props.state.loading}
        emptyTitle={props.emptyTitle}
        emptyDescription={props.emptyDescription}
        showInput
        filterPlaceholder={props.filterPlaceholder ?? "Filter…"}
        onOpenItem={item =>
          props.onOpenLocation(item.fileUri, item.line, item.column)
        }
      />
    </ToolFrame>
  )
}

function ProblemsTool(props: MuxToolPanesProps) {
  const document = props.workspace.ensureProblemsList()

  useEffect(() => {
    let disposed = false
    let release: (() => void) | null = null
    void import("monaco-editor/esm/vs/editor/editor.api.js").then(monaco => {
      if (disposed) return
      const refresh = () => {
        const items = monaco.editor.getModelMarkers({}).map((marker, index) => {
          const path = displayPath(marker.resource.toString())
          return {
            id: `${marker.resource.toString()}:${marker.startLineNumber}:${marker.startColumn}:${index}`,
            fileUri: marker.resource.toString(),
            path,
            line: marker.startLineNumber,
            column: marker.startColumn,
            label: marker.message,
            detail:
              marker.severity >= monaco.MarkerSeverity.Error
                ? "error"
                : marker.severity >= monaco.MarkerSeverity.Warning
                  ? "warning"
                  : "info",
          } satisfies ListItem
        })
        props.workspace.listStore.update(document.id, { items })
      }
      refresh()
      const subscription = monaco.editor.onDidChangeMarkers(refresh)
      release = () => subscription.dispose()
    })
    return () => {
      disposed = true
      release?.()
    }
  }, [document.id, props.revision, props.workspace])

  return (
    <ToolFrame
      kind="problems"
      title="Problems"
      icon={<AlertCircle className="size-4" />}
    >
      <DiagnosticsLocationList
        listId={document.id}
        workspace={props.workspace}
        onOpenItem={item =>
          props.onOpenLocation(item.fileUri, item.line, item.column)
        }
      />
    </ToolFrame>
  )
}

function ReferenceTool(
  props: MuxToolPanesProps & { kind: "references" | "definitions" },
) {
  const document = ensureListDocument(props.workspace, props.kind)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { document: active, client } = await activeLsp(props)
        const method =
          props.kind === "references"
            ? "textDocument/references"
            : "textDocument/definition"
        if (!client.supports(method)) {
          throw new Error(
            `${props.kind === "references" ? "References" : "Definitions"} are not supported by this language server`,
          )
        }
        const result = await client.sendRequest<
          LspLocation | LspLocationLink | Array<LspLocation | LspLocationLink> | null
        >(method, {
          textDocument: { uri: active.uri },
          position: { line: active.line - 1, character: active.column - 1 },
          ...(props.kind === "references"
            ? { context: { includeDeclaration: true } }
            : {}),
        })
        if (cancelled) return
        const locations = result == null ? [] : Array.isArray(result) ? result : [result]
        const items = locations.map((location, index) =>
          locationItem(normalizeLocation(location), index),
        )
        props.workspace.listStore.update(document.id, {
          title: props.kind === "references" ? "References" : "Definitions",
          items,
        })
      } catch (error) {
        if (cancelled) return
        props.workspace.listStore.update(document.id, { items: [] })
        showYaadeToast(messageForError(error, `Could not load ${props.kind}`), {
          variant: "warning",
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [document.id, props.kind, props.revision, props.workspace])

  return (
    <ToolFrame
      kind={props.kind}
      title={props.kind === "references" ? "References" : "Definitions"}
      icon={<Network className="size-4" />}
    >
      {props.kind === "references" ? (
        <ReferencesLocationList
          listId={document.id}
          workspace={props.workspace}
          onOpenItem={item =>
            props.onOpenLocation(item.fileUri, item.line, item.column)
          }
        />
      ) : (
        <DefinitionsLocationList
          listId={document.id}
          workspace={props.workspace}
          onOpenItem={item =>
            props.onOpenLocation(item.fileUri, item.line, item.column)
          }
        />
      )}
    </ToolFrame>
  )
}

function OutlineTool(props: MuxToolPanesProps) {
  const [state, setState] = useState<AsyncItems>(EMPTY_ASYNC_ITEMS)

  useEffect(() => {
    let cancelled = false
    setState(previous => ({ ...previous, loading: true, error: null }))
    void (async () => {
      try {
        const { document, client } = await activeLsp(props)
        if (!client.supports("textDocument/documentSymbol")) {
          throw new Error("Document symbols are not supported by this language server")
        }
        const symbols = await client.sendRequest<
          Array<LspDocumentSymbol | LspSymbolInformation> | null
        >("textDocument/documentSymbol", { textDocument: { uri: document.uri } })
        const items: ListItem[] = []
        const append = (
          symbol: LspDocumentSymbol | LspSymbolInformation,
          depth: number,
        ) => {
          if ("location" in symbol) {
            items.push(
              locationItem(
                symbol.location,
                items.length,
                symbol.name,
                symbol.containerName,
              ),
            )
            return
          }
          items.push(
            locationItem(
              { uri: document.uri, range: symbol.selectionRange ?? symbol.range },
              items.length,
              `${"  ".repeat(depth)}${symbol.name}`,
              symbol.detail,
            ),
          )
          for (const child of symbol.children ?? []) append(child, depth + 1)
        }
        for (const symbol of symbols ?? []) append(symbol, 0)
        if (!cancelled) setState({ items, loading: false, error: null })
      } catch (error) {
        if (!cancelled) {
          setState({
            items: [],
            loading: false,
            error: messageForError(error, "Could not load document outline"),
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [props.revision])

  return (
    <AsyncLocationView
      kind="outline"
      title="Outline"
      icon={<ListTree className="size-4" />}
      listId={muxToolPane("outline").tabId}
      state={state}
      emptyTitle="No symbols"
      emptyDescription="No document symbols were returned for the active file."
      filterPlaceholder="Filter outline…"
      onOpenLocation={props.onOpenLocation}
    />
  )
}

function BufferTool(props: MuxToolPanesProps) {
  const [, bump] = useReducer((revision: number) => revision + 1, 0)
  useEffect(() => {
    const buffers = props.workspace.onDidChangeBuffers.event(bump)
    const dirty = props.workspace.onDidChangeDirty.event(bump)
    return () => {
      buffers.dispose()
      dirty.dispose()
    }
  }, [props.workspace])

  const items = props.workspace.openBuffers.map((uri, index) => {
    const file = props.workspace.fileForUri(uri)
    const path = file?.path || displayPath(uri)
    return {
      id: uri,
      fileUri: uri,
      path,
      line: 1,
      column: 1,
      label: `${file?.name ?? basename(path)}${file?.isDirty ? " •" : ""}`,
      detail: index === 0 ? "most recent" : undefined,
    } satisfies ListItem
  })

  return (
    <AsyncLocationView
      kind="buffers"
      title="Open Buffers"
      icon={<FileCode2 className="size-4" />}
      listId={muxToolPane("buffers").tabId}
      state={{ items, loading: false, error: null }}
      emptyTitle="No open buffers"
      emptyDescription="Open a file to add it to the buffer list."
      filterPlaceholder="Filter buffers…"
      onOpenLocation={uri => props.onOpenBuffer(uri)}
    />
  )
}

function WorkspaceSymbolsTool(props: MuxToolPanesProps) {
  const [query, setQuery] = useState("")
  const [state, setState] = useState<AsyncItems>(EMPTY_ASYNC_ITEMS)

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void (async () => {
        if (query.trim().length === 0) {
          setState(EMPTY_ASYNC_ITEMS)
          return
        }
        setState(previous => ({ ...previous, loading: true, error: null }))
        try {
          const { client } = await activeLsp(props)
          const symbols = await client.sendRequest<LspWorkspaceSymbol[] | null>(
            "workspace/symbol",
            { query },
          )
          if (controller.signal.aborted) return
          const items = (symbols ?? [])
            .filter(symbol => symbol.location.range != null)
            .map((symbol, index) =>
              locationItem(
                {
                  uri: symbol.location.uri,
                  range: symbol.location.range!,
                },
                index,
                symbol.name,
                symbol.containerName,
              ),
            )
          setState({ items, loading: false, error: null })
        } catch (error) {
          if (!controller.signal.aborted) {
            setState({
              items: [],
              loading: false,
              error: messageForError(error, "Could not load workspace symbols"),
            })
          }
        }
      })()
    }, 120)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [props.revision, query])

  return (
    <ToolFrame
      kind="workspaceSymbols"
      title="Workspace Symbols"
      icon={<Braces className="size-4" />}
    >
      <div className="border-b border-border p-2">
        <Input
          autoFocus
          aria-label="Search workspace symbols"
          placeholder="Search workspace symbols…"
          value={query}
          onChange={event => setQuery(event.target.value)}
          className="h-8"
        />
      </div>
      {state.error ? (
        <div className="border-b border-destructive/30 px-2 py-1.5 text-xs text-destructive">
          {state.error}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <LocationList
          listId={muxToolPane("workspaceSymbols").tabId}
          items={state.items}
          loading={state.loading}
          emptyTitle="No workspace symbols"
          emptyDescription={
            query.trim() ? "Try another symbol name." : "Type to search symbols."
          }
          onOpenItem={item =>
            props.onOpenLocation(item.fileUri, item.line, item.column)
          }
        />
      </div>
    </ToolFrame>
  )
}

function HierarchyTool(
  props: MuxToolPanesProps & { kind: "callHierarchy" | "typeHierarchy" },
) {
  const [direction, setDirection] = useState<"incoming" | "outgoing">("incoming")
  const [state, setState] = useState<AsyncItems>(EMPTY_ASYNC_ITEMS)
  const isCall = props.kind === "callHierarchy"

  useEffect(() => {
    let cancelled = false
    setState(previous => ({ ...previous, loading: true, error: null }))
    void (async () => {
      try {
        const { document, client } = await activeLsp(props)
        const prepareMethod = isCall
          ? "textDocument/prepareCallHierarchy"
          : "textDocument/prepareTypeHierarchy"
        const roots = await client.sendRequest<LspHierarchyItem[] | null>(
          prepareMethod,
          {
            textDocument: { uri: document.uri },
            position: { line: document.line - 1, character: document.column - 1 },
          },
        )
        const root = roots?.[0]
        if (!root) {
          if (!cancelled) setState(EMPTY_ASYNC_ITEMS)
          return
        }
        let hierarchyItems: LspHierarchyItem[] = []
        if (isCall) {
          const method =
            direction === "incoming"
              ? "callHierarchy/incomingCalls"
              : "callHierarchy/outgoingCalls"
          if (direction === "incoming") {
            const calls = await client.sendRequest<LspCallIncoming[] | null>(method, {
              item: root,
            })
            hierarchyItems = (calls ?? []).map(call => call.from)
          } else {
            const calls = await client.sendRequest<LspCallOutgoing[] | null>(method, {
              item: root,
            })
            hierarchyItems = (calls ?? []).map(call => call.to)
          }
        } else {
          const method =
            direction === "incoming"
              ? "typeHierarchy/supertypes"
              : "typeHierarchy/subtypes"
          hierarchyItems =
            (await client.sendRequest<LspHierarchyItem[] | null>(method, {
              item: root,
            })) ?? []
        }
        const items = hierarchyItems.map((item, index) =>
          locationItem(
            { uri: item.uri, range: item.selectionRange ?? item.range },
            index,
            item.name,
            item.detail,
          ),
        )
        if (!cancelled) setState({ items, loading: false, error: null })
      } catch (error) {
        if (!cancelled) {
          setState({
            items: [],
            loading: false,
            error: messageForError(error, "Could not load hierarchy"),
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [direction, isCall, props.revision])

  return (
    <ToolFrame
      kind={props.kind}
      title={isCall ? "Call Hierarchy" : "Type Hierarchy"}
      icon={<Network className="size-4" />}
      actions={
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant={direction === "incoming" ? "secondary" : "ghost"}
            onClick={() => setDirection("incoming")}
          >
            {isCall ? "Incoming" : "Supertypes"}
          </Button>
          <Button
            type="button"
            size="xs"
            variant={direction === "outgoing" ? "secondary" : "ghost"}
            onClick={() => setDirection("outgoing")}
          >
            {isCall ? "Outgoing" : "Subtypes"}
          </Button>
        </div>
      }
    >
      {state.error ? (
        <div className="border-b border-destructive/30 px-2 py-1.5 text-xs text-destructive">
          {state.error}
        </div>
      ) : null}
      <LocationList
        listId={muxToolPane(props.kind).tabId}
        items={state.items}
        loading={state.loading}
        emptyTitle={`No ${isCall ? "calls" : "types"}`}
        emptyDescription="No hierarchy entries were returned for the current symbol."
        showInput
        filterPlaceholder="Filter hierarchy…"
        onOpenItem={item =>
          props.onOpenLocation(item.fileUri, item.line, item.column)
        }
      />
    </ToolFrame>
  )
}

function LspOutputTool(props: MuxToolPanesProps) {
  const [logs, setLogs] = useState<LspLogEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const refreshRef = useRef<() => void>(() => {})
  const ui = useSyncExternalStore(
    subscribeLspUi,
    getLspUiSnapshot,
    getLspUiSnapshot,
  )

  const refresh = useCallback(() => {
    const lsp = window.yaade?.lsp
    if (!lsp) {
      setLogs([])
      setError("Language server host is unavailable")
      return
    }
    void lsp.logs({ limit: 500 }).then(
      entries => {
        setLogs(entries)
        setError(null)
      },
      reason => {
        setError(messageForError(reason, "Could not load language server output"))
      },
    )
  }, [])
  refreshRef.current = refresh

  useEffect(() => {
    refresh()
    const release = window.yaade?.lsp?.onLifecycle(() => refreshRef.current())
    return () => release?.()
  }, [props.revision, refresh])

  const nodes = useMemo<ListerNode<LspOutputRow>[]>(
    () => {
      const hostRows: LspOutputRow[] = logs.map(entry => ({
        timestamp: entry.timestamp,
        serverId: entry.serverId,
        stream: entry.stream,
        message: entry.message,
        searchText: `${entry.serverId} ${entry.projectRootUri} ${entry.stream} ${entry.level} ${entry.message}`,
      }))
      const protocolRows: LspOutputRow[] = ui.output.map(
        (entry: LspUiOutput) => ({
          timestamp: entry.timestamp,
          serverId: entry.connectionId,
          stream: entry.direction,
          message: entry.message ?? `${entry.kind} ${entry.method}`,
          searchText: `${entry.connectionId} ${entry.direction} ${entry.kind} ${entry.method} ${entry.message ?? ""}`,
        }),
      )
      return [...hostRows, ...protocolRows]
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((entry, index) => ({
          id: `${entry.timestamp}:${entry.serverId}:${entry.stream}:${index}`,
          searchText: entry.searchText,
          data: entry,
        }))
    },
    [logs, ui.output],
  )

  return (
    <ToolFrame
      kind="lspOutput"
      title={`LSP Output · ${props.getLspController()?.status() ?? "idle"}`}
      icon={<ScrollText className="size-4" />}
      actions={
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh LSP output"
          onClick={refresh}
        >
          <RefreshCw />
        </Button>
      }
    >
      {error ? (
        <div className="border-b border-destructive/30 px-2 py-1.5 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      {ui.progress.length > 0 ? (
        <div
          className="shrink-0 border-b border-border bg-muted/20 p-1"
          data-yaade-lsp-progress=""
        >
          {ui.progress.map(progress => (
            <div
              key={`${progress.connectionId}:${String(progress.token)}`}
              className="flex min-h-7 items-center gap-2 rounded-sm px-2 text-xs"
              role="status"
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{progress.title ?? "Language server work"}</span>
                {progress.message ? (
                  <span className="text-muted-foreground"> · {progress.message}</span>
                ) : null}
              </span>
              {progress.percentage != null ? (
                <span className="tabular-nums text-muted-foreground">
                  {Math.round(progress.percentage)}%
                </span>
              ) : null}
              {progress.cancellable ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    const controller = props.getLspController()
                    if (!controller) return
                    void controller
                      .cancelProgress(progress.connectionId, progress.token)
                      .then(cancelled => {
                        if (!cancelled) {
                          showYaadeToast("The language server did not accept cancellation.", {
                            variant: "warning",
                          })
                        }
                      })
                  }}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <Lister
        listId={muxToolPane("lspOutput").tabId}
        mode="flat"
        flatVariant="plain"
        filter="local"
        showInput
        placeholder="Filter language server output…"
        items={nodes}
        className="h-full min-h-0"
        listClassName="min-h-0 flex-1 overflow-auto p-1"
        emptyState={
          <div className="p-4 text-center text-xs text-muted-foreground">
            No language server output
          </div>
        }
        onActivate={() => {}}
        render={(node, context) => (
          <div
            role="option"
            aria-selected={context.selected}
            data-yaade-list-item
            data-node-id={node.id}
            className="flex h-full min-w-0 shrink-0 items-center gap-2 px-2 font-mono text-xs"
          >
            <span className="shrink-0 text-muted-foreground">
              {new Date(node.data.timestamp).toLocaleTimeString()}
            </span>
            <span className="shrink-0 text-foreground">{node.data.serverId}</span>
            <span className="shrink-0 uppercase text-muted-foreground">
              {node.data.stream}
            </span>
            <span data-slot="row-label" className="min-w-0 flex-1 truncate">
              {node.data.message}
            </span>
          </div>
        )}
      />
    </ToolFrame>
  )
}

export function MuxToolPanes(props: MuxToolPanesProps) {
  switch (props.kind) {
    case "problems":
      return <ProblemsTool {...props} />
    case "references":
      return <ReferenceTool {...props} kind="references" />
    case "definitions":
      return <ReferenceTool {...props} kind="definitions" />
    case "outline":
      return <OutlineTool {...props} />
    case "buffers":
      return <BufferTool {...props} />
    case "workspaceSymbols":
      return <WorkspaceSymbolsTool {...props} />
    case "callHierarchy":
      return <HierarchyTool {...props} kind="callHierarchy" />
    case "typeHierarchy":
      return <HierarchyTool {...props} kind="typeHierarchy" />
    case "lspOutput":
      return <LspOutputTool {...props} />
    case "explorer":
      return null
  }
}
