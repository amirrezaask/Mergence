import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react"
import type { PanelEvent } from "@yaade/panels"
import type { PanelId, PanelView, YaadeTheme } from "@yaade/shared"
import { fileUriToPath } from "@yaade/shared"
import {
  ModalEditorTabBar,
  MuxEmptyState,
  MuxPaneChrome,
  PanelDock,
  SessionHeaderChromeProvider,
  sessionHeaderContextRef,
  type AgentCliDriver,
  type ModalEditorBuffer,
  type PanelSlotMeta,
  type TabDndHandlers,
} from "@yaade/ui"
import type { YaadePanelTree } from "@yaade/workspace"
import { panelTabIds } from "@yaade/workspace"
import { listPaneLeaves, muxLeafKind } from "./layout.js"

const GitWorkspace = lazy(() =>
  import("@yaade/ui/git").then(m => ({ default: m.GitWorkspace })),
)

export type MuxWindowViewProps = {
  tree: YaadePanelTree
  focusedPanelId: PanelId | null
  zoomedPaneId: string | null
  paneTitle: (tabId: string) => string
  /** Optional process basename for deck tile in pane chrome. */
  paneProcessName?: (tabId: string) => string | null
  onFocusPanel: (id: PanelId) => void
  onEvent: (event: PanelEvent) => void
  tabDnd: TabDndHandlers
  onSplit: (panelId: PanelId, edge: "right" | "bottom") => void
  onOpenGit: (panelId: PanelId) => void
  onOpenNeovim: (panelId: PanelId) => void
  onOpenEditor?: (panelId: PanelId) => void
  /** Open a file (from git pane) in an editor split. */
  onOpenFile?: (panelId: PanelId, filePath: string, line?: number) => void
  onZoom: (tabId: string) => void
  onClosePane: (panelId: PanelId, tabId: string) => void
  /** Activate a buffer tab inside an editor pane. */
  onActivateEditorTab?: (panelId: PanelId, tabId: string) => void
  /** Close a single buffer tab (not the whole editor group). */
  onCloseEditorTab?: (panelId: PanelId, tabId: string) => void
  onNewWindow?: () => void
  /** Empty-workspace actions (no panes). */
  onEmptyOpenTerminal?: () => void
  onEmptyOpenNeovim?: () => void
  onEmptyOpenGit?: () => void
  onEmptyOpenEditor?: () => void
  onEmptyOpenAgent?: (driver: AgentCliDriver) => void
  /** Resolve git pane workspace root (source shell cwd at open time). */
  gitRootForTab: (tabId: string) => string | null
  /** Resolve editor pane file URI. */
  editorFileForTab?: (tabId: string) => { uri: string; line?: number } | null
  /** Dirty state for editor panes. */
  editorDirtyForTab?: (tabId: string) => boolean
  /** Buffer list for an editor panel (multi-tab). */
  editorBuffersForPanel?: (panelId: PanelId) => ModalEditorBuffer[]
  /** Shortcut display for a command id (from mux binding table). */
  shortcutFor?: (commandId: string) => string | undefined
  theme: YaadeTheme
  /** App font size for git diff / editor chrome. */
  fontSize?: number
  /** Terminals are painted by MuxTerminalLayer; slots are placeholders only. */
  empty: ReactNode
  /** Optional editor pane body renderer (lazy monaco). */
  renderEditor?: (tabId: string, panelId: PanelId, focused: boolean) => ReactNode
  /** Optional persistent tiled-tool renderer (Explorer, Search, Problems, …). */
  renderTool?: (tabId: string, panelId: PanelId, focused: boolean) => ReactNode
}

function muxLeafView(view: PanelView | null): PanelView {
  if (!view || view.kind !== "tabs") return { kind: "empty" }
  const tabIds = panelTabIds(view).filter(id => muxLeafKind(id) != null)
  if (tabIds.length === 0) return { kind: "empty" }
  const activeTabId = tabIds.includes(view.activeTabId)
    ? view.activeTabId
    : tabIds[0]!
  return { kind: "tabs", activeTabId, tabIds }
}

function PaneChromeShell(props: {
  tabId: string
  panelId: PanelId
  title: string
  processName?: string | null
  focused: boolean
  zoomed: boolean
  canZoom: boolean
  onSplitRight: () => void
  onSplitDown: () => void
  onOpenGit: () => void
  onOpenNeovim: () => void
  onOpenEditor?: () => void
  onZoom: () => void
  onClose: () => void
  shortcutFor?: (commandId: string) => string | undefined
  dirty?: boolean
  editorBuffers?: ModalEditorBuffer[]
  onActivateEditorTab?: (tabId: string) => void
  onCloseEditorTab?: (tabId: string) => void
  children: ReactNode
}) {
  const {
    tabId,
    panelId,
    title,
    processName,
    focused,
    zoomed,
    canZoom,
    onSplitRight,
    onSplitDown,
    onOpenGit,
    onOpenNeovim,
    onOpenEditor,
    onZoom,
    onClose,
    shortcutFor,
    dirty,
    editorBuffers,
    onActivateEditorTab,
    onCloseEditorTab,
    children,
  } = props
  const [headerContextEl, setHeaderContextEl] = useState<HTMLElement | null>(null)
  const isGitPane = muxLeafKind(tabId) === "git"
  const isEditorPane = muxLeafKind(tabId) === "editor"
  const showEditorTabs =
    isEditorPane && editorBuffers != null && editorBuffers.length > 0

  const body = isGitPane ? (
    <SessionHeaderChromeProvider target={headerContextEl}>
      {children}
    </SessionHeaderChromeProvider>
  ) : (
    children
  )

  return (
    <div
      className="group/mux-pane relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card outline-none"
      role="group"
      aria-label={title}
      aria-current={focused ? "true" : undefined}
      tabIndex={focused ? 0 : -1}
      data-yaade-mux-pane={tabId}
      data-panel-id={panelId.id}
      data-yaade-mux-pane-kind={muxLeafKind(tabId) ?? undefined}
      data-focused={focused ? "" : undefined}
    >
      <MuxPaneChrome
        title={showEditorTabs ? "" : title}
        processName={processName}
        focused={focused}
        paneId={tabId}
        panelId={panelId}
        zoomed={zoomed}
        canZoom={canZoom}
        dirty={showEditorTabs ? false : dirty}
        shortcutFor={shortcutFor}
        contextRef={isGitPane ? sessionHeaderContextRef(setHeaderContextEl) : undefined}
        center={
          showEditorTabs ? (
            <ModalEditorTabBar
              buffers={editorBuffers}
              activeTabId={tabId}
              onActivateBuffer={id => onActivateEditorTab?.(id)}
              onCloseBuffer={id => onCloseEditorTab?.(id)}
              className="min-h-0 w-full"
            />
          ) : undefined
        }
        onSplitRight={onSplitRight}
        onSplitDown={onSplitDown}
        onOpenGit={isGitPane ? undefined : onOpenGit}
        onOpenNeovim={onOpenNeovim}
        onOpenEditor={isEditorPane ? undefined : onOpenEditor}
        onZoom={onZoom}
        onClose={onClose}
      />
      {body}
    </div>
  )
}

function TerminalSlot(props: { tabId: string }) {
  return (
    <div
      className="min-h-0 flex-1 overflow-hidden"
      data-yaade-mux-terminal-slot={props.tabId}
    />
  )
}

function GitPaneBody(props: {
  rootUri: string | null
  theme: YaadeTheme
  fontSize?: number
  active?: boolean
  onOpenFile?: (path: string, line?: number) => void
}) {
  const rootPath = props.rootUri ? fileUriToPath(props.rootUri) : undefined
  const [monacoReady, setMonacoReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    void import("../editor/monaco-workers.js").then(({ ensureMonacoWorkersConfigured }) =>
      ensureMonacoWorkersConfigured(),
    ).then(() => {
      if (!cancelled) setMonacoReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div
      className="min-h-0 flex-1 overflow-hidden"
      data-yaade-git-root={rootPath}
    >
      {!monacoReady ? (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          Loading Git…
        </div>
      ) : (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Loading Git…
            </div>
          }
        >
          <GitWorkspace
            rootUri={props.rootUri}
            theme={props.theme}
            fontSize={props.fontSize}
            active={props.active ?? true}
            onOpenFile={path => props.onOpenFile?.(path)}
          />
        </Suspense>
      )}
    </div>
  )
}

export function MuxWindowView(props: MuxWindowViewProps) {
  const {
    tree,
    focusedPanelId,
    zoomedPaneId,
    paneTitle,
    paneProcessName,
    onFocusPanel,
    onEvent,
    tabDnd,
    onSplit,
    onOpenGit,
    onOpenNeovim,
    onOpenEditor,
    onOpenFile,
    onZoom,
    onClosePane,
    onActivateEditorTab,
    onCloseEditorTab,
    onEmptyOpenTerminal,
    onEmptyOpenNeovim,
    onEmptyOpenGit,
    onEmptyOpenEditor,
    onEmptyOpenAgent,
    gitRootForTab,
    editorDirtyForTab,
    editorBuffersForPanel,
    shortcutFor,
    theme,
    fontSize,
    empty,
    renderEditor,
    renderTool,
  } = props

  const paneCount = listPaneLeaves(tree).length
  const canZoom = paneCount > 1
  const zoomedLeaf =
    zoomedPaneId != null
      ? listPaneLeaves(tree).find(p => p.ptyTabId === zoomedPaneId)
      : null

  if (paneCount === 0) {
    return (
      <div
        className="flex h-full min-h-0 w-full flex-col overflow-hidden p-1.5"
        data-yaade-mux-window=""
      >
        <div className="h-full min-h-0 w-full overflow-hidden rounded-lg border border-border bg-card">
          <MuxEmptyState
            onOpenTerminal={() => onEmptyOpenTerminal?.()}
            onOpenNeovim={() => onEmptyOpenNeovim?.()}
            onOpenGit={() => onEmptyOpenGit?.()}
            onOpenEditor={() => onEmptyOpenEditor?.()}
            onOpenAgent={
              onEmptyOpenAgent
                ? driver => onEmptyOpenAgent(driver)
                : undefined
            }
            shortcutFor={shortcutFor}
          />
        </div>
      </div>
    )
  }

  const renderHeader = useCallback(
    (_view: PanelView, _panelId: PanelId, _meta: PanelSlotMeta) => null,
    [],
  )

  const renderPane = useCallback(
    (
      tabId: string,
      panelId: PanelId,
      focused: boolean,
      zoomed: boolean,
    ) => {
      const kind = muxLeafKind(tabId)
      const body =
        kind === "git" ? (
          <GitPaneBody
            rootUri={gitRootForTab(tabId)}
            theme={theme}
            fontSize={fontSize}
            active={focused}
            onOpenFile={(path, line) => onOpenFile?.(panelId, path, line)}
          />
        ) : kind === "terminal" ? (
          <TerminalSlot tabId={tabId} />
        ) : kind === "editor" ? (
          (renderEditor?.(tabId, panelId, focused) ?? empty)
        ) : kind === "tool" ? (
          (renderTool?.(tabId, panelId, focused) ?? empty)
        ) : (
          empty
        )

      return (
        <PaneChromeShell
          tabId={tabId}
          panelId={panelId}
          title={paneTitle(tabId)}
          processName={paneProcessName?.(tabId)}
          focused={focused}
          zoomed={zoomed}
          canZoom={canZoom}
          dirty={editorDirtyForTab?.(tabId)}
          editorBuffers={
            kind === "editor" ? editorBuffersForPanel?.(panelId) : undefined
          }
          onActivateEditorTab={id => onActivateEditorTab?.(panelId, id)}
          onCloseEditorTab={id => onCloseEditorTab?.(panelId, id)}
          shortcutFor={shortcutFor}
          onSplitRight={() => onSplit(panelId, "right")}
          onSplitDown={() => onSplit(panelId, "bottom")}
          onOpenGit={() => onOpenGit(panelId)}
          onOpenNeovim={() => onOpenNeovim(panelId)}
          onOpenEditor={onOpenEditor ? () => onOpenEditor(panelId) : undefined}
          onZoom={() => onZoom(tabId)}
          onClose={() => onClosePane(panelId, tabId)}
        >
          {body}
        </PaneChromeShell>
      )
    },
    [
      canZoom,
      empty,
      editorBuffersForPanel,
      editorDirtyForTab,
      gitRootForTab,
      onActivateEditorTab,
      onCloseEditorTab,
      onClosePane,
      onOpenEditor,
      onOpenFile,
      onOpenGit,
      onOpenNeovim,
      onSplit,
      onZoom,
      paneProcessName,
      paneTitle,
      renderEditor,
      renderTool,
      shortcutFor,
      theme,
      fontSize,
    ],
  )

  const renderContent = useCallback(
    (view: PanelView, panelId: PanelId, meta: PanelSlotMeta) => {
      const leaf = muxLeafView(view)
      if (leaf.kind !== "tabs") return empty
      const tabId = leaf.activeTabId
      if (muxLeafKind(tabId) == null) return empty
      return renderPane(tabId, panelId, meta.focused, false)
    },
    [empty, renderPane],
  )

  if (zoomedLeaf) {
    return (
      <div
        className="flex h-full min-h-0 w-full flex-col overflow-hidden p-1.5"
        data-yaade-mux-window=""
        data-zoomed=""
      >
        {renderPane(zoomedLeaf.ptyTabId, zoomedLeaf.panelId, true, true)}
      </div>
    )
  }

  return (
    <div
      className="h-full min-h-0 w-full gap-1.5 p-1.5 [&_[data-slot=resizable-panel-group]]:gap-1.5"
      data-yaade-mux-window=""
    >
      <PanelDock
        tree={tree}
        focusedPanelId={focusedPanelId}
        onFocusPanel={onFocusPanel}
        onEvent={onEvent}
        tabDnd={tabDnd}
        wrapTabDnd={false}
        renderHeader={renderHeader}
        renderContent={renderContent}
      />
    </div>
  )
}
