import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react"
import type { PanelEvent } from "@yaade/panels"
import type {
  AgentProvider,
  PanelId,
  ProjectSearchOptions,
  ProjectSearchResult,
  SearchPage,
  YaadeTheme,
} from "@yaade/shared"
import {
  pathToFileUri,
  fileUriToPath,
  canonicalizeFileUri,
  languageIdFromPath,
} from "@yaade/shared"
import {
  AppShell,
  ConfirmDialogHost,
  InstanceSidebar,
  ModalEditorTabBar,
  MuxStatusStrip,
  TabDndRoot,
  Toaster,
  TooltipProvider,
  WhichKeyPanel,
  AGENT_CLI_DRIVERS,
  bundledThemeList,
  formatKeyBinding,
  formatMuxTitle,
  requestConfirm,
  requestSaveDiscard,
  showYaadeToast,
  type AgentCliDriver,
  type InstanceSidebarItem,
  type ModalEditorBuffer,
  type MuxStatusStripAction,
  type PaletteShellItem,
  type TabDndHandlers,
  type WhichKeyEntry,
} from "@yaade/ui"
import { Bot, SquareTerminal } from "lucide-react"
import type { ProjectSession, ProjectSessionPayload } from "@yaade/rpc"
import type { JetLspWorkspaceDeps } from "@yaade/lsp"
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@yaade/ui/primitives"
import {
  CheckoutPicker,
  checkoutLabelFromUri,
  type CheckoutSelection,
} from "../project/CheckoutPicker.js"
import { createProjectSession } from "../project-session-client.js"
import {
  CommandRegistry,
  KeymapService,
  WorkspaceManager,
  WorkspaceService,
  YaadePanelTree,
  activatePanelTab,
  anyOverlayOpen,
  bind,
  findPanelWithTab,
  gitTabId,
  isEditorTabId,
  isFileEditorTabId,
  isGitTabId,
  isTerminalTabId,
  normalizeAbsPath,
  panelTabIds,
  sameFileTab,
  terminalTabId,
  terminalSessionKeyFromTabId,
  type JetCommandContext,
  type JetKeyBinding,
  type KeymapContext,
  type LaunchConfig,
  type AgentRunInfo,
} from "@yaade/workspace"
import { createAgentBridge } from "../agent-bridge.js"
import { resolveDirtyBufferClose } from "../editor/dirty-buffer-close.js"
import {
  moveEditorViewState,
  remapEditorViewStateUri,
  replaceEditorViewStates,
  snapshotEditorViewStates,
} from "../editor/editor-view-state-store.js"
import { agentDriverIdForMode } from "@yaade/agents"
import { useAppearanceSettings } from "../hooks/useAppearanceSettings.js"
import { useGlobalKeymap } from "../hooks/useGlobalKeymap.js"
import { useFileDrop } from "../use-file-drop.js"
import type { MuxLspController } from "./MuxLspHost.js"
import {
  clearTerminalSession,
  hydrateTerminalSession,
  markTerminalFailed,
  recordTerminalOutput,
  recordTerminalUserInput,
  registerTerminalSession,
  restartTerminalSession,
  subscribeTerminalSessions,
  terminalCwdForTab,
  terminalPtyIdForTab,
  terminalSessionForTab,
  terminalSessionNeedsCloseConfirmation,
  trackTerminalPtyId,
  updateTerminalLiveCwd,
} from "../tabs/terminal-session.js"
import { allocTerminalSessionKey } from "../tab-routing.js"
import { applySessionPaneDrop } from "../session-layout.js"
import { getAllLeafPanels } from "../panel-routing.js"
import {
  activeMuxTabInPanel,
  buildTerminalOnlyDisplayTree,
  clearEditorTabsFromPanel,
  dockSourceLeavesIntoTree,
  emptyMuxTree,
  listEditorBufferTabIds,
  listPaneLeaves,
  listTerminalLeaves,
  removePtyFromTree,
  type MuxLeafKind,
} from "./layout.js"
import { findFocusNeighbor, type FocusDirection } from "./focus-neighbor.js"
import {
  MUX_DIRECT_BINDINGS,
  MUX_PREFIX,
  MUX_PREFIX_BINDINGS,
  muxPrefixBindingKey,
  prefixLiteralByte,
} from "./mux-keymap.js"
import {
  placeGitPane,
  placeTerminalPane,
  placeEditorPane,
  placeToolPane,
  type AllocatedGitPane,
  type AllocatedTerminalPane,
  type AllocatedEditorPane,
  type AllocatedToolPane,
} from "./place-pane.js"
import { MuxWindowView } from "./MuxWindowView.js"
import {
  MuxTerminalLayer,
  useMuxPaneBoxes,
  useMuxTerminalSlotBoxes,
} from "./MuxTerminalLayer.js"
import { cwdUriFromTerminalTitle } from "./cwd-from-title.js"
import {
  urlPathForProjectRoot,
  workspaceDocumentTitle,
} from "../url-workspace.js"
import { ProjectSessionPersistWriter } from "../project-session-client.js"
import type {
  MuxSessionLeafPersisted,
  MuxSwitcherEntry,
  MuxWindowPersisted,
} from "./types.js"
import { claimMuxLaunchRequest } from "./launch-request.js"
import {
  muxToolPane,
  muxToolPaneForTab,
  type MuxToolKind,
} from "./tool-pane.js"
import type {
  MuxExplorerAction,
  MuxExplorerController,
} from "./MuxExplorerPane.js"

const TerminalPanel = lazy(async () => {
  const mod = await import("@yaade/ui/terminal")
  return { default: mod.TerminalPanel }
})

const MuxEditorPane = lazy(() => import("./MuxEditorPane.js"))

const MuxExplorerPane = lazy(() =>
  import("./MuxExplorerPane.js").then(module => ({
    default: module.MuxExplorerPane,
  })),
)

const MuxToolPanes = lazy(() =>
  import("./MuxToolPanes.js").then(module => ({
    default: module.MuxToolPanes,
  })),
)

const MuxLspHost = lazy(() =>
  import("./MuxLspHost.js").then(module => ({
    default: module.MuxLspHost,
  })),
)

const MuxOverlays = lazy(() => import("./MuxOverlays.js"))

/** Basename display label for an editor pane from its file uri. */
function editorLabelFromUri(uri: string): string {
  if (uri.startsWith("untitled:")) {
    const rest = uri.slice("untitled:".length).trim()
    return rest || "Untitled"
  }
  try {
    return fileUriToPath(uri).split(/[/\\]/).filter(Boolean).pop() ?? uri
  } catch {
    return uri.split("/").filter(Boolean).pop() ?? uri
  }
}

/** Resolve a file uri from an absolute/relative path or an existing uri. */
function resolveEditorUri(rootUri: string, target: string): string {
  if (target.startsWith("file://")) return canonicalizeFileUri(target)
  let rootPath = ""
  try {
    rootPath = fileUriToPath(rootUri)
  } catch {
    rootPath = ""
  }
  const clean = target.replace(/^\.\//, "")
  const abs = clean.startsWith("/")
    ? clean
    : rootPath
      ? `${rootPath.replace(/\/+$/, "")}/${clean}`
      : clean
  return canonicalizeFileUri(pathToFileUri(abs))
}

/**
 * Rewrite legacy `yaade:editor:pane-*` tab ids in a persisted tree to file URIs
 * using the companion `editorFiles` map. Returns remapped editorFiles keyed by URI.
 */
function migrateLegacyEditorTabs(
  tree: YaadePanelTree,
  editorFiles: Record<string, { uri: string; line?: number }>,
): Record<string, { uri: string; line?: number }> {
  const nextFiles: Record<string, { uri: string; line?: number }> = {}
  const remap = new Map<string, string>()

  for (const [tabId, entry] of Object.entries(editorFiles)) {
    if (isFileEditorTabId(tabId)) {
      nextFiles[tabId] = {
        uri: entry.uri || tabId,
        ...(entry.line != null ? { line: entry.line } : {}),
      }
      continue
    }
    if (tabId.startsWith("yaade:editor:") && entry.uri) {
      remap.set(tabId, entry.uri)
      nextFiles[entry.uri] = {
        uri: entry.uri,
        ...(entry.line != null ? { line: entry.line } : {}),
      }
      continue
    }
    if (entry.uri) {
      const key = isFileEditorTabId(entry.uri) ? entry.uri : tabId
      nextFiles[key] = {
        uri: entry.uri,
        ...(entry.line != null ? { line: entry.line } : {}),
      }
    }
  }

  if (remap.size === 0) return nextFiles

  for (const panelId of getAllLeafPanels(tree)) {
    const view = tree.getView(panelId)
    if (!view || view.kind !== "tabs") continue
    const tabIds = panelTabIds(view).map(id => remap.get(id) ?? id)
    const activeTabId = remap.get(view.activeTabId) ?? view.activeTabId
    const unique = tabIds.filter((id, i, arr) => arr.indexOf(id) === i)
    if (unique.length === 0) continue
    tree.setView(panelId, {
      kind: "tabs",
      activeTabId: unique.includes(activeTabId) ? activeTabId : unique[0]!,
      tabIds: unique,
    })
  }

  return nextFiles
}

function remapEditorTabUri(
  tree: YaadePanelTree,
  oldUri: string,
  newUri: string,
): YaadePanelTree {
  const next = tree.clone()
  for (const panelId of getAllLeafPanels(next)) {
    const view = next.getView(panelId)
    if (!view || view.kind !== "tabs" || !panelTabIds(view).includes(oldUri)) {
      continue
    }
    const tabIds = panelTabIds(view).map(id => (id === oldUri ? newUri : id))
    next.setView(panelId, {
      kind: "tabs",
      activeTabId: view.activeTabId === oldUri ? newUri : view.activeTabId,
      tabIds: [...new Set(tabIds)],
    })
  }
  return next
}

function applyEditorResourceMapping(
  tree: YaadePanelTree,
  mapping: ReadonlyMap<string, string | null>,
): YaadePanelTree {
  let next = tree.clone()
  for (const [oldUri, newUri] of mapping) {
    if (newUri != null) continue
    for (const panelId of getAllLeafPanels(next)) {
      const view = next.getView(panelId)
      if (view?.kind === "tabs" && panelTabIds(view).includes(oldUri)) {
        removePtyFromTree(next, panelId, oldUri)
      }
    }
  }
  for (const [oldUri, newUri] of mapping) {
    if (!newUri || oldUri === newUri) continue
    next = remapEditorTabUri(next, oldUri, newUri)
  }
  return next
}

function uriAtOrBelow(candidate: string, resource: string): boolean {
  return candidate === resource || candidate.startsWith(`${resource.replace(/\/$/, "")}/`)
}

function remapResourceDescendant(
  candidate: string,
  oldUri: string,
  newUri: string,
): string {
  if (candidate === oldUri) return newUri
  const prefix = `${oldUri.replace(/\/$/, "")}/`
  return candidate.startsWith(prefix)
    ? `${newUri.replace(/\/$/, "")}/${candidate.slice(prefix.length)}`
    : candidate
}

/** True when a pane was launched as Neovim/Vim (quit should close the pane). */
function isNeovimLaunchCommand(command: string | undefined): boolean {
  if (!command) return false
  const base =
    command
      .trim()
      .split(/[/\\\s]/)
      .filter(Boolean)
      .pop()
      ?.toLowerCase() ?? ""
  return base === "nvim" || base === "neovim" || base === "vim"
}

type LiveWindow = {
  id: string
  title: string
  tree: YaadePanelTree
  focusedPaneId: PanelId | null
  zoomedPaneId: string | null
}

function jetPlatformFS(): import("@yaade/workspace").FileSystemProvider {
  const jet = window.yaade
  if (!jet?.fs) throw new Error("window.yaade.fs not available")
  const fs = jet.fs
  const exists = fs.exists
  return {
    readFile: uri => fs.readFile(uri),
    writeFile: (uri, content) => fs.writeFile(uri, content),
    readDir: uri => fs.readDir(uri),
    stat: uri => fs.stat(uri),
    ...(exists ? { exists: uri => exists(uri) } : {}),
  }
}

function panelIdFromNumber(id: number | null): PanelId | null {
  return id == null ? null : { id }
}

function allocWindowId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? `win-${crypto.randomUUID()}`
    : `win-${Date.now().toString(36)}`
}

function persistWindows(windows: LiveWindow[]): MuxWindowPersisted[] {
  return windows.map(w => {
    const sessions: MuxSessionLeafPersisted[] = []
    for (const leaf of listTerminalLeaves(w.tree)) {
      const session = terminalSessionForTab(leaf.ptyTabId)
      if (!session) continue
      sessions.push({
        ptyTabId: leaf.ptyTabId,
        ptyId: session.ptyId,
        cwdRootUri: session.cwdRootUri,
        liveCwdUri: session.liveCwdUri,
        launchCommand: session.launchCommand,
        launchArgs: session.launchArgs,
        label: session.customLabel,
        agentProvider: session.agentId,
        agentTitle: session.agentTitle,
      })
    }
    return {
      id: w.id,
      title: w.title,
      tree: w.tree.toJSON(),
      focusedPaneId: w.focusedPaneId?.id ?? null,
      zoomedPaneId: w.zoomedPaneId,
      sessions,
    }
  })
}

function hydrateWindows(persisted: MuxWindowPersisted[]): LiveWindow[] {
  return persisted.map(w => {
    try {
      return {
        id: w.id,
        title: w.title,
        tree: YaadePanelTree.jetFromJSON(w.tree),
        focusedPaneId: panelIdFromNumber(w.focusedPaneId),
        zoomedPaneId: w.zoomedPaneId,
      }
    } catch {
      return {
        id: w.id,
        title: w.title,
        tree: emptyMuxTree(),
        focusedPaneId: null,
        zoomedPaneId: null,
      }
    }
  })
}

/** Re-register terminal sessions from persisted leaf metadata so attach works. */
function hydratePersistedSessions(
  persisted: MuxWindowPersisted[],
  workspace: WorkspaceService,
): void {
  for (const w of persisted) {
    const sessions = w.sessions ?? []
    for (const entry of sessions) {
      if (!isTerminalTabId(entry.ptyTabId)) continue
      hydrateTerminalSession({
        tabId: entry.ptyTabId,
        cwdRootUri: entry.cwdRootUri,
        liveCwdUri: entry.liveCwdUri,
        launchCommand: entry.launchCommand,
        launchArgs: entry.launchArgs,
        ptyId: entry.ptyId,
        status: entry.ptyId ? "running" : "starting",
        customLabel: entry.label,
        agentId: entry.agentProvider,
        agentTitle: entry.agentTitle,
        ...(entry.agentProvider
          ? { agentDriverId: agentDriverIdForMode(entry.agentProvider, "cli") }
          : {}),
      })
      if (!workspace.tabRegistry.get(entry.ptyTabId)) {
        workspace.registerTab({
          id: entry.ptyTabId,
          kind: "terminal",
          label: entry.label ?? "Terminal",
        })
      }
    }
    // Also register any terminal/git leaves present in the tree without session meta.
    try {
      const tree = YaadePanelTree.jetFromJSON(w.tree)
      for (const leaf of listPaneLeaves(tree)) {
        if (workspace.tabRegistry.get(leaf.ptyTabId)) continue
        if (leaf.kind === "terminal") {
          workspace.registerTab({
            id: leaf.ptyTabId,
            kind: "terminal",
            label: "Terminal",
          })
          if (!terminalSessionForTab(leaf.ptyTabId)) {
            registerTerminalSession(leaf.ptyTabId, "")
          }
        } else if (leaf.kind === "git") {
          workspace.registerTab({
            id: leaf.ptyTabId,
            kind: "git",
            label: "Git",
          })
        } else if (leaf.kind === "tool") {
          const tool = muxToolPaneForTab(leaf.ptyTabId)
          if (tool?.kind === "explorer") {
            workspace.registerTab({
              id: tool.tabId,
              kind: "explorer",
              label: tool.label,
            })
          }
        }
      }
    } catch {
      /* ignore corrupt tree */
    }
  }
}

const EMPTY_KEYMAP_OVERLAYS = {
  quickOpenOpen: false,
  bufferListOpen: false,
  openFileOpen: false,
  projectSwitcherOpen: false,
  gotoLineOpen: false,
  outlineOpen: false,
  agentCliPickerOpen: false,
  explorerFocus: false,
  terminalExplorerFocus: false,
  outputFocus: false,
  listFocus: false,
} as const

/** Project-page surface modes (embedded mux only). */
export type MuxSurface = "agents" | "editors" | "terminals"

/** Surfaces mux can ask the project shell to show (includes non-mux Changes). */
export type MuxRequestedView = MuxSurface | "changes"

export type MuxAppProps = {
  session: ProjectSession
  projectId: string
  projectName: string
  homeDir: string
  machineHostname: string
  onBackToProject?: () => void
  /** Open the CLI agent picker (Agents sidebar New). */
  onLaunchAgent?: () => void
  onSelectAgentTab?: (tabId: string) => void
  /** Switch the project tab when mux opens content owned by another surface. */
  onRequestSurface?: (view: MuxRequestedView) => void
  /**
   * Render inside ProjectPage content (no nested AppShell / session chrome).
   * Footer (WhichKey / status) stays at the bottom of this pane.
   */
  embedded?: boolean
  /** Project-page tab surface — filters what mux shows. */
  surface?: MuxSurface | null
  /** Additional editor workspace root; session cwd remains unchanged. */
  editorWorkspacePath?: string
  /** Surface chrome supplied by the project page. */
  editorToolbar?: ReactNode
  /** Agent leaf tab id (`yaade:terminal:…`) for the Agents surface. */
  focusAgentTabId?: string | null
  /** One-shot action requested by the project cockpit after session hydration. */
  launchRequest?: MuxLaunchRequest | null
  /** Called after the request succeeds or fails so the caller can clear it. */
  onLaunchRequestHandled?: (
    requestId: string,
    result?: { agentTabId?: string | null; agentRunId?: string | null },
  ) => void
}

export type MuxLaunchAction =
  | {
      kind: "agent"
      driverId: AgentCliDriver["id"]
      checkoutPath?: string
      checkoutKey?: string
      checkoutLabel?: string
    }
  | {
      kind: "terminal"
      checkoutPath?: string
      checkoutKey?: string
      checkoutLabel?: string
    }
  | { kind: "neovim" }
  | { kind: "git" }
  | { kind: "editor"; filePath?: string; line?: number }

export type MuxLaunchRequest = {
  id: string
  action: MuxLaunchAction
}

export function MuxApp({
  session,
  projectId,
  projectName,
  homeDir,
  machineHostname,
  onBackToProject,
  onLaunchAgent,
  onSelectAgentTab,
  onRequestSurface,
  embedded = false,
  surface = null,
  editorWorkspacePath,
  editorToolbar,
  focusAgentTabId = null,
  launchRequest = null,
  onLaunchRequestHandled,
}: MuxAppProps) {
  const {
    appearanceSettings,
    setAppearanceSettings,
    activeTheme,
    fontSize,
    handleZoom,
    setFontSize,
    setThemeId,
    resetAppearanceSettings,
  } = useAppearanceSettings()
  const sessionId = session.id
  const sessionCwdPath = session.cwdPath
  const sessionProjectPath = session.projectPath
  const sessionTitle = session.title
  const initialPayload = session.payload

  const workspaceManager = useMemo(
    () => new WorkspaceManager(jetPlatformFS()),
    [],
  )
  const workspace = useMemo(
    () => new WorkspaceService(workspaceManager),
    [workspaceManager],
  )
  const commands = useMemo(() => new CommandRegistry(), [])
  const keymaps = useMemo(() => new KeymapService(), [])

  /** Filled after `openEditorInFocused` is defined — used by LSP go-to-def. */
  const openEditorInFocusedRef = useRef<
    (options?: {
      uri?: string
      filePath?: string
      line?: number
      column?: number
      forceNewGroup?: boolean
    }) => void
  >(() => {})

  const [layoutReady, setLayoutReady] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [terminalListOpen, setTerminalListOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [cdOpen, setCdOpen] = useState(false)
  const [pendingChordPrefix, setPendingChordPrefix] = useState<string | null>(
    null,
  )
  const [terminalSessionsRevision, bumpSessions] = useReducer(
    (n: number) => n + 1,
    0,
  )

  // One browser tab = one project window (no in-app tab strip).
  const [windows, setWindows] = useState<LiveWindow[]>([])
  const boundAgentPtysRef = useRef(new Set<string>())
  const [activeWindowId, setActiveWindowId] = useState<string | null>(null)
  const [lastCwdUri, setLastCwdUri] = useState<string | null>(null)

  useEffect(() => {
    for (const liveWindow of windows) {
      for (const leaf of listTerminalLeaves(liveWindow.tree)) {
        const terminalSession = terminalSessionForTab(leaf.ptyTabId)
        const agentRunKey = terminalSessionKeyFromTabId(leaf.ptyTabId)
        const ptyId = terminalSession?.ptyId
        const provider = terminalSession?.agentId as AgentProvider | undefined
        if (
          !ptyId ||
          agentRunKey?.startsWith("run-") ||
          boundAgentPtysRef.current.has(ptyId) ||
          (provider !== "claude" &&
            provider !== "codex" &&
            provider !== "cursor" &&
            provider !== "opencode" &&
            provider !== "grok")
        ) {
          continue
        }
        boundAgentPtysRef.current.add(ptyId)
        void window.yaade?.notifications?.bindSession({
          sessionId: leaf.ptyTabId,
          projectId,
          projectName,
          sessionTitle: terminalSession.agentTitle ?? sessionTitle,
          provider,
          ptyId,
        })
      }
    }
  }, [projectId, projectName, sessionTitle, windows])
  /** Per git-pane workspace root (source shell cwd at open time). */
  const [gitRoots, setGitRoots] = useState<Record<string, string>>({})
  /** Per editor-pane file target (uri + optional 1-based line). */
  const [editorFiles, setEditorFiles] = useState<
    Record<string, { uri: string; line?: number; column?: number }>
  >({})
  /** Metadata-only revision; dirty truth lives in WorkspaceService. */
  const [editorDirtyRevision, bumpEditorDirtyRevision] = useReducer(
    (revision: number) => revision + 1,
    0,
  )
  const [quickOpenOpen, setQuickOpenOpen] = useState(false)
  const [projectSearchOpen, setProjectSearchOpen] = useState(false)
  const [saveAsUri, setSaveAsUri] = useState<string | null>(null)
  const [toolRevisions, bumpToolRevision] = useReducer(
    (revisions: Record<MuxToolKind, number>, kind: MuxToolKind) => ({
      ...revisions,
      [kind]: (revisions[kind] ?? 0) + 1,
    }),
    {
      explorer: 0,
      search: 0,
      problems: 0,
      references: 0,
      definitions: 0,
      outline: 0,
      buffers: 0,
      workspaceSymbols: 0,
      callHierarchy: 0,
      typeHierarchy: 0,
      lspOutput: 0,
    },
  )
  const sessionRootPathRef = useRef<string>(sessionCwdPath)
  const projectPathRef = useRef<string>(sessionProjectPath)
  const sessionIdRef = useRef<string>(sessionId)
  const machineHostnameRef = useRef<string>(machineHostname)
  const persistWriterRef = useRef(new ProjectSessionPersistWriter())
  const serverHydratedRef = useRef(false)
  /** Skip network persist when only focusedPaneId changed (tree unchanged). */
  const lastPersistStructureRef = useRef<string>("")
  /** Foreground process basename per terminal tab (Deck icons / titles). */
  const processByTabRef = useRef<Record<string, string>>({})
  const focusedPtyTabIdRef = useRef<string | null>(null)
  const handledLaunchIdsRef = useRef(new Set<string>())
  const explorerControllerRef = useRef<MuxExplorerController | null>(null)
  const lspControllerRef = useRef<MuxLspController | null>(null)
  const pendingExplorerActionRef = useRef<MuxExplorerAction | null>(null)
  const workspaceEditTransactionsRef = useRef<
    import("../editor/workspace-edit-transaction.js").WorkspaceEditTransactionService | null
  >(null)
  const searchReplacePreviewRef = useRef<
    import("../editor/workspace-edit-transaction.js").WorkspaceEditPreview | null
  >(null)
  const explorerExpandedIdsRef = useRef<string[]>([])
  const closedEditorUrisRef = useRef<string[]>([])
  const hydratedEditorOwnersRef = useRef(
    new Map<string, { uri: string; ownerId: string }>(),
  )
  const editorOwnerReconciliationRef = useRef<Promise<void>>(Promise.resolve())
  const lastEditorPaneRef = useRef<{
    windowId: string
    panelId: PanelId
  } | null>(null)
  const searchPreviewCommandRef = useRef<() => void>(() => {})
  const searchApplyCommandRef = useRef<() => Promise<void>>(async () => {})
  const searchUndoCommandRef = useRef<() => Promise<void>>(async () => {})

  const windowsRef = useRef(windows)
  windowsRef.current = windows
  const activeWindowIdRef = useRef(activeWindowId)
  activeWindowIdRef.current = activeWindowId
  const lastCwdUriRef = useRef(lastCwdUri)
  lastCwdUriRef.current = lastCwdUri
  const gitRootsRef = useRef(gitRoots)
  gitRootsRef.current = gitRoots
  const editorFilesRef = useRef(editorFiles)
  editorFilesRef.current = editorFiles
  const homeDirRef = useRef(homeDir)
  const bootstrappedRef = useRef(false)
  sessionRootPathRef.current = sessionCwdPath
  projectPathRef.current = sessionProjectPath
  sessionIdRef.current = sessionId
  machineHostnameRef.current = machineHostname
  homeDirRef.current = homeDir
  const paneBoxesRef = useRef(new Map<string, import("./MuxTerminalLayer.js").MuxTerminalSlotBox>())
  /** LRU of recently focused terminal tab ids (beyond the active window). */
  const terminalLruRef = useRef<string[]>([])
  const MAX_TERMINAL_PANES_PER_WORKSPACE = 6

  const activeWindow =
    windows.find(w => w.id === activeWindowId) ?? windows[0] ?? null
  const editorRuntimeNeeded =
    Object.keys(editorFiles).length > 0 ||
    windows.some(window =>
      listPaneLeaves(window.tree).some(leaf => leaf.kind === "editor"),
    )

  useEffect(() => {
    const subscription = workspace.onDidChangeDirty.event(() => {
      bumpEditorDirtyRevision()
    })
    return () => subscription.dispose()
  }, [workspace])

  const editorIsDirty = useCallback(
    (uri: string) => workspace.fileForUri(uri)?.isDirty ?? false,
    [editorDirtyRevision, workspace],
  )

  const resolveEditorDirtyClose = useCallback(
    async (
      uris: readonly string[],
      buffers: import("../editor/editor-buffer-service.js").EditorBufferService,
    ): Promise<boolean> => {
      const dirty = [...new Set(uris)].filter(uri => buffers.isDirty(uri))
      if (dirty.length === 0) return true
      const names = dirty.map(editorLabelFromUri)
      return resolveDirtyBufferClose(dirty, {
        choose: () =>
          requestSaveDiscard({
            title:
              dirty.length === 1
                ? `Save changes to ${names[0]}?`
                : `Save changes to ${dirty.length} files?`,
            description:
              dirty.length === 1
                ? "Your changes will be lost if you discard them."
                : `Unsaved: ${names.slice(0, 4).join(", ")}${
                    names.length > 4 ? `, and ${names.length - 4} more` : ""
                  }`,
          }),
        save: async uri => {
          try {
            await buffers.save(uri)
          } catch (error) {
            const saveAsRequired =
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "SAVE_AS_REQUIRED"
            if (saveAsRequired) {
              setSaveAsUri(uri)
            } else {
              showYaadeToast(
                error instanceof Error ? error.message : `Could not save ${editorLabelFromUri(uri)}`,
                { variant: "destructive" },
              )
            }
            throw error
          }
        },
        discard: async uri => {
          try {
            await buffers.discard(uri)
          } catch (error) {
            showYaadeToast(
              error instanceof Error
                ? error.message
                : `Could not discard ${editorLabelFromUri(uri)}`,
              { variant: "destructive" },
            )
            throw error
          }
        },
      })
    },
    [],
  )

  useEffect(() => subscribeTerminalSessions(() => bumpSessions()), [])

  useEffect(() => {
    const rootUri = pathToFileUri(sessionCwdPath)
    const owner = { sessionId }
    void window.yaade?.workspace?.activate(rootUri, owner)
    return () => {
      void window.yaade?.workspace?.deactivate?.(rootUri, owner)
    }
  }, [sessionCwdPath, sessionId])

  useEffect(() => {
    if (!editorRuntimeNeeded) return
    let cleanedUp = false
    let release: (() => void) | null = null
    void import("../editor/editor-buffer-service.js").then(
      ({ retainEditorBufferService }) => {
        const retained = retainEditorBufferService(workspace, sessionId)
        if (cleanedUp) retained()
        else release = retained
      },
    )
    return () => {
      cleanedUp = true
      release?.()
    }
  }, [editorRuntimeNeeded, sessionId, workspace])

  useEffect(() => {
    if (!editorRuntimeNeeded) return
    const desired = new Map<string, { uri: string; ownerId: string }>()
    for (const live of windows) {
      for (const panelId of getAllLeafPanels(live.tree)) {
        const view = live.tree.getView(panelId)
        if (view?.kind !== "tabs") continue
        const ownerId = `mux-editor-${panelId.id}`
        for (const uri of panelTabIds(view).filter(isEditorTabId)) {
          desired.set(`${ownerId}\0${uri}`, { uri, ownerId })
        }
      }
    }

    editorOwnerReconciliationRef.current =
      editorOwnerReconciliationRef.current
        .catch(() => {})
        .then(async () => {
          const [bufferModule, pendingModule] = await Promise.all([
            import("../editor/editor-buffer-service.js"),
            import("@yaade/monaco/pending"),
          ])
          const buffers = bufferModule.editorBufferServiceFor(workspace, sessionId)
          const previous = hydratedEditorOwnersRef.current
          for (const [key, owner] of previous) {
            if (!desired.has(key)) {
              buffers.close(owner.uri, { ownerId: owner.ownerId })
            }
          }
          const retained = new Map<string, { uri: string; ownerId: string }>()
          for (const [key, owner] of desired) {
            try {
              if (!previous.has(key)) {
                const pending = pendingModule.consumePendingInitialContent(owner.uri)
                await buffers.open({
                  uri: owner.uri,
                  languageId: languageIdFromPath(
                    owner.uri.split(/[?#]/)[0] ?? owner.uri,
                  ),
                  ownerId: owner.ownerId,
                  ...(pending == null ? {} : { initialContent: pending }),
                  initialDirty: owner.uri.startsWith("untitled:") && pending != null,
                })
              }
              retained.set(key, owner)
            } catch (error) {
              console.warn(`Could not hydrate editor buffer ${owner.uri}`, error)
            }
          }
          hydratedEditorOwnersRef.current = retained
        })
  }, [editorRuntimeNeeded, sessionId, windows, workspace])

  useEffect(() => {
    if (!layoutReady || surface !== "editors" || !editorWorkspacePath) return
    if (normalizeAbsPath(editorWorkspacePath) === normalizeAbsPath(sessionCwdPath)) return
    void workspace.addFolder(editorWorkspacePath).catch(error => {
      showYaadeToast(
        error instanceof Error ? error.message : "Could not open editor checkout",
        { variant: "destructive" },
      )
    })
  }, [editorWorkspacePath, layoutReady, sessionCwdPath, surface, workspace])

  const buildServerPayload = useCallback((): ProjectSessionPayload | null => {
    if (!sessionIdRef.current) return null
    const editorViewStates = snapshotEditorViewStates(sessionIdRef.current)
    const persisted = persistWindows(windowsRef.current)
    const live = persisted[0]
    if (!live) {
      return {
        version: 2,
        layout: {
          tree: emptyMuxTree().toJSON(),
          focusedPaneId: null,
          zoomedPaneId: null,
        },
        sessions: [],
        ...(Object.keys(gitRootsRef.current).length > 0
          ? { gitRoots: { ...gitRootsRef.current } }
          : {}),
        ...(Object.keys(editorFilesRef.current).length > 0
          ? { editorFiles: { ...editorFilesRef.current } }
          : {}),
        ...(Object.keys(editorViewStates).length > 0
          ? { editorViewStates }
          : {}),
      }
    }
    return {
      version: 2,
      layout: {
        tree: live.tree,
        focusedPaneId: live.focusedPaneId,
        zoomedPaneId: live.zoomedPaneId,
      },
      sessions: live.sessions ?? [],
      ...(Object.keys(gitRootsRef.current).length > 0
        ? { gitRoots: { ...gitRootsRef.current } }
        : {}),
      ...(Object.keys(editorFilesRef.current).length > 0
        ? { editorFiles: { ...editorFilesRef.current } }
        : {}),
      ...(Object.keys(editorViewStates).length > 0
        ? { editorViewStates }
        : {}),
    }
  }, [])

  const persist = useCallback(() => {
    if (!serverHydratedRef.current) return
    const snapshot = buildServerPayload()
    const id = sessionIdRef.current
    if (!snapshot || !id) return
    // Focus-only updates must not enqueue — tree/sessions unchanged.
    const structureKey = JSON.stringify({
      tree: snapshot.layout.tree,
      zoomedPaneId: snapshot.layout.zoomedPaneId,
      sessions: snapshot.sessions,
      gitRoots: snapshot.gitRoots ?? null,
      editorFiles: snapshot.editorFiles ?? null,
      editorViewStates: snapshot.editorViewStates ?? null,
    })
    if (structureKey === lastPersistStructureRef.current) return
    lastPersistStructureRef.current = structureKey
    persistWriterRef.current.enqueue(id, snapshot)
  }, [buildServerPayload])
  const persistRef = useRef(persist)
  persistRef.current = persist

  useEffect(() => {
    persist()
  }, [windows, activeWindowId, lastCwdUri, gitRoots, editorFiles, persist])

  useEffect(() => {
    const writer = persistWriterRef.current
    const persistLatest = () => {
      persistRef.current()
    }
    const onHide = () => {
      window.dispatchEvent(new Event("yaade:save-editor-view-state"))
      persistLatest()
      void writer.flush()
    }
    window.addEventListener("pagehide", onHide)
    return () => {
      window.removeEventListener("pagehide", onHide)
      // Capture the live tree even if the windows→persist effect has not run yet.
      persistLatest()
      void writer.flushAndStop()
    }
  }, [])

  const cwdUri = useCallback((): string => {
    if (surface === "editors" && editorWorkspacePath) {
      return pathToFileUri(editorWorkspacePath)
    }
    if (sessionRootPathRef.current) {
      return pathToFileUri(sessionRootPathRef.current)
    }
    return (
      lastCwdUriRef.current ??
      workspace.manager.activeFolder?.root.uri ??
      workspace.folders[0]?.root.uri ??
      (homeDirRef.current ? pathToFileUri(homeDirRef.current) : "")
    )
  }, [editorWorkspacePath, surface, workspace])

  const paneTitle = useCallback(
    (tabId: string): string => {
      const tool = muxToolPaneForTab(tabId)
      if (tool) return tool.label
      if (isGitTabId(tabId)) {
        return workspace.tabRegistry.get(tabId)?.label ?? "Git"
      }
      if (isEditorTabId(tabId)) {
        return (
          workspace.tabRegistry.get(tabId)?.label ?? editorLabelFromUri(tabId)
        )
      }
      const session = terminalSessionForTab(tabId)
      if (session?.customLabel) return session.customLabel
      const cwdPath = (() => {
        const uri = terminalCwdForTab(tabId)
        if (!uri) return null
        try {
          return fileUriToPath(uri)
        } catch {
          return null
        }
      })()
      const processName =
        processByTabRef.current[tabId] ??
        session?.launchCommand?.split(/[/\\\s]/).pop() ??
        null
      return formatMuxTitle({
        cwdPath,
        homeDir: homeDirRef.current || null,
        processName,
        fallback: workspace.tabRegistry.get(tabId)?.label ?? "Terminal",
      })
    },
    [workspace],
  )

  const paneProcessName = useCallback((tabId: string): string | null => {
    if (muxToolPaneForTab(tabId)) return null
    if (isGitTabId(tabId)) return "git"
    const session = terminalSessionForTab(tabId)
    return (
      processByTabRef.current[tabId] ??
      session?.launchCommand?.split(/[/\\\s]/).pop() ??
      null
    )
  }, [])

  const refreshForegroundProcess = useCallback(async (ptyTabId: string) => {
    const ptyId = terminalPtyIdForTab(ptyTabId)
    if (!ptyId || !window.yaade?.terminal?.getForegroundProcess) return
    try {
      const name = await window.yaade.terminal.getForegroundProcess(ptyId)
      if (!name) return
      if (processByTabRef.current[ptyTabId] === name) return
      processByTabRef.current = { ...processByTabRef.current, [ptyTabId]: name }
      // Only re-render mux chrome when the focused pane's process name changes.
      if (focusedPtyTabIdRef.current === ptyTabId) bumpSessions()
    } catch {
      /* ignore */
    }
  }, [])

  const updateWindow = useCallback(
    (windowId: string, mutate: (w: LiveWindow) => LiveWindow) => {
      setWindows(prev => prev.map(w => (w.id === windowId ? mutate(w) : w)))
    },
    [],
  )

  /** Keep every visible terminal live; cap panes before the mount budget is exceeded. */
  const canAddTerminalPane = useCallback((windowId: string): boolean => {
    const live = windowsRef.current.find(window => window.id === windowId)
    if (
      !live ||
      listTerminalLeaves(live.tree).length < MAX_TERMINAL_PANES_PER_WORKSPACE
    ) {
      return true
    }
    showYaadeToast(
      `Terminal pane limit reached (${MAX_TERMINAL_PANES_PER_WORKSPACE}). Close a terminal or use another session.`,
    )
    return false
  }, [])

  /** Side effects: register session + tab. Call OUTSIDE setState updaters. */
  const allocTerminalPane = useCallback(
    (options?: {
      launchCommand?: string
      launchArgs?: string[]
      launchEnv?: Record<string, string>
      label?: string
      rootUri?: string
      agentId?: string
      agentTitle?: string
      agentDriverId?: string
    }): AllocatedTerminalPane => {
      const sessionKey = allocTerminalSessionKey()
      const ptyTabId = terminalTabId(sessionKey)
      const rootUri = options?.rootUri ?? cwdUri()
      const label = options?.label ?? "Terminal"
      registerTerminalSession(ptyTabId, rootUri, options?.launchCommand, {
        customLabel: options?.label,
        launchArgs: options?.launchArgs,
        launchEnv: options?.launchEnv,
        agentId: options?.agentId,
        agentTitle: options?.agentTitle,
        agentDriverId: options?.agentDriverId,
        pendingCliMint: options?.agentId === "cursor",
      })
      workspace.registerTab({
        id: ptyTabId,
        kind: "terminal",
        label,
      })
      return {
        ptyTabId,
        label,
        rootUri,
        launchCommand: options?.launchCommand,
        launchArgs: options?.launchArgs,
      }
    },
    [cwdUri, workspace],
  )

  const allocGitPane = useCallback(
    (rootUri?: string): AllocatedGitPane => {
      const tabId = gitTabId(`pane-${Date.now().toString(36)}`)
      const gitRoot = rootUri || cwdUri()
      if (gitRoot) {
        gitRootsRef.current = { ...gitRootsRef.current, [tabId]: gitRoot }
        setGitRoots(prev => ({ ...prev, [tabId]: gitRoot }))
      }
      workspace.registerTab({
        id: tabId,
        kind: "git",
        label: "Git",
      })
      return { tabId, rootUri: gitRoot }
    },
    [cwdUri, workspace],
  )

  const allocEditorPane = useCallback(
    (
      uri: string,
      line?: number,
      column?: number,
    ): AllocatedEditorPane => {
      const canonical = uri.startsWith("file://")
        ? canonicalizeFileUri(uri)
        : uri
      // Reuse the existing tab id when the same file is already open under a
      // URI variant (encoding / `..` segments) so goto-def does not duplicate.
      const existingKey = Object.keys(editorFilesRef.current).find(k =>
        sameFileTab(k, canonical),
      )
      const tabId = existingKey ?? canonical
      const label = editorLabelFromUri(tabId)
      const entry = {
        uri: tabId,
        ...(line != null ? { line } : {}),
        ...(column != null && column > 0 ? { column } : {}),
      }
      editorFilesRef.current = { ...editorFilesRef.current, [tabId]: entry }
      setEditorFiles(prev => ({ ...prev, [tabId]: entry }))
      workspace.registerTab({ id: tabId, kind: "editor", label })
      return { tabId, uri: tabId, line, label }
    },
    [workspace],
  )

  const allocToolPane = useCallback(
    (kind: MuxToolKind): AllocatedToolPane => {
      const tool = muxToolPane(kind)
      if (
        !workspace.tabRegistry.get(tool.tabId) &&
        (kind === "explorer")
      ) {
        workspace.registerTab({
          id: tool.tabId,
          kind: "explorer",
          label: tool.label,
        })
      }
      return tool
    },
    [workspace],
  )

  /** Open another project in a browser tab (replaces in-app mux windows). */
  const openBrowserProjectTab = useCallback((absolutePath?: string) => {
    const home = homeDirRef.current
    const target = absolutePath
      ? urlPathForProjectRoot(absolutePath, home)
      : "/"
    window.open(target, "_blank", "noopener,noreferrer")
  }, [])

  /**
   * Ensure the page has a project window. New sessions start empty — no PTY
   * until the user opens Terminal / Neovim / Git / Editor from the empty state.
   */
  const ensureProjectWindow = useCallback((): LiveWindow => {
    const existing =
      windowsRef.current.find(w => w.id === activeWindowIdRef.current) ??
      windowsRef.current[0] ??
      null

    if (existing) {
      if (activeWindowIdRef.current !== existing.id) {
        setActiveWindowId(existing.id)
      }
      return existing
    }

    const id = allocWindowId()
    const base: LiveWindow = {
      id,
      title: "Window",
      tree: emptyMuxTree(),
      focusedPaneId: null,
      zoomedPaneId: null,
    }
    setWindows([base])
    setActiveWindowId(id)
    return base
  }, [])

  const openToolPane = useCallback(
    (kind: MuxToolKind): void => {
      const window = ensureProjectWindow()
      const pane = allocToolPane(kind)
      const existing = listPaneLeaves(window.tree).find(
        leaf => leaf.ptyTabId === pane.tabId,
      )
      if (existing) {
        setActiveWindowId(window.id)
        updateWindow(window.id, live => ({
          ...live,
          focusedPaneId: existing.panelId,
          zoomedPaneId:
            live.zoomedPaneId && live.zoomedPaneId !== pane.tabId
              ? null
              : live.zoomedPaneId,
        }))
        return
      }
      updateWindow(window.id, live => placeToolPane(live, pane))
    },
    [allocToolPane, ensureProjectWindow, updateWindow],
  )

  const runExplorerAction = useCallback(
    (action: MuxExplorerAction): void => {
      pendingExplorerActionRef.current = action
      openToolPane("explorer")
      const controller = explorerControllerRef.current
      if (!controller) return
      window.requestAnimationFrame(() => {
        if (pendingExplorerActionRef.current !== action) return
        pendingExplorerActionRef.current = null
        controller.run(action)
      })
    },
    [openToolPane],
  )

  const runToolPane = useCallback(
    (kind: Exclude<MuxToolKind, "explorer">): void => {
      bumpToolRevision(kind)
      openToolPane(kind)
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const pane = document.querySelector<HTMLElement>(
            `[data-yaade-tool-pane="${kind}"]`,
          )
          const focusTarget = pane?.querySelector<HTMLElement>(
            "input:not([disabled]), [data-yaade-list-item], button:not([disabled])",
          )
          ;(focusTarget ?? pane)?.focus({ preventScroll: true })
        })
      })
    },
    [openToolPane],
  )

  const rememberClosedEditors = useCallback((uris: readonly string[]) => {
    for (const uri of uris) {
      closedEditorUrisRef.current = [
        uri,
        ...closedEditorUrisRef.current.filter(item => !sameFileTab(item, uri)),
      ].slice(0, 20)
    }
  }, [])

  const closeWindow = useCallback(
    async (windowId: string, options?: { skipConfirm?: boolean }) => {
      const live = windowsRef.current.find(w => w.id === windowId)
      if (!live) return
      const panes = listPaneLeaves(live.tree)
      const editorBufferOwners = panes.flatMap(pane => {
        if (pane.kind !== "editor") return []
        const view = live.tree.getView(pane.panelId)
        const uris =
          view?.kind === "tabs"
            ? panelTabIds(view).filter(id => isEditorTabId(id))
            : [pane.ptyTabId]
        return uris.map(uri => ({
          uri,
          ownerId: `mux-editor-${pane.panelId.id}`,
        }))
      })
      const editorBufferIds = editorBufferOwners.map(owner => owner.uri)
      let editorBuffers:
        | import("../editor/editor-buffer-service.js").EditorBufferService
        | null = null
      if (editorBufferIds.length > 0) {
        const { editorBufferServiceFor } = await import(
          "../editor/editor-buffer-service.js"
        )
        editorBuffers = editorBufferServiceFor(workspace, sessionIdRef.current)
        if (!(await resolveEditorDirtyClose(editorBufferIds, editorBuffers))) return
      }
      if (!options?.skipConfirm) {
        for (const pane of panes) {
          if (pane.kind !== "terminal") continue
          const session = terminalSessionForTab(pane.ptyTabId)
          if (terminalSessionNeedsCloseConfirmation(session)) {
            const ok = await requestConfirm({
              title: `Close ${paneTitle(pane.ptyTabId)}?`,
              description: "Running shells in this window will be stopped.",
              confirmLabel: "Close",
              cancelLabel: "Keep Running",
              destructive: true,
            })
            if (!ok) return
            break
          }
        }
      }
      rememberClosedEditors(editorBufferIds)
      for (const pane of panes) {
        if (pane.kind === "terminal") {
          const ptyId = terminalPtyIdForTab(pane.ptyTabId)
          if (ptyId) void window.yaade?.terminal?.dispose(ptyId)
          clearTerminalSession(pane.ptyTabId)
        }
        if (pane.kind !== "editor") workspace.disposeTab(pane.ptyTabId)
      }
      for (const owner of editorBufferOwners) {
        editorBuffers?.close(owner.uri, { ownerId: owner.ownerId })
        if ((editorBuffers?.snapshot(owner.uri)?.ownerCount ?? 0) === 0) {
          workspace.disposeTab(owner.uri)
        }
      }
      const closedGitIds = panes
        .filter(p => p.kind === "git")
        .map(p => p.ptyTabId)
      if (closedGitIds.length > 0) {
        setGitRoots(prev => {
          let changed = false
          const next = { ...prev }
          for (const id of closedGitIds) {
            if (id in next) {
              delete next[id]
              changed = true
            }
          }
          return changed ? next : prev
        })
      }
      const closedEditorIds = editorBufferIds
      if (closedEditorIds.length > 0) {
        const prune = (prev: Record<string, unknown>) => {
          let changed = false
          const next = { ...prev }
          for (const id of closedEditorIds) {
            if (id in next) {
              delete next[id]
              changed = true
            }
          }
          return changed ? next : prev
        }
        setEditorFiles(prev => prune(prev) as typeof prev)
      }
      // Single-window model: reset to an empty window (no auto-spawned PTY).
      const id = allocWindowId()
      const next: LiveWindow = {
        id,
        title: "Window",
        tree: emptyMuxTree(),
        focusedPaneId: null,
        zoomedPaneId: null,
      }
      setWindows([next])
      setActiveWindowId(id)
    },
    [paneTitle, rememberClosedEditors, resolveEditorDirtyClose, workspace],
  )

  const closePane = useCallback(
    async (
      windowId: string,
      panelId: PanelId,
      tabId: string,
      options?: { skipConfirm?: boolean },
    ) => {
      const live = windowsRef.current.find(w => w.id === windowId)
      if (!live) return
      const isTerminal = isTerminalTabId(tabId)
      if (!options?.skipConfirm && isTerminal) {
        const session = terminalSessionForTab(tabId)
        if (terminalSessionNeedsCloseConfirmation(session)) {
          const ok = await requestConfirm({
            title: `Close ${paneTitle(tabId)}?`,
            description: "The running shell process will be stopped.",
            confirmLabel: "Close Pane",
            cancelLabel: "Keep Running",
            destructive: true,
          })
          if (!ok) return
        }
      }
      if (isTerminal) {
        const ptyId = terminalPtyIdForTab(tabId)
        if (ptyId) void window.yaade?.terminal?.dispose(ptyId)
        clearTerminalSession(tabId)
      } else if (isGitTabId(tabId)) {
        setGitRoots(prev => {
          if (!(tabId in prev)) return prev
          const next = { ...prev }
          delete next[tabId]
          return next
        })
      } else if (isEditorTabId(tabId)) {
        const liveNow = windowsRef.current.find(w => w.id === windowId)
        const view = liveNow?.tree.getView(panelId)
        const editorTabs =
          view?.kind === "tabs"
            ? panelTabIds(view).filter(id => isEditorTabId(id))
            : [tabId]
        const { editorBufferServiceFor } = await import(
          "../editor/editor-buffer-service.js"
        )
        const buffers = editorBufferServiceFor(workspace, sessionIdRef.current)
        if (!(await resolveEditorDirtyClose(editorTabs, buffers))) return
        rememberClosedEditors(editorTabs)
        const ownerId = `mux-editor-${panelId.id}`
        for (const id of editorTabs) {
          buffers.close(id, { ownerId })
        }
        const closedCompletely = editorTabs.filter(
          id => (buffers.snapshot(id)?.ownerCount ?? 0) === 0,
        )
        setEditorFiles(prev => {
          let changed = false
          const next = { ...prev }
          for (const id of closedCompletely) {
            if (id in next) {
              delete next[id]
              changed = true
            }
          }
          return changed ? next : prev
        })
        for (const id of closedCompletely) workspace.disposeTab(id)
        updateWindow(windowId, w => {
          const tree = w.tree.clone()
          clearEditorTabsFromPanel(tree, panelId)
          return {
            ...w,
            tree,
            zoomedPaneId: editorTabs.includes(w.zoomedPaneId ?? "")
              ? null
              : w.zoomedPaneId,
            focusedPaneId:
              w.focusedPaneId?.id === panelId.id
                ? (listPaneLeaves(tree)[0]?.panelId ?? null)
                : w.focusedPaneId,
          }
        })
        return
      }
      workspace.disposeTab(tabId)
      updateWindow(windowId, w => {
        const tree = w.tree.clone()
        removePtyFromTree(tree, panelId, tabId)
        return {
          ...w,
          tree,
          zoomedPaneId: w.zoomedPaneId === tabId ? null : w.zoomedPaneId,
          focusedPaneId:
            w.focusedPaneId?.id === panelId.id
              ? (listPaneLeaves(tree)[0]?.panelId ?? null)
              : w.focusedPaneId,
        }
      })
    },
    [
      paneTitle,
      rememberClosedEditors,
      resolveEditorDirtyClose,
      updateWindow,
      workspace,
    ],
  )

  /** Close a single editor buffer tab (keeps the pane until the last tab). */
  const closeEditorTab = useCallback(
    async (windowId: string, panelId: PanelId, tabId: string) => {
      if (!isEditorTabId(tabId)) return
      const { editorBufferServiceFor } = await import(
        "../editor/editor-buffer-service.js"
      )
      const buffers = editorBufferServiceFor(workspace, sessionIdRef.current)
      if (!(await resolveEditorDirtyClose([tabId], buffers))) return
      if (
        !buffers.close(tabId, {
          ownerId: `mux-editor-${panelId.id}`,
        })
      ) {
        showYaadeToast("Save or discard the unsaved buffer before closing it.", {
          variant: "warning",
        })
        return
      }
      rememberClosedEditors([tabId])
      if ((buffers.snapshot(tabId)?.ownerCount ?? 0) === 0) {
        setEditorFiles(prev => {
          if (!(tabId in prev)) return prev
          const next = { ...prev }
          delete next[tabId]
          return next
        })
        workspace.disposeTab(tabId)
      }
      updateWindow(windowId, w => {
        const tree = w.tree.clone()
        removePtyFromTree(tree, panelId, tabId)
        const remaining = listPaneLeaves(tree)
        return {
          ...w,
          tree,
          zoomedPaneId: w.zoomedPaneId === tabId ? null : w.zoomedPaneId,
          focusedPaneId:
            w.focusedPaneId?.id === panelId.id
              ? remaining.find(l => l.panelId.id === panelId.id)?.panelId ??
                remaining[0]?.panelId ??
                null
              : w.focusedPaneId,
        }
      })
    },
    [rememberClosedEditors, resolveEditorDirtyClose, updateWindow, workspace],
  )

  /** Activate an editor buffer tab inside a panel. */
  const activateEditorTab = useCallback(
    (windowId: string, panelId: PanelId, tabId: string) => {
      updateWindow(windowId, w => {
        const view = w.tree.getView(panelId)
        if (!view || view.kind !== "tabs") return w
        if (!panelTabIds(view).includes(tabId)) return w
        const tree = w.tree.clone()
        tree.setView(panelId, activatePanelTab(view, tabId))
        return { ...w, tree, focusedPaneId: panelId }
      })
    },
    [updateWindow],
  )

  /** Prefer the source pane's live shell cwd when opening splits. */
  const resolveSplitCwdUri = useCallback(
    async (windowId: string, panelId: PanelId): Promise<string> => {
      const live = windowsRef.current.find(w => w.id === windowId)
      const leaf = live
        ? listPaneLeaves(live.tree).find(p => p.panelId.id === panelId.id)
        : undefined
      if (leaf?.kind === "git") {
        return gitRootsRef.current[leaf.ptyTabId] || cwdUri()
      }
      if (leaf?.kind === "terminal") {
        const ptyId = terminalPtyIdForTab(leaf.ptyTabId)
        if (ptyId) {
          try {
            const liveCwd = await window.yaade?.terminal?.getCwd?.(ptyId)
            if (liveCwd) {
              updateTerminalLiveCwd(leaf.ptyTabId, liveCwd)
              return liveCwd
            }
          } catch {
            /* fall through — title / spawn-time cwd */
          }
        }
        const title = workspace.tabRegistry.get(leaf.ptyTabId)?.label ?? ""
        const fromTitle = cwdUriFromTerminalTitle(
          title,
          homeDirRef.current || "",
        )
        if (fromTitle) {
          updateTerminalLiveCwd(leaf.ptyTabId, fromTitle)
          return fromTitle
        }
        const sessionCwd = terminalCwdForTab(leaf.ptyTabId)
        if (sessionCwd) return sessionCwd
      }
      return cwdUri()
    },
    [cwdUri, workspace],
  )

  const splitPane = useCallback(
    async (windowId: string, panelId: PanelId, edge: "right" | "bottom") => {
      if (!canAddTerminalPane(windowId)) return
      const rootUri = await resolveSplitCwdUri(windowId, panelId)
      const pane = allocTerminalPane({ rootUri })
      updateWindow(windowId, w => placeTerminalPane(w, pane, edge, panelId))
    },
    [allocTerminalPane, canAddTerminalPane, resolveSplitCwdUri, updateWindow],
  )

  /** Open a terminal in the active window (fill empty, else split). */
  const openTerminalInActiveWindow = useCallback(
    async (
      edge: "right" | "bottom" = "right",
      options?: { rootUri?: string },
    ) => {
      const w = ensureProjectWindow()
      if (listPaneLeaves(w.tree).length === 0 || !w.focusedPaneId) {
        if (!canAddTerminalPane(w.id)) return
        const pane = allocTerminalPane(
          options?.rootUri ? { rootUri: options.rootUri } : undefined,
        )
        updateWindow(w.id, live => placeTerminalPane(live, pane))
        return
      }
      if (options?.rootUri) {
        if (!canAddTerminalPane(w.id)) return
        const pane = allocTerminalPane({ rootUri: options.rootUri })
        updateWindow(w.id, live =>
          placeTerminalPane(live, pane, edge, w.focusedPaneId),
        )
        return
      }
      await splitPane(w.id, w.focusedPaneId, edge)
    },
    [allocTerminalPane, canAddTerminalPane, ensureProjectWindow, splitPane, updateWindow],
  )

  /** Launch a known agent CLI into the active (or empty) window. */
  const openAgentCliPane = useCallback(
    async (
      driver: AgentCliDriver,
      launchRequestId = `agent-${Date.now()}-${driver.id}`,
      checkout?: {
        checkoutPath?: string
        checkoutKey?: string
        checkoutLabel?: string
      },
    ): Promise<{ tabId: string; runId: string } | null> => {
      const w = ensureProjectWindow()
      if (!canAddTerminalPane(w.id)) return null
      const checkoutPath = checkout?.checkoutPath?.trim() || sessionProjectPath
      const rootUri = pathToFileUri(checkoutPath)
      const checkoutKey =
        checkout?.checkoutKey?.trim() ||
        (checkoutPath === sessionProjectPath ? "main" : checkoutPath)
      const api = window.yaade?.agents
      if (!api) throw new Error("Agent management is unavailable")
      const launched = await api.launch({
        launchRequestId,
        provider: driver.id,
        projectId,
        workspaceId: sessionId,
        checkoutKey,
        checkoutPath,
        title: driver.label,
      })
      if (!launched.pty?.id || launched.run.processState !== "running") {
        throw new Error("The agent process did not start")
      }
      const ptyTabId = terminalTabId(launched.run.runId)
      registerTerminalSession(ptyTabId, rootUri, undefined, {
        customLabel: driver.label,
        agentId: driver.id,
        agentTitle: driver.label,
        agentDriverId: agentDriverIdForMode(driver.id, "cli"),
        pendingCliMint: false,
      })
      trackTerminalPtyId(ptyTabId, launched.pty.id)
      workspace.registerTab({
        id: ptyTabId,
        kind: "terminal",
        label: driver.label,
      })
      const pane: AllocatedTerminalPane = {
        ptyTabId,
        label: driver.label,
        rootUri,
      }
      updateWindow(w.id, live => placeTerminalPane(live, pane))
      return { tabId: ptyTabId, runId: launched.run.runId }
    },
    [
      canAddTerminalPane,
      cwdUri,
      ensureProjectWindow,
      projectId,
      sessionProjectPath,
      sessionId,
      updateWindow,
      workspace,
    ],
  )

  /**
   * Reconcile agents launched outside this Mux instance (for example from HQ)
   * back into the project session layout. Agent runs are authoritative on the
   * host; the layout is only a view of them, so an empty payload must not hide
   * a still-running PTY.
   */
  const reconcileLiveAgentRuns = useCallback(
    (runs: readonly AgentRunInfo[]) => {
      const currentWindows = windowsRef.current
      const currentWindow =
        currentWindows.find(w => w.id === activeWindowIdRef.current) ??
        currentWindows[0]
      if (!currentWindow) return

      let nextWindow = currentWindow
      let changed = false
      for (const run of runs) {
        if (
          run.workspaceId !== sessionId ||
          !run.ptyId ||
          (run.processState !== "running" && run.processState !== "starting")
        ) {
          continue
        }

        const tabId = terminalTabId(run.runId)
        const existing = terminalSessionForTab(tabId)
        if (existing) {
          if (existing.ptyId !== run.ptyId) {
            trackTerminalPtyId(tabId, run.ptyId)
          }
          if (!workspace.tabRegistry.get(tabId)) {
            workspace.registerTab({
              id: tabId,
              kind: "terminal",
              label: existing.agentTitle ?? run.title,
            })
          }
        } else {
          hydrateTerminalSession({
            tabId,
            cwdRootUri: pathToFileUri(run.checkoutPath),
            ptyId: run.ptyId,
            status: "running",
            customLabel: run.title,
            agentId: run.provider,
            agentTitle: run.title,
            agentDriverId: agentDriverIdForMode(run.provider, "cli"),
          })
          workspace.registerTab({
            id: tabId,
            kind: "terminal",
            label: run.title,
          })
          changed = true
        }

        if (!listTerminalLeaves(nextWindow.tree).some(leaf => leaf.ptyTabId === tabId)) {
          nextWindow = placeTerminalPane(
            nextWindow,
            {
              ptyTabId: tabId,
              label: run.title,
              rootUri: pathToFileUri(run.checkoutPath),
            },
            "right",
            nextWindow.focusedPaneId,
          )
          changed = true
        }
      }

      if (!changed) return
      const nextWindows = currentWindows.map(window =>
        window.id === nextWindow.id ? nextWindow : window,
      )
      windowsRef.current = nextWindows
      setWindows(nextWindows)
      bumpSessions()
    },
    [sessionId, workspace],
  )

  useEffect(() => {
    if (!layoutReady || !serverHydratedRef.current) return
    const api = window.yaade?.agents
    if (!api) return
    let cancelled = false
    const reconcile = () => {
      void api.listLive(projectId).then(runs => {
        if (!cancelled) reconcileLiveAgentRuns(runs)
      }).catch(() => {
        /* The project surface remains usable if live-agent reconciliation is unavailable. */
      })
    }
    reconcile()
    const off = api.onEvent(event => {
      if (
        event.type === "agents.run" &&
        event.run?.workspaceId === sessionId
      ) {
        reconcile()
      }
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [layoutReady, projectId, reconcileLiveAgentRuns, sessionId])

  const openGitSplit = useCallback(
    async (windowId: string, panelId: PanelId | null) => {
      const rootUri = panelId
        ? await resolveSplitCwdUri(windowId, panelId)
        : cwdUri()
      const pane = allocGitPane(rootUri)
      updateWindow(windowId, w => placeGitPane(w, pane, "right", panelId))
      // Git lives on the Changes project tab, not the Terminals sidebar view.
      onRequestSurface?.("changes")
    },
    [allocGitPane, cwdUri, onRequestSurface, resolveSplitCwdUri, updateWindow],
  )

  const openNeovimSplit = useCallback(
    async (
      windowId: string,
      panelId: PanelId | null,
      options?: { filePath?: string; line?: number },
    ) => {
      if (!canAddTerminalPane(windowId)) return
      const rootUri = panelId
        ? await resolveSplitCwdUri(windowId, panelId)
        : cwdUri()
      const launchArgs: string[] = []
      if (options?.filePath) {
        if (options.line != null && options.line > 0) {
          launchArgs.push(`+${options.line}`)
        }
        launchArgs.push(options.filePath)
      }
      const pane = allocTerminalPane({
        launchCommand: "nvim",
        launchArgs: launchArgs.length > 0 ? launchArgs : undefined,
        label: "Neovim",
        rootUri,
      })
      updateWindow(windowId, w => placeTerminalPane(w, pane, "right", panelId))
    },
    [allocTerminalPane, canAddTerminalPane, cwdUri, resolveSplitCwdUri, updateWindow],
  )

  const openEditorSplit = useCallback(
    async (
      windowId: string,
      panelId: PanelId | null,
      options?: {
        uri?: string
        filePath?: string
        line?: number
        column?: number
        forceNewGroup?: boolean
      },
    ) => {
      let uri = options?.uri
      if (!uri && options?.filePath) {
        uri = resolveEditorUri(cwdUri(), options.filePath)
      }
      if (!uri) {
        // No target yet — let quick open pick a file, then open it in-focus.
        setQuickOpenOpen(true)
        return
      }
      if (uri.startsWith("file://")) uri = canonicalizeFileUri(uri)
      const pane = allocEditorPane(uri, options?.line, options?.column)
      updateWindow(windowId, w =>
        placeEditorPane(w, pane, "right", panelId, {
          forceNewGroup: options?.forceNewGroup === true,
        }),
      )
      onRequestSurface?.("editors")
    },
    [allocEditorPane, cwdUri, onRequestSurface, updateWindow],
  )

  const openEditorInFocused = useCallback(
    (options?: {
      uri?: string
      filePath?: string
      line?: number
      column?: number
      forceNewGroup?: boolean
    }) => {
      const w = ensureProjectWindow()
      const leaves = listPaneLeaves(w.tree)
      const focusedEditor = leaves.find(
        leaf =>
          leaf.kind === "editor" &&
          leaf.panelId.id === w.focusedPaneId?.id,
      )
      const remembered = lastEditorPaneRef.current
      const rememberedEditor =
        remembered?.windowId === w.id
          ? leaves.find(
              leaf =>
                leaf.kind === "editor" &&
                leaf.panelId.id === remembered.panelId.id,
            )
          : undefined
      const editorAnchor =
        focusedEditor ??
        rememberedEditor ??
        leaves.find(leaf => leaf.kind === "editor")
      if (editorAnchor) {
        lastEditorPaneRef.current = {
          windowId: w.id,
          panelId: editorAnchor.panelId,
        }
      }
      const panelId =
        editorAnchor?.panelId ??
        w.focusedPaneId ??
        leaves[0]?.panelId ??
        null
      void openEditorSplit(w.id, panelId, {
        ...options,
        forceNewGroup: options?.forceNewGroup === true,
      })
    },
    [ensureProjectWindow, openEditorSplit],
  )

  /** Respects Settings → Editor (Monaco vs Neovim) for file opens. */
  const openInPreferredEditor = useCallback(
    (options?: {
      uri?: string
      filePath?: string
      line?: number
      column?: number
      forceNewGroup?: boolean
    }) => {
      if (appearanceSettings.preferredEditor !== "neovim") {
        openEditorInFocused(options)
        return
      }
      let filePath = options?.filePath
      if (!filePath && options?.uri?.startsWith("file://")) {
        try {
          filePath = fileUriToPath(options.uri)
        } catch {
          filePath = undefined
        }
      }
      const w = ensureProjectWindow()
      void openNeovimSplit(w.id, w.focusedPaneId, {
        filePath,
        line: options?.line,
      })
    },
    [
      appearanceSettings.preferredEditor,
      ensureProjectWindow,
      openEditorInFocused,
      openNeovimSplit,
    ],
  )

  const untitledDropCounterRef = useRef(0)
  const openUntitledFromDrop = useCallback(
    (name: string, content: string) => {
      untitledDropCounterRef.current += 1
      const safe = name.replace(/[/\\]/g, "_").trim() || "Untitled"
      const uri = `untitled:${safe}-${untitledDropCounterRef.current}`
      // Lazy: keep monaco editor out of the mux startup graph.
      void import("@yaade/monaco/pending").then(({ setPendingInitialContent }) => {
        setPendingInitialContent(uri, content)
        openEditorInFocused({ uri })
      })
    },
    [openEditorInFocused],
  )

  const knownDropWorkspacePaths = useMemo(() => {
    const roots = [sessionCwdPath, sessionProjectPath, editorWorkspacePath]
      .map(p => normalizeAbsPath(p))
      .filter((p): p is string => Boolean(p))
    return [...new Set(roots)]
  }, [editorWorkspacePath, sessionCwdPath, sessionProjectPath])

  useFileDrop({
    fs: jetPlatformFS(),
    knownWorkspacePaths: knownDropWorkspacePaths,
    activeWorkspacePath: normalizeAbsPath(
      surface === "editors" ? editorWorkspacePath ?? sessionCwdPath : sessionCwdPath,
    ),
    normalizePath: normalizeAbsPath,
    openWorkspace: path => openBrowserProjectTab(path),
    // Mux is single-project; still open dropped files outside the root.
    addWorkspaceFolder: () => {},
    openFile: (uri, _path) => {
      openEditorInFocusedRef.current({ uri })
    },
    bootstrapFromLaunch: (config: LaunchConfig) => {
      if (config.filePath) {
        openEditorInFocusedRef.current({
          uri: pathToFileUri(config.filePath),
        })
      } else if (config.workspacePath) {
        openBrowserProjectTab(config.workspacePath)
      }
    },
    openUntitledFromDrop,
    setMessage: showYaadeToast,
  })

  const zoomPane = useCallback(
    (windowId: string, ptyTabId: string) => {
      updateWindow(windowId, w => ({
        ...w,
        zoomedPaneId: w.zoomedPaneId === ptyTabId ? null : ptyTabId,
      }))
    },
    [updateWindow],
  )

  const unzoomIfNeeded = useCallback(() => {
    const w = windowsRef.current.find(x => x.id === activeWindowIdRef.current)
    if (!w?.zoomedPaneId) return false
    updateWindow(w.id, cur => ({ ...cur, zoomedPaneId: null }))
    return true
  }, [updateWindow])

  const focusPane = useCallback(
    (windowId: string, panelId: PanelId, ptyTabId?: string) => {
      const live = windowsRef.current.find(window => window.id === windowId)
      const leaf = live
        ? listPaneLeaves(live.tree).find(
            candidate => candidate.panelId.id === panelId.id,
          )
        : undefined
      if (leaf?.kind === "editor") {
        lastEditorPaneRef.current = { windowId, panelId }
      }
      setActiveWindowId(windowId)
      updateWindow(windowId, w => ({
        ...w,
        focusedPaneId: panelId,
        zoomedPaneId:
          ptyTabId && w.zoomedPaneId && w.zoomedPaneId !== ptyTabId
            ? null
            : w.zoomedPaneId,
      }))
    },
    [updateWindow],
  )

  const focusNeighbor = useCallback(
    (direction: FocusDirection) => {
      const w = windowsRef.current.find(x => x.id === activeWindowIdRef.current)
      if (!w?.focusedPaneId) return
      const leaves = listPaneLeaves(w.tree)
      const panes = leaves
        .map(leaf => {
          const box = paneBoxesRef.current.get(leaf.ptyTabId)
          if (!box) return null
          return { panelId: leaf.panelId, ptyTabId: leaf.ptyTabId, box }
        })
        .filter((p): p is NonNullable<typeof p> => p != null)
      const next = findFocusNeighbor(panes, w.focusedPaneId, direction)
      if (next) focusPane(w.id, next.panelId, next.ptyTabId)
    },
    [focusPane],
  )

  const openWorkspace = useCallback(
    async (folderPath: string) => {
      await workspace.openWorkspace(folderPath)
      const uri =
        workspace.manager.activeFolder?.root.uri ?? pathToFileUri(folderPath)
      setLastCwdUri(uri)
      sessionRootPathRef.current = folderPath
      const titleBase = workspaceDocumentTitle(
        projectPathRef.current || folderPath,
        homeDirRef.current,
      )
      document.title = titleBase
      setLayoutReady(true)
    },
    [workspace],
  )

  const applyServerPayload = useCallback(
    (payload: ProjectSessionPayload) => {
      replaceEditorViewStates(sessionIdRef.current, payload.editorViewStates)
      if (payload.gitRoots) {
        setGitRoots(payload.gitRoots)
        gitRootsRef.current = payload.gitRoots
      }
      const windowPersisted: MuxWindowPersisted = {
        id: allocWindowId(),
        title: "Window",
        tree: payload.layout.tree as MuxWindowPersisted["tree"],
        focusedPaneId: payload.layout.focusedPaneId,
        zoomedPaneId: payload.layout.zoomedPaneId,
        sessions: payload.sessions.map(
          (s): MuxSessionLeafPersisted => ({
            ptyTabId: s.ptyTabId,
            cwdRootUri: s.cwdRootUri,
            liveCwdUri: s.liveCwdUri,
            launchCommand: s.launchCommand,
            launchArgs: s.launchArgs ? [...s.launchArgs] : undefined,
            label: s.label,
            agentProvider: s.agentProvider,
            agentTitle: s.agentTitle,
            // Reattach same-host reload; attach miss → fresh PTY.
            ...(s.ptyId ? { ptyId: s.ptyId } : {}),
          }),
        ),
      }
      try {
        hydratePersistedSessions([windowPersisted], workspace)
        const hydrated = hydrateWindows([windowPersisted])
        const live = hydrated[0]
        if (!live) {
          ensureProjectWindow()
          return
        }
        if (payload.editorFiles) {
          const migrated = migrateLegacyEditorTabs(
            live.tree,
            payload.editorFiles,
          )
          setEditorFiles(migrated)
          editorFilesRef.current = migrated
          for (const [k, v] of Object.entries(migrated)) {
            if (!workspace.tabRegistry.get(k)) {
              workspace.registerTab({
                id: k,
                kind: "editor",
                label: editorLabelFromUri(v.uri),
              })
            }
          }
        }
        setWindows([live])
        setActiveWindowId(live.id)
      } catch {
        ensureProjectWindow()
      }
    },
    [ensureProjectWindow, workspace],
  )

  useEffect(() => {
    if (bootstrappedRef.current) return
    let cancelled = false
    const payload = initialPayload
    void (async () => {
      const finishBoot = () => {
        if (cancelled) return
        serverHydratedRef.current = true
        bootstrappedRef.current = true
      }

      try {
        await openWorkspace(sessionCwdPath)
        if (cancelled) return
        applyServerPayload(payload)
        finishBoot()
        if (!cancelled) persist()
      } catch {
        setLayoutReady(true)
        ensureProjectWindow()
        finishBoot()
      }
    })()
    return () => {
      cancelled = true
      // StrictMode remounts reset React state (layoutReady) but keep refs.
      // Allow the next mount to re-run boot so waitForReady cannot hang.
      bootstrappedRef.current = false
    }
    // Boot once per mount for this session id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const handlePanelEvent = useCallback(
    (windowId: string, event: PanelEvent) => {
      if (event.type === "splitRatiosChanged") {
        updateWindow(windowId, w => {
          const tree = w.tree.clone()
          tree.setSplitRatios(event.path, event.ratios)
          return { ...w, tree }
        })
        return
      }
      if (event.type === "panelClose") {
        const live = windowsRef.current.find(w => w.id === windowId)
        if (!live) return
        const pty = listPaneLeaves(live.tree).find(
          p => p.panelId.id === event.panelId.id,
        )
        if (pty) void closePane(windowId, event.panelId, pty.ptyTabId)
      }
    },
    [closePane, updateWindow],
  )

  /** Pane rearrange inside the active window + docking strip windows into it. */
  const tabDnd = useMemo((): TabDndHandlers => {
    return {
      onTabReorder: () => {
        // One PTY per leaf — reorder within a leaf is a no-op.
      },
      tabIdsForPanel: panelId => {
        const w = windowsRef.current.find(
          x => x.id === activeWindowIdRef.current,
        )
        if (!w) return []
        const view = w.tree.getView(panelId)
        if (
          view?.kind === "tabs" &&
          isEditorTabId(view.activeTabId)
        ) {
          return panelTabIds(view).filter(isEditorTabId)
        }
        const tab = activeMuxTabInPanel(w.tree, panelId)
        return tab ? [tab] : []
      },
      onTabDrop: (source, sourceTabId, target, action) => {
        const windowId = activeWindowIdRef.current
        if (!windowId) return
        if (isEditorTabId(sourceTabId)) {
          void (async () => {
            try {
              const { editorBufferServiceFor } = await import(
                "../editor/editor-buffer-service.js"
              )
              const live = windowsRef.current.find(w => w.id === windowId)
              if (!live) return
              const tree = live.tree.clone()
              const result = applySessionPaneDrop(
                tree,
                source,
                sourceTabId,
                target,
                action,
              )
              if (!result.moved) return
              const destination = result.createdPanel ?? target
              const sourceOwner = `mux-editor-${source.id}`
              const destinationOwner = `mux-editor-${destination.id}`
              const buffers = editorBufferServiceFor(
                workspace,
                sessionIdRef.current,
              )
              buffers.moveOwner(sourceTabId, sourceOwner, destinationOwner)
              moveEditorViewState(
                sessionIdRef.current,
                sourceOwner,
                destinationOwner,
                sourceTabId,
              )
              updateWindow(windowId, current => ({
                ...current,
                tree,
                zoomedPaneId: null,
                focusedPaneId: result.focusPanel,
              }))
            } catch (error) {
              showYaadeToast(
                error instanceof Error
                  ? error.message
                  : "Could not move the editor tab",
                { variant: "destructive" },
              )
            }
          })()
          return
        }
        updateWindow(windowId, w => {
          const tree = w.tree.clone()
          const result = applySessionPaneDrop(
            tree,
            source,
            sourceTabId,
            target,
            action,
          )
          return {
            ...w,
            tree,
            zoomedPaneId: null,
            focusedPaneId: result.focusPanel,
          }
        })
      },
      onSessionDrop: (sourceWindowId, target, action) => {
        if (sourceWindowId === activeWindowIdRef.current) return
        const activeId = activeWindowIdRef.current
        if (!activeId) return
        const source = windowsRef.current.find(w => w.id === sourceWindowId)
        if (!source) return
        const leaves = listPaneLeaves(source.tree)
        if (leaves.length === 0) return

        setWindows(prev => {
          const active = prev.find(w => w.id === activeId)
          if (!active) return prev
          const tree = active.tree.clone()
          const focus = dockSourceLeavesIntoTree(
            tree,
            leaves,
            target,
            action,
          )
          return prev
            .filter(w => w.id !== sourceWindowId)
            .map(w =>
              w.id === activeId
                ? {
                    ...w,
                    tree,
                    focusedPaneId: focus,
                    zoomedPaneId: null,
                  }
                : w,
            )
        })
      },
    }
  }, [updateWindow, workspace])

  const switcherEntries = useMemo((): MuxSwitcherEntry[] => {
    const entries: MuxSwitcherEntry[] = []
    for (const w of windows) {
      for (const leaf of listPaneLeaves(w.tree)) {
        entries.push({
          windowId: w.id,
          windowTitle: w.title,
          paneId: leaf.ptyTabId,
          ptyTabId: leaf.ptyTabId,
          title: paneTitle(leaf.ptyTabId),
          panelId: leaf.panelId.id,
        })
      }
    }
    return entries
  }, [windows, paneTitle])

  const getCommandContext = useCallback(
    (): JetCommandContext => ({
      workspace,
      ui: {
        showMessage: () => {},
        showCommandPalette: () => setPaletteOpen(true),
        setCommandPaletteOpen: setPaletteOpen,
      },
      getActiveEditorView: () => null,
    }),
    [workspace],
  )

  const executeCommand = useCallback(
    async (name: string) => {
      await commands.execute(name, getCommandContext())
    },
    [commands, getCommandContext],
  )

  const openBrowserProjectTabRef = useRef(openBrowserProjectTab)
  openBrowserProjectTabRef.current = openBrowserProjectTab
  const closeWindowRef = useRef(closeWindow)
  closeWindowRef.current = closeWindow
  const closePaneRef = useRef(closePane)
  closePaneRef.current = closePane
  const openTerminalInActiveWindowRef = useRef(openTerminalInActiveWindow)
  openTerminalInActiveWindowRef.current = openTerminalInActiveWindow
  const surfaceRef = useRef(surface)
  surfaceRef.current = surface
  const openGitSplitRef = useRef(openGitSplit)
  openGitSplitRef.current = openGitSplit
  const openNeovimSplitRef = useRef(openNeovimSplit)
  openNeovimSplitRef.current = openNeovimSplit
  openEditorInFocusedRef.current = openInPreferredEditor
  const zoomPaneRef = useRef(zoomPane)
  zoomPaneRef.current = zoomPane
  const focusNeighborRef = useRef(focusNeighbor)
  focusNeighborRef.current = focusNeighbor
  const ensureProjectWindowRef = useRef(ensureProjectWindow)
  ensureProjectWindowRef.current = ensureProjectWindow
  const runExplorerActionRef = useRef(runExplorerAction)
  runExplorerActionRef.current = runExplorerAction
  const runToolPaneRef = useRef(runToolPane)
  runToolPaneRef.current = runToolPane
  const closeEditorTabRef = useRef(closeEditorTab)
  closeEditorTabRef.current = closeEditorTab

  const hasEditorDocument = useCallback(
    () => workspace.openBuffers.length > 0,
    [workspace],
  )

  const getActiveDocument = useCallback(async () => {
    const { getActiveMonacoEditor } = await import("@yaade/monaco")
    const editor = getActiveMonacoEditor()
    const model = editor?.getModel()
    const position = editor?.getPosition()
    if (model) {
      return {
        uri: model.uri.toString(),
        line: position?.lineNumber ?? 1,
        column: position?.column ?? 1,
      }
    }
    const uri = workspace.openBuffers[0]
    return uri ? { uri, line: 1, column: 1 } : null
  }, [workspace])

  const runActiveEditorAction = useCallback(async (actionId: string) => {
    const { getActiveMonacoEditor } = await import("@yaade/monaco")
    const editor = getActiveMonacoEditor()
    const action = editor?.getAction(actionId)
    if (!editor || !action) {
      showYaadeToast("Focus an editor before running this command", {
        variant: "warning",
      })
      return
    }
    editor.focus()
    await action.run()
  }, [])

  const saveActiveEditor = useCallback(async () => {
    const document = await getActiveDocument()
    if (!document) return
    const { editorBufferServiceFor } = await import(
      "../editor/editor-buffer-service.js"
    )
    const buffers = editorBufferServiceFor(workspace, sessionIdRef.current)
    try {
      await buffers.save(document.uri)
      showYaadeToast("File saved", { variant: "success" })
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "SAVE_AS_REQUIRED"
      ) {
        setSaveAsUri(document.uri)
        return
      }
      showYaadeToast(
        error instanceof Error ? error.message : "Could not save file",
        { variant: "destructive" },
      )
    }
  }, [getActiveDocument, workspace])

  const cycleEditorBuffer = useCallback(
    (delta: -1 | 1): void => {
      void getActiveDocument().then(current => {
        const buffers = workspace.openBuffers
        if (buffers.length < 2) return
        const index = current
          ? buffers.findIndex(uri => sameFileTab(uri, current.uri))
          : -1
        const target = buffers[(Math.max(index, 0) + delta + buffers.length) % buffers.length]
        if (target) openEditorInFocusedRef.current({ uri: target })
      })
    },
    [getActiveDocument, workspace],
  )

  const closeActiveEditor = useCallback((): void => {
    void getActiveDocument().then(document => {
      if (!document) return
      for (const live of windowsRef.current) {
        const panelId = live.tree.findEditorPanelForFile(document.uri)
        if (!panelId) continue
        void closeEditorTabRef.current(live.id, panelId, document.uri)
        return
      }
    })
  }, [getActiveDocument])

  const reopenClosedEditor = useCallback((): void => {
    const uri = closedEditorUrisRef.current.shift()
    if (!uri) {
      showYaadeToast("There is no recently closed buffer")
      return
    }
    openInPreferredEditor({ uri })
  }, [openInPreferredEditor])

  const openToolLocation = useCallback(
    (uri: string, line = 1, column = 1): void => {
      void getActiveDocument().then(current => {
        if (
          current &&
          (current.uri !== uri ||
            current.line !== line ||
            current.column !== column)
        ) {
          workspace.jumpStack.push({
            fileUri: current.uri,
            line: current.line,
            column: current.column,
          })
        }
        openInPreferredEditor({ uri, line, column })
      })
    },
    [getActiveDocument, openInPreferredEditor, workspace],
  )

  const navigateJumpHistory = useCallback(
    (direction: "back" | "forward"): void => {
      void getActiveDocument().then(current => {
        if (!current) return
        const entry =
          direction === "back"
            ? workspace.jumpStack.popBack({
                fileUri: current.uri,
                line: current.line,
                column: current.column,
              })
            : workspace.jumpStack.popForward({
                fileUri: current.uri,
                line: current.line,
                column: current.column,
              })
        if (!entry) {
          showYaadeToast(
            direction === "back"
              ? "No previous editor location"
              : "No next editor location",
          )
          return
        }
        openInPreferredEditor({
          uri: entry.fileUri,
          line: entry.line,
          column: entry.column,
        })
      })
    },
    [getActiveDocument, openInPreferredEditor, workspace],
  )

  const [terminalCheckoutOpen, setTerminalCheckoutOpen] = useState(false)
  const [terminalDefaultBranch, setTerminalDefaultBranch] = useState("main")

  useEffect(() => {
    let cancelled = false
    void window.yaade?.git
      ?.defaultBranch(pathToFileUri(sessionProjectPath))
      .then(branch => {
        if (!cancelled && branch?.trim()) setTerminalDefaultBranch(branch.trim())
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [sessionProjectPath])
  const [keymapRevision, setKeymapRevision] = useState(0)
  const [commandRevision, setCommandRevision] = useState(0)

  useEffect(() => {
    if (!layoutReady || !serverHydratedRef.current || !launchRequest) return
    if (!claimMuxLaunchRequest(handledLaunchIdsRef.current, launchRequest.id)) {
      // Module-level claim already taken (StrictMode remount). Clear the
      // request without relaunching so HQ intent cannot strand forever.
      onLaunchRequestHandled?.(launchRequest.id)
      return
    }

    void (async () => {
      let agentTabId: string | null = null
      let agentRunId: string | null = null
      try {
        const action = launchRequest.action
        if (action.kind === "agent") {
          const driver = AGENT_CLI_DRIVERS.find(item => item.id === action.driverId)
          if (!driver) throw new Error(`Unknown agent provider: ${action.driverId}`)
          const opened = await openAgentCliPane(driver, launchRequest.id, {
            checkoutPath: action.checkoutPath,
            checkoutKey: action.checkoutKey,
            checkoutLabel: action.checkoutLabel,
          })
          agentTabId = opened?.tabId ?? null
          agentRunId = opened?.runId ?? null
          if (!opened) {
            showYaadeToast("Could not open another terminal pane for that agent.")
          }
        } else if (action.kind === "terminal") {
          const rootUri = action.checkoutPath
            ? pathToFileUri(action.checkoutPath)
            : undefined
          await openTerminalInActiveWindow("right", rootUri ? { rootUri } : undefined)
        } else if (action.kind === "git") {
          const window = ensureProjectWindow()
          await openGitSplit(window.id, window.focusedPaneId)
        } else if (action.kind === "neovim") {
          const window = ensureProjectWindow()
          await openNeovimSplit(window.id, window.focusedPaneId)
        } else if (action.filePath) {
          openInPreferredEditor({
            filePath: action.filePath,
            line: action.line,
            forceNewGroup: true,
          })
        } else {
          openEditorInFocused({
            uri: `untitled:New File-${launchRequest.id}`,
            forceNewGroup: true,
          })
        }
      } catch (error) {
        showYaadeToast(
          error instanceof Error ? error.message : "Could not launch that tool.",
        )
      } finally {
        onLaunchRequestHandled?.(launchRequest.id, { agentTabId, agentRunId })
      }
    })()
  }, [
    ensureProjectWindow,
    launchRequest,
    layoutReady,
    onLaunchRequestHandled,
    openAgentCliPane,
    openEditorInFocused,
    openGitSplit,
    openInPreferredEditor,
    openNeovimSplit,
    openTerminalInActiveWindow,
  ])

  // Stable command registrations for overlays / mux actions.
  useEffect(() => {
    const run =
      (fn: () => void) =>
      async () => {
        fn()
      }

    const disposers = [
      commands.register(
        "layout.closeTab",
        run(() => {
          const w = windowsRef.current.find(
            x => x.id === activeWindowIdRef.current,
          )
          if (!w?.focusedPaneId) return
          const pty = listPaneLeaves(w.tree).find(
            p => p.panelId.id === w.focusedPaneId!.id,
          )
          if (pty) void closePaneRef.current(w.id, pty.panelId, pty.ptyTabId)
        }),
        { id: "layout.closeTab", title: "Close Pane", category: "Terminal" },
      ),
      commands.register(
        "mux.newWindow",
        run(() => openBrowserProjectTabRef.current()),
        {
          id: "mux.newWindow",
          title: "New Browser Tab",
          category: "Terminal",
        },
      ),
      commands.register(
        "terminal.new",
        run(() => {
          if (surfaceRef.current === "terminals") {
            setTerminalCheckoutOpen(true)
            return
          }
          void openTerminalInActiveWindowRef.current("right")
        }),
        { id: "terminal.new", title: "New Terminal Pane", category: "Terminal" },
      ),
      commands.register(
        "mux.closeWindow",
        run(() => {
          const id = activeWindowIdRef.current
          if (id) void closeWindowRef.current(id)
        }),
        {
          id: "mux.closeWindow",
          title: "Reset Window",
          category: "Terminal",
        },
      ),
      commands.register(
        "mux.splitRight",
        run(() => {
          void openTerminalInActiveWindowRef.current("right")
        }),
        { id: "mux.splitRight", title: "Split Right", category: "Terminal" },
      ),
      commands.register(
        "mux.splitDown",
        run(() => {
          void openTerminalInActiveWindowRef.current("bottom")
        }),
        { id: "mux.splitDown", title: "Split Down", category: "Terminal" },
      ),
      commands.register(
        "mux.openGit",
        run(() => {
          const w = ensureProjectWindowRef.current()
          void openGitSplitRef.current(w.id, w.focusedPaneId)
        }),
        {
          id: "mux.openGit",
          title: "Open Git",
          category: "View",
          aliases: ["git", "source control"],
        },
      ),
      commands.register(
        "dialog.showGit",
        run(() => {
          const w = ensureProjectWindowRef.current()
          void openGitSplitRef.current(w.id, w.focusedPaneId)
        }),
        {
          id: "dialog.showGit",
          title: "Show Git",
          category: "View",
          aliases: ["git", "source control"],
        },
      ),
      commands.register(
        "mux.openNeovim",
        run(() => {
          const w = ensureProjectWindowRef.current()
          void openNeovimSplitRef.current(w.id, w.focusedPaneId)
        }),
        {
          id: "mux.openNeovim",
          title: "Open Neovim",
          category: "View",
          aliases: ["nvim", "vim", "neovim"],
        },
      ),
      commands.register(
        "mux.openEditor",
        run(() => openInPreferredEditor()),
        {
          id: "mux.openEditor",
          title: "Open Editor",
          category: "View",
          aliases: ["editor", "monaco", "code", "nvim"],
        },
      ),
      commands.register(
        "editor.new",
        run(() => {
          const id =
            typeof crypto !== "undefined" &&
            typeof crypto.randomUUID === "function"
              ? crypto.randomUUID()
              : Date.now().toString(36)
          // Untitled buffers are Monaco-only (Neovim has no untitled model).
          openEditorInFocused({ uri: `untitled:Untitled-${id}` })
        }),
        {
          id: "editor.new",
          title: "New File",
          category: "File",
          aliases: ["new untitled buffer"],
        },
      ),
      commands.register(
        "editor.close",
        run(closeActiveEditor),
        {
          id: "editor.close",
          title: "Close Editor",
          category: "File",
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "editor.reopenClosed",
        run(reopenClosedEditor),
        {
          id: "editor.reopenClosed",
          title: "Reopen Closed Editor",
          category: "File",
          aliases: ["restore closed tab"],
          when: () => closedEditorUrisRef.current.length > 0,
        },
      ),
      commands.register(
        "editor.bufferNext",
        run(() => cycleEditorBuffer(1)),
        {
          id: "editor.bufferNext",
          title: "Next Buffer",
          category: "Navigation",
          when: () => workspace.openBuffers.length > 1,
        },
      ),
      commands.register(
        "editor.bufferPrevious",
        run(() => cycleEditorBuffer(-1)),
        {
          id: "editor.bufferPrevious",
          title: "Previous Buffer",
          category: "Navigation",
          when: () => workspace.openBuffers.length > 1,
        },
      ),
      commands.register(
        "editor.bufferSwitch",
        run(() => runToolPaneRef.current("buffers")),
        {
          id: "editor.bufferSwitch",
          title: "Switch Buffer",
          category: "Navigation",
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "editor.goToLine",
        run(() => {
          void runActiveEditorAction("editor.action.gotoLine")
        }),
        {
          id: "editor.goToLine",
          title: "Go to Line",
          category: "Navigation",
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "editor.action.revealDeclaration",
        run(() => {
          void runActiveEditorAction("editor.action.revealDeclaration")
        }),
        {
          id: "editor.action.revealDeclaration",
          title: "Go to Declaration",
          category: "Language",
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "editor.action.goToTypeDefinition",
        run(() => {
          void runActiveEditorAction("editor.action.goToTypeDefinition")
        }),
        {
          id: "editor.action.goToTypeDefinition",
          title: "Go to Type Definition",
          category: "Language",
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "editor.action.goToImplementation",
        run(() => {
          void runActiveEditorAction("editor.action.goToImplementation")
        }),
        {
          id: "editor.action.goToImplementation",
          title: "Go to Implementation",
          category: "Language",
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "editor.action.rename",
        run(() => {
          void runActiveEditorAction("editor.action.rename")
        }),
        {
          id: "editor.action.rename",
          title: "Rename Symbol",
          category: "Language",
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "editor.action.formatDocument",
        run(() => {
          void runActiveEditorAction("editor.action.formatDocument")
        }),
        {
          id: "editor.action.formatDocument",
          title: "Format Document",
          category: "Language",
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "editor.action.showHover",
        run(() => {
          void runActiveEditorAction("editor.action.showHover")
        }),
        {
          id: "editor.action.showHover",
          title: "Show Hover",
          category: "Language",
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "editor.action.triggerSuggest",
        run(() => {
          void runActiveEditorAction("editor.action.triggerSuggest")
        }),
        {
          id: "editor.action.triggerSuggest",
          title: "Trigger Suggestions",
          category: "Language",
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "explorer.focus",
        run(() => runExplorerActionRef.current("focus")),
        {
          id: "explorer.focus",
          title: "Focus Explorer",
          category: "Explorer",
          aliases: ["files", "file tree", "open explorer"],
        },
      ),
      commands.register(
        "explorer.createFile",
        run(() => runExplorerActionRef.current("createFile")),
        {
          id: "explorer.createFile",
          title: "Explorer: New File",
          category: "Explorer",
        },
      ),
      commands.register(
        "explorer.createFolder",
        run(() => runExplorerActionRef.current("createFolder")),
        {
          id: "explorer.createFolder",
          title: "Explorer: New Folder",
          category: "Explorer",
        },
      ),
      commands.register(
        "explorer.rename",
        run(() => runExplorerActionRef.current("rename")),
        {
          id: "explorer.rename",
          title: "Explorer: Rename",
          category: "Explorer",
        },
      ),
      commands.register(
        "explorer.trash",
        run(() => runExplorerActionRef.current("trash")),
        {
          id: "explorer.trash",
          title: "Explorer: Move to YAADE Trash",
          category: "Explorer",
        },
      ),
      commands.register(
        "explorer.restore",
        run(() => runExplorerActionRef.current("showTrash")),
        {
          id: "explorer.restore",
          title: "Explorer: Restore from YAADE Trash",
          category: "Explorer",
        },
      ),
      commands.register(
        "explorer.restoreAs",
        run(() => runExplorerActionRef.current("restoreAs")),
        {
          id: "explorer.restoreAs",
          title: "Explorer: Restore from Trash As…",
          category: "Explorer",
        },
      ),
      commands.register(
        "explorer.emptyTrash",
        run(() => runExplorerActionRef.current("emptyTrash")),
        {
          id: "explorer.emptyTrash",
          title: "Explorer: Empty YAADE Trash",
          category: "Explorer",
        },
      ),
      commands.register(
        "search.focus",
        run(() => runToolPaneRef.current("search")),
        {
          id: "search.focus",
          title: "Focus Search",
          category: "View",
          aliases: ["find in files", "project search", "grep"],
          when: () => workspace.manager.hasFolders(),
        },
      ),
      commands.register(
        "search.previewReplace",
        run(() => searchPreviewCommandRef.current()),
        {
          id: "search.previewReplace",
          title: "Search: Preview Replace",
          category: "Search",
          when: () => workspace.manager.hasFolders(),
        },
      ),
      commands.register(
        "search.applyReplace",
        async () => searchApplyCommandRef.current(),
        {
          id: "search.applyReplace",
          title: "Search: Apply Replace Preview",
          category: "Search",
          when: () => searchReplacePreviewRef.current != null,
        },
      ),
      commands.register(
        "search.undoLastReplace",
        async () => searchUndoCommandRef.current(),
        {
          id: "search.undoLastReplace",
          title: "Search: Undo Last Replace",
          category: "Search",
          when: () => workspace.manager.hasFolders(),
        },
      ),
      commands.register(
        "problems.focus",
        run(() => runToolPaneRef.current("problems")),
        {
          id: "problems.focus",
          title: "Focus Problems",
          category: "View",
          aliases: ["diagnostics", "errors", "warnings"],
          when: () => workspace.manager.hasFolders(),
        },
      ),
      commands.register(
        "references.focus",
        run(() => runToolPaneRef.current("references")),
        {
          id: "references.focus",
          title: "Find References",
          category: "Language",
          aliases: ["usages", "references view"],
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "definitions.focus",
        run(() => runToolPaneRef.current("definitions")),
        {
          id: "definitions.focus",
          title: "Show Definitions",
          category: "Language",
          aliases: ["go to definition", "definitions view"],
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "outline.focus",
        run(() => runToolPaneRef.current("outline")),
        {
          id: "outline.focus",
          title: "Focus Document Outline",
          category: "View",
          aliases: ["document symbols"],
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "buffers.focus",
        run(() => runToolPaneRef.current("buffers")),
        {
          id: "buffers.focus",
          title: "Focus Open Buffers",
          category: "View",
          aliases: ["switch buffer", "open editors", "mru"],
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "workspaceSymbols.focus",
        run(() => runToolPaneRef.current("workspaceSymbols")),
        {
          id: "workspaceSymbols.focus",
          title: "Search Workspace Symbols",
          category: "Language",
          aliases: ["symbols", "workspace symbol"],
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "callHierarchy.focus",
        run(() => runToolPaneRef.current("callHierarchy")),
        {
          id: "callHierarchy.focus",
          title: "Show Call Hierarchy",
          category: "Language",
          aliases: ["incoming calls", "outgoing calls"],
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "typeHierarchy.focus",
        run(() => runToolPaneRef.current("typeHierarchy")),
        {
          id: "typeHierarchy.focus",
          title: "Show Type Hierarchy",
          category: "Language",
          aliases: ["supertypes", "subtypes"],
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "lsp.output.focus",
        run(() => runToolPaneRef.current("lspOutput")),
        {
          id: "lsp.output.focus",
          title: "Focus Language Server Output",
          category: "Language",
          aliases: ["lsp logs", "language server logs"],
          when: () => window.yaade?.lsp != null,
        },
      ),
      commands.register(
        "editor.action.goToReferences",
        run(() => runToolPaneRef.current("references")),
        {
          id: "editor.action.goToReferences",
          title: "Go to References",
          category: "Language",
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "editor.action.revealDefinition",
        run(() => runToolPaneRef.current("definitions")),
        {
          id: "editor.action.revealDefinition",
          title: "Go to Definition",
          category: "Language",
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "editor.navigateBack",
        run(() => navigateJumpHistory("back")),
        {
          id: "editor.navigateBack",
          title: "Go Back",
          category: "Navigation",
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "editor.navigateForward",
        run(() => navigateJumpHistory("forward")),
        {
          id: "editor.navigateForward",
          title: "Go Forward",
          category: "Navigation",
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "lsp.restart",
        async () => {
          const document = await getActiveDocument()
          const controller = lspControllerRef.current
          if (!document || !controller) return
          await controller.restart(document.uri)
          showYaadeToast("Language server restarted")
        },
        {
          id: "lsp.restart",
          title: "Restart Language Server",
          category: "Language",
          when: hasEditorDocument,
        },
      ),
      commands.register(
        "lsp.status",
        run(() => {
          const status = lspControllerRef.current?.status() ?? "idle"
          showYaadeToast(`Language server: ${status}`)
        }),
        {
          id: "lsp.status",
          title: "Show Language Server Status",
          category: "Language",
          when: () => window.yaade?.lsp != null,
        },
      ),
      commands.register(
        "editor.quickOpen",
        run(() => setQuickOpenOpen(true)),
        {
          id: "editor.quickOpen",
          title: "Quick Open File",
          category: "View",
          aliases: ["open file", "find file"],
        },
      ),
      commands.register(
        "editor.projectSearch",
        run(() => setProjectSearchOpen(true)),
        {
          id: "editor.projectSearch",
          title: "Search in Files",
          category: "View",
          aliases: ["grep", "find in files", "project search"],
        },
      ),
      commands.register(
        "editor.save",
        saveActiveEditor,
        { id: "editor.save", title: "Save File", category: "File" },
      ),
      commands.register(
        "editor.saveAs",
        run(() => {
          const live = windowsRef.current.find(
            item => item.id === activeWindowIdRef.current,
          )
          const focused = live?.focusedPaneId
          if (!live || !focused) return
          const view = live.tree.getView(focused)
          const uri = view?.kind === "tabs" ? view.activeTabId : null
          if (uri && isEditorTabId(uri)) setSaveAsUri(uri)
        }),
        { id: "editor.saveAs", title: "Save As…", category: "File" },
      ),
      commands.register(
        "editor.saveAll",
        async () => {
          const { editorBufferServiceFor } = await import(
            "../editor/editor-buffer-service.js"
          )
          const buffers = editorBufferServiceFor(
            workspace,
            sessionIdRef.current,
          )
          try {
            await buffers.saveAll()
            showYaadeToast("All files saved", { variant: "success" })
          } catch (error) {
            showYaadeToast(
              error instanceof Error ? error.message : "Could not save all files",
              { variant: "destructive" },
            )
          }
        },
        { id: "editor.saveAll", title: "Save All Files", category: "File" },
      ),
      commands.register(
        "lsp.enableForCurrentFile",
        async () => {
          const live = windowsRef.current.find(
            item => item.id === activeWindowIdRef.current,
          )
          const focused = live?.focusedPaneId
          if (!live || !focused) return
          const view = live.tree.getView(focused)
          const uri = view?.kind === "tabs" ? view.activeTabId : null
          if (!uri || !isEditorTabId(uri)) return
          const { editorBufferServiceFor } = await import(
            "../editor/editor-buffer-service.js"
          )
          if (
            editorBufferServiceFor(
              workspace,
              sessionIdRef.current,
            ).enableLsp(uri)
          ) {
            showYaadeToast("Language features enabled for this large file.")
          }
        },
        {
          id: "lsp.enableForCurrentFile",
          title: "Enable Language Features for Current File",
          category: "Language",
          aliases: ["large file", "lsp"],
        },
      ),
      commands.register(
        "mux.closePane",
        run(() => {
          const w = windowsRef.current.find(
            x => x.id === activeWindowIdRef.current,
          )
          if (!w?.focusedPaneId) return
          const pty = listPaneLeaves(w.tree).find(
            p => p.panelId.id === w.focusedPaneId!.id,
          )
          if (pty) void closePaneRef.current(w.id, pty.panelId, pty.ptyTabId)
        }),
        { id: "mux.closePane", title: "Close Pane", category: "Terminal" },
      ),
      commands.register(
        "mux.focusLeft",
        run(() => focusNeighborRef.current("left")),
        { id: "mux.focusLeft", title: "Focus Pane Left", category: "Terminal" },
      ),
      commands.register(
        "mux.focusRight",
        run(() => focusNeighborRef.current("right")),
        {
          id: "mux.focusRight",
          title: "Focus Pane Right",
          category: "Terminal",
        },
      ),
      commands.register(
        "mux.focusUp",
        run(() => focusNeighborRef.current("up")),
        { id: "mux.focusUp", title: "Focus Pane Up", category: "Terminal" },
      ),
      commands.register(
        "mux.focusDown",
        run(() => focusNeighborRef.current("down")),
        { id: "mux.focusDown", title: "Focus Pane Down", category: "Terminal" },
      ),
      commands.register(
        "mux.zoomPane",
        run(() => {
          const w = windowsRef.current.find(
            x => x.id === activeWindowIdRef.current,
          )
          if (!w?.focusedPaneId) return
          const pty = listPaneLeaves(w.tree).find(
            p => p.panelId.id === w.focusedPaneId!.id,
          )
          if (pty) zoomPaneRef.current(w.id, pty.ptyTabId)
        }),
        { id: "mux.zoomPane", title: "Zoom Pane", category: "Terminal" },
      ),
      commands.register(
        "terminal.list",
        run(() => setTerminalListOpen(true)),
        { id: "terminal.list", title: "Switch Terminal", category: "Terminal" },
      ),
      commands.register(
        "ui.showThemePicker",
        run(() => setSettingsOpen(true)),
        {
          id: "ui.showThemePicker",
          title: "Theme Picker",
          category: "View",
        },
      ),
      commands.register(
        "ui.showCommandPalette",
        run(() => setPaletteOpen(true)),
        {
          id: "ui.showCommandPalette",
          title: "Command Palette",
          category: "View",
        },
      ),
      commands.register(
        "settings.show",
        run(() => setSettingsOpen(true)),
        { id: "settings.show", title: "Settings", category: "View" },
      ),
      commands.register(
        "workspace.cd",
        run(() => setCdOpen(true)),
        { id: "workspace.cd", title: "Change Directory", category: "Terminal" },
      ),
      commands.register(
        "ui.zoomIn",
        run(() => handleZoom(1)),
        { id: "ui.zoomIn", title: "Zoom In", category: "View" },
      ),
      commands.register(
        "ui.zoomOut",
        run(() => handleZoom(-1)),
        { id: "ui.zoomOut", title: "Zoom Out", category: "View" },
      ),
      commands.register(
        "ui.resetAppearance",
        run(() => resetAppearanceSettings()),
        {
          id: "ui.resetAppearance",
          title: "Reset Appearance",
          category: "UI",
          aliases: ["reset theme", "reset font"],
        },
      ),
      ...bundledThemeList.map(theme =>
        commands.register(
          `ui.setTheme.${theme.id}`,
          run(() => {
            setThemeId(theme.id)
            showYaadeToast(`Theme: ${theme.name}`)
          }),
          {
            id: `ui.setTheme.${theme.id}`,
            title: `Theme: ${theme.name}`,
            category: "UI",
            aliases: [theme.family ?? "", theme.scheme ?? "", "theme"].filter(
              Boolean,
            ),
          },
        ),
      ),
    ]
    setCommandRevision(r => r + 1)
    return () => {
      for (const d of disposers) d.dispose()
    }
  }, [
    closeActiveEditor,
    commands,
    cycleEditorBuffer,
    getActiveDocument,
    handleZoom,
    hasEditorDocument,
    navigateJumpHistory,
    embedded,
    onLaunchAgent,
    onSelectAgentTab,
    openEditorInFocused,
    openInPreferredEditor,
    reopenClosedEditor,
    resetAppearanceSettings,
    runActiveEditorAction,
    saveActiveEditor,
    setThemeId,
    workspace,
  ])

  // Subscribe before registerUser — otherwise the initial onDidChange is missed and
  // keymapBindings stays stuck on the empty first-render snapshot.
  useEffect(() => {
    const sub = keymaps.onDidChange.event(() => setKeymapRevision(r => r + 1))
    return () => sub.dispose()
  }, [keymaps])

  /** tmux send-prefix: press the prefix twice to pass it through to the shell. */
  const sendPrefixLiteral = useCallback(() => {
    const byte = prefixLiteralByte(MUX_PREFIX)
    if (!byte) return
    const tabId = focusedPtyTabIdRef.current
    if (!tabId) return
    const ptyId = terminalPtyIdForTab(tabId)
    const terminal =
      typeof window !== "undefined" ? window.yaade?.terminal : undefined
    if (!ptyId || !terminal) return
    void terminal.write(ptyId, byte)
  }, [])

  useEffect(() => {
    const noOverlay = (ctx: KeymapContext) => !anyOverlayOpen(ctx)
    keymaps.registerUser([
      ...MUX_DIRECT_BINDINGS.map(b =>
        bind(
          b.key,
          () => {
            void executeCommand(b.command)
          },
          noOverlay,
        ),
      ),
      ...MUX_PREFIX_BINDINGS.map(b =>
        bind(
          muxPrefixBindingKey(b.key),
          () => {
            void executeCommand(b.command)
          },
          noOverlay,
        ),
      ),
      bind(muxPrefixBindingKey(MUX_PREFIX), () => sendPrefixLiteral(), noOverlay),
      // Escape belongs to the terminal — vim, less and fzf all need it. Claim
      // it only to restore a zoomed pane while focus sits outside the PTY.
      bind(
        "Escape",
        () => {
          unzoomIfNeeded()
        },
        ctx =>
          noOverlay(ctx) &&
          windowsRef.current.find(w => w.id === activeWindowIdRef.current)
            ?.zoomedPaneId != null &&
          !(
            typeof document !== "undefined" &&
            document.activeElement instanceof Element &&
            document.activeElement.closest(".xterm") != null
          ),
      ),
    ])
  }, [executeCommand, keymaps, sendPrefixLiteral, unzoomIfNeeded])

  const whichKeyEntries = useMemo<WhichKeyEntry[]>(
    () =>
      MUX_PREFIX_BINDINGS.map(b => ({
        key: formatKeyBinding(b.key),
        desc: b.desc,
      })),
    [],
  )

  /** Display shortcut for a command id from the mux prefix binding table. */
  const shortcutFor = useCallback((commandId: string): string | undefined => {
    const binding = MUX_PREFIX_BINDINGS.find(b => b.command === commandId)
    if (!binding) return undefined
    return formatKeyBinding(muxPrefixBindingKey(binding.key))
  }, [])

  const statusStripActions = useMemo<MuxStatusStripAction[]>(
    () => [
      {
        id: "terminal.new",
        label: "New",
        icon: "new",
        shortcut: shortcutFor("terminal.new"),
        onClick: () => void executeCommand("terminal.new"),
      },
      {
        id: "ui.showCommandPalette",
        label: "Palette",
        icon: "palette",
        shortcut: shortcutFor("ui.showCommandPalette"),
        onClick: () => void executeCommand("ui.showCommandPalette"),
      },
      {
        id: "search.focus",
        label: "Search",
        icon: "search",
        shortcut: shortcutFor("search.focus"),
        onClick: () => void executeCommand("search.focus"),
      },
      {
        id: "workspace.cd",
        label: "Directory",
        icon: "cd",
        shortcut: shortcutFor("workspace.cd"),
        onClick: () => void executeCommand("workspace.cd"),
      },
      {
        id: "settings.show",
        label: "Settings",
        icon: "settings",
        shortcut: shortcutFor("settings.show"),
        onClick: () => void executeCommand("settings.show"),
      },
    ],
    [executeCommand, shortcutFor],
  )

  const keymapBindings = useMemo(
    () => keymaps.allBindings(),
    [keymaps, keymapRevision],
  )

  const keymapContext: KeymapContext = useMemo(() => {
    const focusedLeaf = (() => {
      if (!activeWindow?.focusedPaneId) return null
      return listPaneLeaves(activeWindow.tree).find(
        l => l.panelId.id === activeWindow.focusedPaneId!.id,
      ) ?? null
    })()
    const focusedKind: MuxLeafKind | null = focusedLeaf?.kind ?? null
    return {
      ...EMPTY_KEYMAP_OVERLAYS,
      // Editor overlays share the quick-open gate so the global listener bails.
      quickOpenOpen: quickOpenOpen || projectSearchOpen,
      editorFocus: focusedKind === "editor",
      paletteOpen,
      cdOpen,
      terminalListOpen,
      settingsOpen,
      workspaceOpen: workspace.manager.hasFolders(),
      terminalFocus: focusedKind === "terminal",
    }
  }, [
    activeWindow,
    cdOpen,
    paletteOpen,
    projectSearchOpen,
    quickOpenOpen,
    settingsOpen,
    terminalListOpen,
    workspace,
  ])

  useGlobalKeymap({
    keymapBindings,
    getKeyBindings: () => keymaps.allBindings(),
    keymapContext,
    workspace,
    getFocusedPanel: () => activeWindow?.focusedPaneId ?? null,
    getEditorPanel: () => null,
    executeCommand,
    runKeyBinding: (binding: JetKeyBinding) => {
      void binding.run(getCommandContext())
    },
    setPendingChordPrefix,
  })

  useEffect(() => {
    window.__yaadeAgent = createAgentBridge(() => ({
      workspace,
      commands,
      panelTree: activeWindow?.tree ?? emptyMuxTree(),
      focusedPanel: activeWindow?.focusedPaneId ?? null,
      paletteOpen,
      message: null,
      layoutReady,
      fontSize,
      executeCommand,
      openWorkspace,
      addWorkspace: openWorkspace,
      listWorkspaces: () =>
        workspace.folders.map(folder => ({
          id: folder.id,
          path: folder.root.path,
          name: folder.root.name,
        })),
      setFontSize,
      openFile: (uri, _path, options) => {
        openEditorInFocusedRef.current({
          uri,
          forceNewGroup: options?.forceNewGroup,
        })
      },
      sessionMode: "terminal",
      sessionLayout: "sidebar",
      route: "session",
      sessionId,
      sessionCwd: sessionCwdPath,
      backToProject: onBackToProject,
      openEditorBuffers: Object.keys(editorFiles),
      activeEditorDirty: (() => {
        const focused = activeWindow?.focusedPaneId
        if (!focused) return false
        const view = activeWindow.tree.getView(focused)
        const tabId = view?.kind === "tabs" ? view.activeTabId : null
        return tabId ? editorIsDirty(tabId) : false
      })(),
    }))
    return () => {
      delete window.__yaadeAgent
    }
  }, [
    activeWindow,
    commands,
    executeCommand,
    editorFiles,
    editorIsDirty,
    fontSize,
    layoutReady,
    onBackToProject,
    openWorkspace,
    paletteOpen,
    sessionCwdPath,
    sessionId,
    setFontSize,
    workspace,
  ])

  const workspaceSurfaceRef = useRef<HTMLDivElement>(null)
  const dockSurfaceRef = useRef<HTMLDivElement>(null)
  const activeLeaves = useMemo(
    () => (activeWindow ? listPaneLeaves(activeWindow.tree) : []),
    [activeWindow],
  )
  const terminalSurfaceTree = useMemo(() => {
    if (surface !== "terminals" || !activeWindow) return null
    return buildTerminalOnlyDisplayTree(
      activeWindow.tree,
      tabId => !terminalSessionForTab(tabId)?.agentId,
    )
  }, [activeWindow, surface, terminalSessionsRevision])
  const terminalSurfaceLeaves = useMemo(
    () => (terminalSurfaceTree ? listTerminalLeaves(terminalSurfaceTree) : []),
    [terminalSurfaceTree],
  )
  const terminalSurfacePtyIds = useMemo(
    () => terminalSurfaceLeaves.map(leaf => leaf.ptyTabId),
    [terminalSurfaceLeaves],
  )
  const activePtyIds = useMemo(
    () =>
      activeLeaves
        .filter(l => l.kind === "terminal")
        .map(l => l.ptyTabId),
    [activeLeaves],
  )
  const allPtyIds = useMemo(() => {
    const ids: string[] = []
    const seen = new Set<string>()
    for (const w of windows) {
      for (const leaf of listTerminalLeaves(w.tree)) {
        if (seen.has(leaf.ptyTabId)) continue
        seen.add(leaf.ptyTabId)
        ids.push(leaf.ptyTabId)
      }
    }
    return ids
  }, [windows])
  const layoutEpoch = useMemo(() => {
    if (!activeWindow) return "0"
    const leaves = listPaneLeaves(activeWindow.tree)
      .map(l => `${l.panelId.id}:${l.ptyTabId}:${l.kind}`)
      .join("|")
    return `${leaves}#${activeWindow.zoomedPaneId ?? ""}`
  }, [activeWindow])

  const focusedLeaf = useMemo(() => {
    if (!activeWindow?.focusedPaneId) return null
    return (
      activeLeaves.find(l => l.panelId.id === activeWindow.focusedPaneId!.id) ??
      null
    )
  }, [activeWindow, activeLeaves])
  const focusedPtyTabId = useMemo(() => {
    if (surface === "agents" && focusAgentTabId) return focusAgentTabId
    if (surface === "terminals") {
      return (
        terminalSurfaceLeaves.find(
          leaf => leaf.panelId.id === activeWindow?.focusedPaneId?.id,
        )?.ptyTabId ??
        terminalSurfaceLeaves[0]?.ptyTabId ??
        null
      )
    }
    return focusedLeaf?.kind === "terminal" ? focusedLeaf.ptyTabId : null
  }, [activeWindow?.focusedPaneId, focusAgentTabId, focusedLeaf, surface, terminalSurfaceLeaves])
  focusedPtyTabIdRef.current = focusedPtyTabId

  const surfaceEditorBuffers = useMemo((): ModalEditorBuffer[] => {
    if (!activeWindow) return []
    const tabIds = listEditorBufferTabIds(activeWindow.tree)
    return tabIds.map(tabId => ({
      tabId,
      label:
        workspace.tabRegistry.get(tabId)?.label ?? editorLabelFromUri(tabId),
      dirty: editorIsDirty(tabId),
    }))
  }, [activeWindow, editorIsDirty, layoutEpoch, workspace.tabRegistry])

  const [editorsActiveTabId, setEditorsActiveTabId] = useState<string | null>(
    null,
  )
  useEffect(() => {
    if (surface !== "editors") return
    if (
      editorsActiveTabId &&
      surfaceEditorBuffers.some(b => b.tabId === editorsActiveTabId)
    ) {
      return
    }
    setEditorsActiveTabId(surfaceEditorBuffers[0]?.tabId ?? null)
  }, [editorsActiveTabId, surface, surfaceEditorBuffers])

  const agentInstanceTabIds = useMemo(
    () =>
      allPtyIds.filter(id => Boolean(terminalSessionForTab(id)?.agentId)),
    [allPtyIds, terminalSessionsRevision],
  )
  const agentSidebarItems = useMemo((): InstanceSidebarItem[] => {
    return agentInstanceTabIds.map(id => {
      const session = terminalSessionForTab(id)
      const worktree = checkoutLabelFromUri(
        sessionProjectPath,
        session?.cwdRootUri ?? null,
      )
      return {
        id,
        label: session?.agentTitle || paneTitle(id),
        subtitle: worktree,
        icon: <Bot className="size-3.5 shrink-0 text-muted-foreground" />,
      }
    })
  }, [agentInstanceTabIds, paneTitle, sessionProjectPath, terminalSessionsRevision])
  const terminalSidebarItems = useMemo((): InstanceSidebarItem[] => {
    return terminalSurfaceLeaves.map(leaf => {
      const session = terminalSessionForTab(leaf.ptyTabId)
      const worktree = checkoutLabelFromUri(
        sessionProjectPath,
        session?.cwdRootUri ?? null,
      )
      return {
        id: leaf.ptyTabId,
        label: paneTitle(leaf.ptyTabId),
        subtitle: worktree,
        icon: (
          <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" />
        ),
      }
    })
  }, [
    paneTitle,
    sessionProjectPath,
    terminalSessionsRevision,
    terminalSurfaceLeaves,
  ])

  const paneBoxes = useMuxPaneBoxes(
    workspaceSurfaceRef,
    dockSurfaceRef,
    surface === "agents" || surface === "editors" || surface === "terminals"
      ? []
      : activeWindow?.zoomedPaneId
        ? [activeWindow.zoomedPaneId]
        : activeLeaves.map(leaf => leaf.ptyTabId),
    layoutEpoch,
  )
  paneBoxesRef.current = paneBoxes

  const slotMeasureIds = useMemo(() => {
    if (surface === "agents") {
      return focusAgentTabId ? [focusAgentTabId] : []
    }
    if (surface === "editors") return []
    if (surface === "terminals") {
      return focusedPtyTabId ? [focusedPtyTabId] : []
    }
    return activeWindow?.zoomedPaneId
      ? isTerminalTabId(activeWindow.zoomedPaneId)
        ? [activeWindow.zoomedPaneId]
        : []
      : activePtyIds
  }, [
    activePtyIds,
    activeWindow?.zoomedPaneId,
    focusAgentTabId,
    focusedPtyTabId,
    surface,
  ])

  const slotBoxes = useMuxTerminalSlotBoxes(
    workspaceSurfaceRef,
    dockSurfaceRef,
    slotMeasureIds,
    `${layoutEpoch}:${surface ?? "full"}:${focusAgentTabId ?? ""}`,
  )

  // Touch LRU when focus changes so background windows stay warm briefly.
  useEffect(() => {
    if (!focusedPtyTabId) return
    const lru = terminalLruRef.current.filter(id => id !== focusedPtyTabId)
    lru.unshift(focusedPtyTabId)
    terminalLruRef.current = lru.slice(0, MAX_TERMINAL_PANES_PER_WORKSPACE)
  }, [focusedPtyTabId])

  const mountedPtyIds = useMemo(() => {
    const active = new Set(activePtyIds)
    const out: string[] = [...activePtyIds]
    for (const id of terminalLruRef.current) {
      if (active.has(id)) continue
      if (out.length >= MAX_TERMINAL_PANES_PER_WORKSPACE) break
      if (allPtyIds.includes(id)) {
        out.push(id)
        active.add(id)
      }
    }
    return out
  }, [activePtyIds, allPtyIds, focusedPtyTabId])

  // Poll foreground process for focused terminal + mounted agent panes.
  useEffect(() => {
    let cancelled = false
    const pollIds = (): string[] => {
      const ids = new Set<string>()
      if (focusedPtyTabId) ids.add(focusedPtyTabId)
      for (const id of mountedPtyIds) {
        if (terminalSessionForTab(id)?.agentId) ids.add(id)
      }
      return [...ids]
    }
    const tick = () => {
      if (cancelled) return
      for (const id of pollIds()) {
        void refreshForegroundProcess(id)
      }
    }
    tick()
    const handle = window.setInterval(tick, 2_000)
    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
  }, [mountedPtyIds, focusedPtyTabId, refreshForegroundProcess])

  const overlayBlocksTerminalFocus =
    paletteOpen ||
    terminalListOpen ||
    settingsOpen ||
    cdOpen ||
    quickOpenOpen ||
    projectSearchOpen

  const renderTerminal = useCallback(
    (ptyTabId: string, focused: boolean, slotVisible: boolean): ReactNode => {
      const session = terminalSessionForTab(ptyTabId)
      const termFocused = focused && !overlayBlocksTerminalFocus
      const host = (
        <Suspense fallback={null}>
          <TerminalPanel
            cwdRootUri={session?.cwdRootUri ?? cwdUri()}
            launchCommand={session?.launchCommand}
            launchArgs={session?.launchArgs}
            launchEnv={session?.launchEnv}
            theme={activeTheme as YaadeTheme}
            tabId={ptyTabId}
            focused={termFocused}
            isActive={termFocused}
            existingPtyId={session?.ptyId}
            status={session?.status}
            exitCode={session?.exitCode}
            sessionGeneration={session?.generation}
            onPtyId={(tabId, ptyId) => {
              trackTerminalPtyId(tabId, ptyId)
              const agentSession = terminalSessionForTab(tabId)
              const provider = agentSession?.agentId as AgentProvider | undefined
              if (
                ptyId &&
                (provider === "claude" ||
                  provider === "codex" ||
                  provider === "cursor" ||
                  provider === "opencode" ||
                  provider === "grok")
              ) {
                void window.yaade?.notifications?.bindSession({
                  sessionId: tabId,
                  projectId,
                  projectName,
                  sessionTitle: agentSession?.agentTitle ?? sessionTitle,
                  provider,
                  ptyId,
                })
                // HQ live-agents indexes SQLite leaves by ptyId. Flush past the
                // debounce so navigating back to HQ immediately after launch
                // still sees the running agent.
                persist()
                void persistWriterRef.current.flush()
              } else {
                // Persist promptly so reload can reattach this PTY id.
                persist()
              }
            }}
            onInput={recordTerminalUserInput}
            onOutput={recordTerminalOutput}
            onTitleChange={(id, title) => {
              const prevLabel = workspace.tabRegistry.get(id)?.label
              if (prevLabel !== title) {
                workspace.tabRegistry.update(id, { label: title })
              }
              const fromTitle = cwdUriFromTerminalTitle(
                title,
                homeDirRef.current || "",
              )
              if (fromTitle) updateTerminalLiveCwd(id, fromTitle)
              void refreshForegroundProcess(id)
              // Only re-render mux chrome when the visible title actually changes.
              if (prevLabel !== title) bumpSessions()
              const winId = activeWindowIdRef.current
              if (!winId) return
              updateWindow(winId, w => {
                const leaves = listPaneLeaves(w.tree)
                if (leaves.length !== 1 || leaves[0]?.ptyTabId !== id) return w
                const nextTitle = paneTitle(id)
                if (w.title === nextTitle) return w
                return { ...w, title: nextTitle }
              })
            }}
            visible={slotVisible}
            onFailed={() => markTerminalFailed(ptyTabId)}
            onRestart={() => {
              const ptyId = terminalPtyIdForTab(ptyTabId)
              if (ptyId) void window.yaade?.terminal?.dispose(ptyId)
              restartTerminalSession(ptyTabId)
            }}
            onExit={() => {
              const session = terminalSessionForTab(ptyTabId)
              if (!isNeovimLaunchCommand(session?.launchCommand)) return
              const w = windowsRef.current.find(x =>
                listPaneLeaves(x.tree).some(p => p.ptyTabId === ptyTabId),
              )
              if (!w) return
              const leaf = listPaneLeaves(w.tree).find(
                p => p.ptyTabId === ptyTabId,
              )
              if (leaf) {
                void closePane(w.id, leaf.panelId, ptyTabId, {
                  skipConfirm: true,
                })
              }
            }}
            onClose={() => {
              const w = windowsRef.current.find(
                x => x.id === activeWindowIdRef.current,
              )
              if (!w) return
              const leaf = listPaneLeaves(w.tree).find(
                p => p.ptyTabId === ptyTabId,
              )
              if (leaf) void closePane(w.id, leaf.panelId, ptyTabId)
            }}
          />
        </Suspense>
      )

      const live = windowsRef.current.find(w =>
        listPaneLeaves(w.tree).some(l => l.ptyTabId === ptyTabId),
      )
      const leaf = live
        ? listPaneLeaves(live.tree).find(l => l.ptyTabId === ptyTabId)
        : null
      if (!live || !leaf) return host

      const canZoom = listPaneLeaves(live.tree).length > 1
      const zoomed = live.zoomedPaneId === ptyTabId

      return (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="h-full min-h-0 w-full">{host}</div>
          </ContextMenuTrigger>
          <ContextMenuContent data-yaade-mux-terminal-context-menu="">
            <ContextMenuItem
              onSelect={() => void splitPane(live.id, leaf.panelId, "right")}
            >
              Split Right
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => void splitPane(live.id, leaf.panelId, "bottom")}
            >
              Split Down
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => void openGitSplit(live.id, leaf.panelId)}
            >
              Open Git
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => void openNeovimSplit(live.id, leaf.panelId)}
            >
              Open Neovim
            </ContextMenuItem>
            {canZoom ? (
              <ContextMenuItem
                onSelect={() => zoomPane(live.id, ptyTabId)}
              >
                {zoomed ? "Restore Pane" : "Zoom Pane"}
              </ContextMenuItem>
            ) : null}
            <ContextMenuItem onSelect={() => openBrowserProjectTab()}>
              New Browser Tab
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              onSelect={() => void closePane(live.id, leaf.panelId, ptyTabId)}
            >
              Close Pane
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )
    },
    [
      activeTheme,
      closePane,
      cwdUri,
      openBrowserProjectTab,
      openGitSplit,
      openNeovimSplit,
      overlayBlocksTerminalFocus,
      paneTitle,
      persist,
      refreshForegroundProcess,
      splitPane,
      updateWindow,
      workspace,
      zoomPane,
    ],
  )

  const handleLspReady = useCallback(
    (lifecycle: MuxLspController | null) => {
      lspControllerRef.current = lifecycle
      void import("../editor/editor-buffer-service.js").then(
        ({ editorBufferServiceFor }) => {
          editorBufferServiceFor(
            workspace,
            sessionIdRef.current,
          ).setLspHooks(
            lifecycle
              ? {
                  open: lifecycle.open,
                  close: lifecycle.close,
                  save: lifecycle.save,
                }
              : null,
          )
        },
      )
    },
    [workspace],
  )

  const completeSaveAs = useCallback(
    async (targetPath: string) => {
      const sourceUri = saveAsUri
      if (!sourceUri) return
      const targetUri = canonicalizeFileUri(pathToFileUri(targetPath))
      try {
        const { editorBufferServiceFor } = await import(
          "../editor/editor-buffer-service.js"
        )
        const buffers = editorBufferServiceFor(workspace, sessionId)
        await buffers.saveAs(sourceUri, targetUri)
        // The editor is still mounted on the source URI here. Capture its
        // latest cursor/folds/scroll synchronously before the React tree swaps
        // to the promoted URI, then move that snapshot with the buffer.
        window.dispatchEvent(new Event("yaade:save-editor-view-state"))
        remapEditorViewStateUri(sessionId, sourceUri, targetUri)

        setEditorFiles(previous => {
          const source = previous[sourceUri] ?? { uri: sourceUri }
          const next = { ...previous }
          delete next[sourceUri]
          next[targetUri] = { ...source, uri: targetUri }
          editorFilesRef.current = next
          return next
        })
        setWindows(previous => {
          const next = previous.map(item => ({
            ...item,
            tree: remapEditorTabUri(item.tree, sourceUri, targetUri),
            zoomedPaneId:
              item.zoomedPaneId === sourceUri
                ? targetUri
                : item.zoomedPaneId,
          }))
          windowsRef.current = next
          return next
        })
        workspace.disposeTab(sourceUri)
        workspace.registerTab({
          id: targetUri,
          kind: "editor",
          label: editorLabelFromUri(targetUri),
        })
        setSaveAsUri(null)
        showYaadeToast(`Saved ${editorLabelFromUri(targetUri)}`, {
          variant: "success",
        })
      } catch (error) {
        showYaadeToast(
          error instanceof Error ? error.message : "Could not save the file",
          { variant: "destructive" },
        )
      }
    },
    [saveAsUri, sessionId, workspace],
  )

  const renderEditor = useCallback(
    (tabId: string, panelId: PanelId, focused: boolean): ReactNode => {
      const file =
        editorFiles[tabId] ??
        (isFileEditorTabId(tabId) ? { uri: tabId } : null)
      if (!file) return null
      return (
        <Suspense
          fallback={
            <div className="min-h-0 flex-1 animate-pulse bg-background/10" />
          }
        >
          <MuxEditorPane
            uri={file.uri}
            line={file.line}
            column={file.column}
            theme={activeTheme as YaadeTheme}
            workspace={workspace}
            sessionId={sessionId}
            focused={focused}
            viewStateId={`mux-editor-${panelId.id}`}
            onQuickOpen={() => setQuickOpenOpen(true)}
            onCommandPalette={() => setPaletteOpen(true)}
            onViewStatePersist={persist}
            onSaveAsRequired={setSaveAsUri}
          />
        </Suspense>
      )
    },
    [activeTheme, editorFiles, persist, sessionId, workspace],
  )

  const handleExplorerControllerReady = useCallback(
    (controller: MuxExplorerController | null) => {
      explorerControllerRef.current = controller
      const pending = pendingExplorerActionRef.current
      if (!controller || !pending) return
      pendingExplorerActionRef.current = null
      window.requestAnimationFrame(() => controller.run(pending))
    },
    [],
  )

  const renderTool = useCallback(
    (tabId: string): ReactNode => {
      const tool = muxToolPaneForTab(tabId)
      if (!tool) return null
      if (tool.kind !== "explorer") {
        return (
          <Suspense
            fallback={
              <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">
                Loading {tool.label}…
              </div>
            }
          >
            <MuxToolPanes
              kind={tool.kind}
              revision={toolRevisions[tool.kind]}
              workspace={workspace}
              getActiveDocument={getActiveDocument}
              getLspController={() => lspControllerRef.current}
              onOpenLocation={openToolLocation}
              onOpenBuffer={uri => openInPreferredEditor({ uri })}
            />
          </Suspense>
        )
      }
      return (
        <Suspense
          fallback={
            <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">
              Loading Explorer…
            </div>
          }
        >
          <MuxExplorerPane
            manager={workspace.manager}
            workspace={workspace}
            expandedIds={explorerExpandedIdsRef.current}
            onExpandedChange={ids => {
              explorerExpandedIdsRef.current = ids
            }}
            onOpenFile={uri => openInPreferredEditor({ uri })}
            onControllerReady={handleExplorerControllerReady}
          />
        </Suspense>
      )
    },
    [
      getActiveDocument,
      handleExplorerControllerReady,
      openInPreferredEditor,
      openToolLocation,
      sessionCwdPath,
      sessionId,
      toolRevisions,
      workspace,
    ],
  )

  const getWorkspaceEditTransactions = useCallback(async () => {
    const existing = workspaceEditTransactionsRef.current
    if (existing) return existing
    const [{ WorkspaceEditTransactionService }, { editorBufferServiceFor }] =
      await Promise.all([
        import("../editor/workspace-edit-transaction.js"),
        import("../editor/editor-buffer-service.js"),
      ])
    const buffers = editorBufferServiceFor(workspace, sessionIdRef.current)
    const fs = window.yaade?.fs
    if (!fs?.readTextFile || !fs.writeTextFile) {
      throw new Error("Versioned text-file operations are unavailable")
    }
    const transactions = new WorkspaceEditTransactionService({
      getOpenDocument: uri => {
        const snapshot = buffers.snapshot(uri)
        const model = snapshot?.open ? buffers.get(uri) : undefined
        if (!model) return null
        return {
          readText: () => model.getValue(),
          applyEdits: edits => {
            model.pushStackElement()
            model.pushEditOperations(
              [],
              edits.map(edit => ({
                range: {
                  startLineNumber: edit.range.startLine,
                  startColumn: edit.range.startColumn,
                  endLineNumber: edit.range.endLine,
                  endColumn: edit.range.endColumn,
                },
                text: edit.text,
              })),
              () => null,
            )
            model.pushStackElement()
          },
          undoLastEdit: () =>
            (model as unknown as { undo(): void | Promise<void> }).undo(),
        }
      },
      readTextFile: uri => fs.readTextFile(uri),
      writeTextFile: (uri, content, options) =>
        fs.writeTextFile(uri, content, options),
    })
    workspaceEditTransactionsRef.current = transactions
    return transactions
  }, [workspace])

  const applyLspWorkspaceEditTransaction = useCallback<
    NonNullable<JetLspWorkspaceDeps["applyWorkspaceEditTransaction"]>
  >(async (edit, options) => {
    const fs = window.yaade?.fs
    if (
      !fs?.readTextFile ||
      !fs.createFile ||
      !fs.rename ||
      !fs.trash ||
      !fs.restoreTrash
    ) {
      return {
        applied: false,
        reason: "Atomic workspace file operations are unavailable",
      }
    }
    const [transactions, { editorBufferServiceFor }, lsp, transactionModule] =
      await Promise.all([
        getWorkspaceEditTransactions(),
        import("../editor/editor-buffer-service.js"),
        import("@yaade/lsp"),
        import("../editor/lsp-workspace-edit-transaction.js"),
      ])
    const buffers = editorBufferServiceFor(workspace, sessionIdRef.current)
    return transactionModule.applyLspWorkspaceEditTransaction(edit, options, {
      fs,
      transactions,
      getOpenDocument: uri => {
        const snapshot = buffers.snapshot(uri)
        const model = snapshot?.open ? buffers.get(uri) : undefined
        if (!model) return null
        return {
          readText: () => model.getValue(),
          applyEdits: edits => {
            model.pushStackElement()
            model.pushEditOperations(
              [],
              edits.map(item => ({
                range: {
                  startLineNumber: item.range.startLine,
                  startColumn: item.range.startColumn,
                  endLineNumber: item.range.endLine,
                  endColumn: item.range.endColumn,
                },
                text: item.text,
              })),
              () => null,
            )
            model.pushStackElement()
          },
          undoLastEdit: () =>
            (model as unknown as { undo(): void | Promise<void> }).undo(),
        }
      },
      isOpen: uri =>
        buffers.snapshots().some(
          snapshot => snapshot.open && uriAtOrBelow(snapshot.uri, uri),
        ),
      isDirty: uri =>
        buffers.snapshots().some(
          snapshot => snapshot.dirty && uriAtOrBelow(snapshot.uri, uri),
        ) || workspace.fileForUri(uri)?.isDirty === true,
      isUriAllowed: uri => workspace.resolveRootUriForFile(uri) != null,
      getDocumentVersion: lsp.getDocumentVersion,
      prepareOpenResourceReconciliation: async operations => {
        const originalWindows = windowsRef.current
        const originalEditorFiles = editorFilesRef.current
        const originalViewStates = snapshotEditorViewStates(
          sessionIdRef.current,
        )
        const originalBuffers = buffers
          .snapshots()
          .filter(snapshot => snapshot.open)
          .map(snapshot => ({
            snapshot,
            content: buffers.get(snapshot.uri)?.getValue() ?? "",
          }))
        const mapping = new Map<string, string | null>(
          originalBuffers.map(({ snapshot }) => [snapshot.uri, snapshot.uri]),
        )
        const forceReload = new Set<string>()

        for (const operation of operations) {
          if (operation.kind === "rename") {
            for (const [originalUri, currentUri] of mapping) {
              if (!currentUri) continue
              if (uriAtOrBelow(currentUri, operation.oldUri)) {
                mapping.set(
                  originalUri,
                  remapResourceDescendant(
                    currentUri,
                    operation.oldUri,
                    operation.newUri,
                  ),
                )
              } else if (uriAtOrBelow(currentUri, operation.newUri)) {
                // An overwrite removes the previous target document.
                mapping.set(originalUri, null)
              }
            }
          } else if (operation.kind === "delete") {
            for (const [originalUri, currentUri] of mapping) {
              if (currentUri && uriAtOrBelow(currentUri, operation.uri)) {
                mapping.set(originalUri, null)
              }
            }
          } else {
            for (const currentUri of mapping.values()) {
              if (currentUri && uriAtOrBelow(currentUri, operation.uri)) {
                forceReload.add(currentUri)
              }
            }
          }
        }

        const affected = originalBuffers.filter(({ snapshot }) => {
          const finalUri = mapping.get(snapshot.uri)
          return finalUri !== snapshot.uri || forceReload.has(snapshot.uri)
        })
        if (affected.length === 0) {
          return { apply: () => {}, rollback: () => {} }
        }

        const reopen = async (
          states: typeof affected,
          targetFor: (sourceUri: string) => string | null,
        ) => {
          const byTarget = new Map<string, typeof affected>()
          for (const state of states) {
            const targetUri = targetFor(state.snapshot.uri)
            if (!targetUri) continue
            const group = byTarget.get(targetUri) ?? []
            group.push(state)
            byTarget.set(targetUri, group)
          }
          for (const [targetUri, sources] of byTarget) {
            const disk = await fs.readTextFile(targetUri)
            if (buffers.snapshot(targetUri)) {
              await buffers.handleExternalFileChange(targetUri)
            }
            for (const source of sources) {
              for (const ownerId of source.snapshot.owners) {
                await buffers.open({
                  uri: targetUri,
                  languageId: source.snapshot.languageId,
                  ownerId,
                  initialContent: disk.content,
                  baseDiskVersion: disk.version,
                  initialDiskSize: disk.size,
                })
              }
            }
          }
        }

        return {
          apply: async () => {
            for (const { snapshot } of affected) {
              buffers.close(snapshot.uri, { discard: true })
            }
            await reopen(affected, sourceUri => mapping.get(sourceUri) ?? null)

            const changedMapping = new Map(
              affected.map(({ snapshot }) => [
                snapshot.uri,
                mapping.get(snapshot.uri) ?? null,
              ]),
            )
            for (const [oldUri, newUri] of changedMapping) {
              if (newUri && newUri !== oldUri) {
                remapEditorViewStateUri(sessionIdRef.current, oldUri, newUri)
              }
              if (newUri !== oldUri) workspace.disposeTab(oldUri)
              if (newUri) {
                workspace.registerTab({
                  id: newUri,
                  kind: "editor",
                  label: editorLabelFromUri(newUri),
                })
              }
            }

            const nextFiles = { ...originalEditorFiles }
            for (const [oldUri] of changedMapping) delete nextFiles[oldUri]
            for (const { snapshot } of affected) {
              const newUri = mapping.get(snapshot.uri)
              if (!newUri) continue
              nextFiles[newUri] = {
                ...(originalEditorFiles[snapshot.uri] ?? { uri: snapshot.uri }),
                uri: newUri,
              }
            }
            editorFilesRef.current = nextFiles
            setEditorFiles(nextFiles)
            const nextWindows = originalWindows.map(live => ({
              ...live,
              tree: applyEditorResourceMapping(live.tree, changedMapping),
            }))
            windowsRef.current = nextWindows
            setWindows(nextWindows)
          },
          rollback: async () => {
            const finalUris = new Set(
              affected
                .map(({ snapshot }) => mapping.get(snapshot.uri))
                .filter((uri): uri is string => Boolean(uri)),
            )
            for (const uri of finalUris) {
              buffers.close(uri, { discard: true })
            }
            await reopen(affected, sourceUri => sourceUri)
            replaceEditorViewStates(sessionIdRef.current, originalViewStates)
            editorFilesRef.current = originalEditorFiles
            setEditorFiles(originalEditorFiles)
            windowsRef.current = originalWindows
            setWindows(originalWindows)
            for (const { snapshot } of affected) {
              workspace.registerTab({
                id: snapshot.uri,
                kind: "editor",
                label: editorLabelFromUri(snapshot.uri),
              })
            }
          },
        }
      },
    })
  }, [getWorkspaceEditTransactions, workspace])

  const onQuickOpenSearch = useCallback(
    async (query: string, signal: AbortSignal): Promise<string[]> => {
      const root = cwdUri()
      const search =
        typeof window !== "undefined" ? window.yaade?.search : undefined
      if (!root || !search) return []
      try {
        return (await search.fileSearch(root, query, { pageSize: 50 }, signal)).items
      } catch (error) {
        if (signal.aborted) throw error
        return []
      }
    },
    [cwdUri],
  )

  const onQuickOpenSelect = useCallback(
    (path: string) => {
      openToolLocation(resolveEditorUri(cwdUri(), path))
    },
    [cwdUri, openToolLocation],
  )

  const onProjectSearch = useCallback(
    async (
      query: string,
      options: ProjectSearchOptions,
      signal: AbortSignal,
    ): Promise<SearchPage<ProjectSearchResult>> => {
      const root = cwdUri()
      const search =
        typeof window !== "undefined" ? window.yaade?.search : undefined
      if (!root || !search) return { items: [], truncated: false }
      try {
        return await search.project(root, query, options, signal)
      } catch (error) {
        if (signal.aborted) throw error
        return { items: [], truncated: false }
      }
    },
    [cwdUri],
  )

  const onProjectSearchPreviewReplace = useCallback(
    async (results: ProjectSearchResult[], replacement: string) => {
      const root = cwdUri()
      if (!root) throw new Error("Workspace root is unavailable")
      const [{ searchReplaceRequests }, transactions] = await Promise.all([
        import("../editor/workspace-edit-transaction.js"),
        getWorkspaceEditTransactions(),
      ])
      const preview = await transactions.preview(
        searchReplaceRequests(root, results, replacement),
      )
      searchReplacePreviewRef.current = preview
      return { fileCount: preview.files.length, editCount: preview.editCount }
    },
    [cwdUri, getWorkspaceEditTransactions],
  )

  const onProjectSearchApplyReplace = useCallback(async () => {
    const preview = searchReplacePreviewRef.current
    if (!preview) throw new Error("Preview the selected changes before applying them")
    const transactions = await getWorkspaceEditTransactions()
    await transactions.apply(preview)
    searchReplacePreviewRef.current = null
    showYaadeToast(
      `Replaced ${preview.editCount} match${preview.editCount === 1 ? "" : "es"} in ${preview.files.length} file${preview.files.length === 1 ? "" : "s"}.`,
    )
  }, [getWorkspaceEditTransactions])

  const onProjectSearchUndoReplace = useCallback(async () => {
    const transactions = await getWorkspaceEditTransactions()
    if (!(await transactions.undoLast())) {
      showYaadeToast("There is no search replace transaction to undo.", {
        variant: "warning",
      })
      return
    }
    showYaadeToast("Undid the last search replace transaction.")
  }, [getWorkspaceEditTransactions])

  searchPreviewCommandRef.current = () => {
    const preview = searchReplacePreviewRef.current
    if (!preview) {
      setProjectSearchOpen(true)
      showYaadeToast("Select search matches and a replacement to preview.")
      return
    }
    showYaadeToast(
      `Preview: ${preview.editCount} edit${preview.editCount === 1 ? "" : "s"} in ${preview.files.length} file${preview.files.length === 1 ? "" : "s"}.`,
    )
  }
  searchApplyCommandRef.current = onProjectSearchApplyReplace
  searchUndoCommandRef.current = onProjectSearchUndoReplace

  const onProjectSearchSelect = useCallback(
    (result: ProjectSearchResult) => {
      openToolLocation(
        resolveEditorUri(cwdUri(), result.path),
        result.line,
        result.column,
      )
    },
    [cwdUri, openToolLocation],
  )

  const paletteCommands = commands.list(getCommandContext()).map(c => ({
    id: c.id,
    title: c.title,
    category: c.category,
    aliases: c.aliases,
    keybinding: shortcutFor(c.id),
  }))
  void commandRevision
  void paletteOpen

  const switcherItems = useMemo<PaletteShellItem<MuxSwitcherEntry>[]>(
    () =>
      switcherEntries.map(e => ({
        key: e.ptyTabId,
        value: `${e.windowTitle} ${e.title}`,
        data: e,
      })),
    [switcherEntries],
  )

  const footer = pendingChordPrefix ? (
    <WhichKeyPanel
      prefix={formatKeyBinding(pendingChordPrefix)}
      entries={whichKeyEntries}
    />
  ) : (
    <MuxStatusStrip
      prefixLabel={formatKeyBinding(MUX_PREFIX)}
      actions={statusStripActions}
    />
  )

  const muxBody = (
    <TabDndRoot handlers={tabDnd}>
      <div
        className="flex h-full min-h-0 w-full flex-col"
        data-yaade-shell={embedded ? "mux-embedded" : "mux"}
        data-yaade-mux=""
        data-yaade-session-id={sessionId}
        data-yaade-session-cwd={sessionCwdPath}
      >
        {!embedded && (onBackToProject || sessionTitle) ? (
          <div
            className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3"
            data-yaade-session-chrome=""
            data-yaade-app-header=""
          >
            {onBackToProject ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                data-yaade-session-back=""
                onClick={onBackToProject}
              >
                ← Project
              </Button>
            ) : null}
            <span className="truncate text-xs font-medium text-foreground">
              {sessionTitle}
            </span>
          </div>
        ) : null}
        <div
          ref={workspaceSurfaceRef}
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
          data-yaade-mux-surface={surface ?? "full"}
        >
          {surface === "agents" ? (
                <div
                  ref={dockSurfaceRef}
                  className="absolute inset-0 flex min-h-0"
                  data-yaade-project-surface="agents"
                >
                  <InstanceSidebar
                    dataPrefix="agents"
                    title="Agents"
                    titleIcon={
                      <Bot className="size-3.5 shrink-0 text-muted-foreground" />
                    }
                    items={agentSidebarItems}
                    activeId={focusAgentTabId}
                    listPanelId="project-agents"
                    emptyLabel="No agents running."
                    onSelect={tabId => {
                      onSelectAgentTab?.(tabId)
                    }}
                    onNew={() => {
                      onLaunchAgent?.()
                    }}
                    onClose={tabId => {
                      if (!activeWindow) return
                      const leaf = listTerminalLeaves(activeWindow.tree).find(
                        l => l.ptyTabId === tabId,
                      )
                      if (!leaf) return
                      void closePane(
                        activeWindow.id,
                        leaf.panelId,
                        leaf.ptyTabId,
                      )
                    }}
                  />
                  <div className="relative min-h-0 min-w-0 flex-1">
                    {focusAgentTabId &&
                    agentInstanceTabIds.includes(focusAgentTabId) ? (
                      <div
                        className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-lg border border-border bg-card"
                        data-yaade-mux-pane={focusAgentTabId}
                        data-yaade-mux-pane-kind="terminal"
                        data-focused=""
                      >
                        <div
                          className="flex h-7 shrink-0 items-center border-b border-border bg-secondary/30 px-2"
                          data-yaade-mux-pane-chrome=""
                        >
                          <span
                            className="truncate text-xs font-medium"
                            data-yaade-mux-pane-title=""
                            aria-label={paneTitle(focusAgentTabId)}
                          >
                            {paneTitle(focusAgentTabId)}
                          </span>
                        </div>
                        <div
                          className="min-h-0 flex-1 overflow-hidden"
                          data-yaade-mux-terminal-slot={focusAgentTabId}
                        />
                      </div>
                    ) : (
                      <div
                        className="grid h-full place-items-center px-4 text-center text-sm text-muted-foreground"
                        data-yaade-agents-empty=""
                      >
                        {focusAgentTabId ? (
                          <p>That agent is no longer running.</p>
                        ) : (
                          <div className="max-w-sm">
                            <p>No agents running.</p>
                            {onLaunchAgent ? (
                              <Button
                                className="mt-3"
                                variant="secondary"
                                size="sm"
                                data-yaade-agents-empty-launch=""
                                onClick={() => onLaunchAgent()}
                              >
                                Launch agent…
                              </Button>
                            ) : null}
                          </div>
                        )}
                      </div>
                    )}
                    <div
                      className="pointer-events-none absolute size-0 overflow-hidden"
                      aria-hidden
                    >
                      {allPtyIds
                        .filter(id => id !== focusAgentTabId)
                        .map(id => (
                          <div key={id} data-yaade-mux-terminal-slot={id} />
                        ))}
                    </div>
                  </div>
                </div>
              ) : surface === "editors" ? (
                <div
                  ref={dockSurfaceRef}
                  className="absolute inset-0 flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card"
                  data-yaade-project-surface="editors"
                  data-yaade-editor-workspace-path={editorWorkspacePath ?? sessionCwdPath}
                >
                  <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border bg-secondary/30 px-1">
                  {surfaceEditorBuffers.length > 0 && editorsActiveTabId ? (
                    <ModalEditorTabBar
                      buffers={surfaceEditorBuffers}
                      activeTabId={editorsActiveTabId}
                      onActivateBuffer={tabId => {
                        setEditorsActiveTabId(tabId)
                        if (!activeWindow) return
                        const panelId = findPanelWithTab(activeWindow.tree, tabId)
                        if (panelId) activateEditorTab(activeWindow.id, panelId, tabId)
                      }}
                      onCloseBuffer={tabId => {
                        if (!activeWindow) return
                        const panelId = findPanelWithTab(activeWindow.tree, tabId)
                        if (panelId) void closeEditorTab(activeWindow.id, panelId, tabId)
                      }}
                      className="min-h-0 min-w-0 flex-1"
                    />
                  ) : (
                    <div className="min-w-0 flex-1" />
                  )}
                  {editorToolbar ? (
                    <div className="ml-auto shrink-0">{editorToolbar}</div>
                  ) : null}
                  </div>
                  {surfaceEditorBuffers.length > 0 && editorsActiveTabId ? (
                    <div className="min-h-0 flex-1 overflow-hidden">
                      {(() => {
                        const panelId =
                          findPanelWithTab(activeWindow!.tree, editorsActiveTabId) ??
                          listPaneLeaves(activeWindow!.tree).find(
                            l => l.kind === "editor",
                          )?.panelId
                        if (!panelId) return null
                        return renderEditor(editorsActiveTabId, panelId, true)
                      })()}
                    </div>
                  ) : (
                    <div className="grid min-h-0 flex-1 place-items-center gap-3 px-4 text-center">
                      <p className="text-sm text-muted-foreground">
                        No open editors in this worktree.
                      </p>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setQuickOpenOpen(true)}
                      >
                        Open file…
                      </Button>
                    </div>
                  )}
                  <div
                    className="pointer-events-none absolute size-0 overflow-hidden"
                    aria-hidden
                  >
                    {allPtyIds.map(id => (
                      <div key={id} data-yaade-mux-terminal-slot={id} />
                    ))}
                  </div>
                </div>
              ) : surface === "terminals" ? (
                <div
                  ref={dockSurfaceRef}
                  className="absolute inset-0 flex min-h-0"
                  data-yaade-project-surface="terminals"
                >
                  <InstanceSidebar
                    dataPrefix="terminals"
                    title="Terminals"
                    titleIcon={
                      <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" />
                    }
                    items={terminalSidebarItems}
                    activeId={focusedPtyTabId}
                    listPanelId="project-terminals"
                    emptyLabel="No terminals yet."
                    onSelect={tabId => {
                      if (!activeWindow) return
                      const leaf = listTerminalLeaves(activeWindow.tree).find(
                        l => l.ptyTabId === tabId,
                      )
                      if (!leaf) return
                      focusPane(activeWindow.id, leaf.panelId, leaf.ptyTabId)
                    }}
                    onNew={() => {
                      setTerminalCheckoutOpen(true)
                    }}
                    onClose={tabId => {
                      if (!activeWindow) return
                      const leaf = listTerminalLeaves(activeWindow.tree).find(
                        l => l.ptyTabId === tabId,
                      )
                      if (!leaf) return
                      void closePane(activeWindow.id, leaf.panelId, leaf.ptyTabId)
                    }}
                  />
                  <div className="relative min-h-0 min-w-0 flex-1">
                    {focusedPtyTabId &&
                    terminalSurfacePtyIds.includes(focusedPtyTabId) ? (
                      <div
                        className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-lg border border-border bg-card"
                        data-yaade-mux-pane={focusedPtyTabId}
                        data-yaade-mux-pane-kind="terminal"
                        data-focused=""
                      >
                        <div
                          className="flex h-7 shrink-0 items-center border-b border-border bg-secondary/30 px-2"
                          data-yaade-mux-pane-chrome=""
                        >
                          <span
                            className="truncate text-xs font-medium"
                            data-yaade-mux-pane-title=""
                            aria-label={paneTitle(focusedPtyTabId)}
                          >
                            {paneTitle(focusedPtyTabId)}
                          </span>
                        </div>
                        <div
                          className="min-h-0 flex-1 overflow-hidden"
                          data-yaade-mux-terminal-slot={focusedPtyTabId}
                        />
                      </div>
                    ) : (
                      <div className="grid h-full place-items-center gap-3 px-4 text-center">
                        <p className="text-sm text-muted-foreground">
                          No terminal selected.
                        </p>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setTerminalCheckoutOpen(true)
                          }}
                        >
                          New terminal
                        </Button>
                      </div>
                    )}
                    <div
                      className="pointer-events-none absolute size-0 overflow-hidden"
                      aria-hidden
                    >
                      {allPtyIds
                        .filter(id => id !== focusedPtyTabId)
                        .map(id => (
                          <div key={id} data-yaade-mux-terminal-slot={id} />
                        ))}
                    </div>
                  </div>
                </div>
              ) : activeWindow ? (
                <div
                  ref={dockSurfaceRef}
                  className="h-full min-h-0 w-full"
                >
                <MuxWindowView
                  key={activeWindow.id}
                  tree={activeWindow.tree}
                  focusedPanelId={activeWindow.focusedPaneId}
                  zoomedPaneId={activeWindow.zoomedPaneId}
                  paneTitle={paneTitle}
                  paneProcessName={paneProcessName}
                  onFocusPanel={panelId => {
                    const pty = listPaneLeaves(activeWindow.tree).find(
                      p => p.panelId.id === panelId.id,
                    )
                    focusPane(activeWindow.id, panelId, pty?.ptyTabId)
                  }}
                  onEvent={event => {
                    handlePanelEvent(activeWindow.id, event)
                  }}
                  tabDnd={tabDnd}
                  onSplit={(panelId, edge) =>
                    void splitPane(activeWindow.id, panelId, edge)
                  }
                  onOpenGit={panelId =>
                    void openGitSplit(activeWindow.id, panelId)
                  }
                  onOpenNeovim={panelId =>
                    void openNeovimSplit(activeWindow.id, panelId)
                  }
                  onOpenEditor={panelId =>
                    void openEditorSplit(activeWindow.id, panelId, {
                      forceNewGroup: true,
                    })
                  }
                  onOpenFile={(panelId, filePath, line) => {
                    const leaf = listPaneLeaves(activeWindow.tree).find(
                      p => p.panelId.id === panelId.id,
                    )
                    const rootUri = leaf
                      ? (gitRoots[leaf.ptyTabId] ?? cwdUri())
                      : cwdUri()
                    void openEditorSplit(activeWindow.id, panelId, {
                      uri: resolveEditorUri(rootUri, filePath),
                      line,
                    })
                  }}
                  onZoom={ptyTabId => zoomPane(activeWindow.id, ptyTabId)}
                  onClosePane={(panelId, ptyTabId) =>
                    void closePane(activeWindow.id, panelId, ptyTabId)
                  }
                  onActivateEditorTab={(panelId, tabId) =>
                    activateEditorTab(activeWindow.id, panelId, tabId)
                  }
                  onCloseEditorTab={(panelId, tabId) =>
                    void closeEditorTab(activeWindow.id, panelId, tabId)
                  }
                  onEmptyOpenTerminal={() => {
                    void executeCommand("terminal.new")
                  }}
                  onEmptyOpenNeovim={() => {
                    void executeCommand("mux.openNeovim")
                  }}
                  onEmptyOpenGit={() => {
                    void executeCommand("mux.openGit")
                  }}
                  onEmptyOpenEditor={() => {
                    void executeCommand("mux.openEditor")
                  }}
                  onEmptyOpenAgent={driver => {
                    void openAgentCliPane(driver).catch(error => {
                      showYaadeToast(
                        error instanceof Error ? error.message : "Could not launch agent",
                        { variant: "destructive" },
                      )
                    })
                  }}
                  onNewWindow={() => openBrowserProjectTab()}
                  gitRootForTab={tabId =>
                    (gitRoots[tabId] ?? cwdUri()) || null
                  }

                  editorFileForTab={tabId =>
                    editorFiles[tabId] ??
                    (isFileEditorTabId(tabId) ? { uri: tabId } : null)
                  }
                  editorDirtyForTab={editorIsDirty}
                  editorBuffersForPanel={panelId => {
                    const view = activeWindow.tree.getView(panelId)
                    if (!view || view.kind !== "tabs") return []
                    return panelTabIds(view)
                      .filter(id => isEditorTabId(id))
                      .map(tabId => ({
                        tabId,
                        label:
                          workspace.tabRegistry.get(tabId)?.label ??
                          editorLabelFromUri(tabId),
                        dirty: editorIsDirty(tabId),
                      }))
                  }}
                  shortcutFor={shortcutFor}
                  renderEditor={renderEditor}
                  renderTool={renderTool}
                  theme={activeTheme as YaadeTheme}
                  fontSize={fontSize}
                  empty={
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      Empty pane
                    </div>
                  }
                />
                </div>
              ) : (
                <div
                  className="flex h-full min-h-0 w-full flex-col p-1.5"
                  data-yaade-mux-empty=""
                  aria-busy="true"
                  aria-label="Loading workspace"
                >
                  <div className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-lg border border-border bg-card">
                    <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border bg-secondary/30 px-1.5">
                      <div className="size-3 shrink-0 animate-pulse rounded-[0.2rem] bg-muted/50" />
                      <div className="h-2.5 w-24 animate-pulse rounded bg-muted/40" />
                    </div>
                    <div className="min-h-0 flex-1" />
                  </div>
                </div>
              )}
              <MuxTerminalLayer
                ptyTabIds={mountedPtyIds}
                boxes={slotBoxes}
                focusedPtyTabId={focusedPtyTabId}
                renderTerminal={renderTerminal}
              />
            </div>
          </div>
        </TabDndRoot>
  )

  const chrome = (
    <>
      {muxBody}
      {paletteOpen ||
      terminalListOpen ||
      settingsOpen ||
      cdOpen ||
      quickOpenOpen ||
      projectSearchOpen ||
      saveAsUri != null ? (
        <Suspense fallback={null}>
        <MuxOverlays
          paletteOpen={paletteOpen}
          onPaletteOpenChange={setPaletteOpen}
          paletteCommands={paletteCommands}
          onRunCommand={id => void executeCommand(id)}
          terminalListOpen={terminalListOpen}
          onTerminalListOpenChange={setTerminalListOpen}
          switcherItems={switcherItems}
          onSelectTerminal={entry => {
            focusPane(
              entry.windowId,
              { id: entry.panelId },
              entry.ptyTabId,
            )
          }}
          settingsOpen={settingsOpen}
          onSettingsOpenChange={setSettingsOpen}
          appearanceSettings={appearanceSettings}
          onAppearanceChange={setAppearanceSettings}
          onResetAppearance={resetAppearanceSettings}
          cdOpen={cdOpen}
          onCdOpenChange={setCdOpen}
          cdInitialPath={
            lastCwdUri
              ? fileUriToPath(lastCwdUri)
              : homeDirRef.current || null
          }
          onSelectFolder={openWorkspace}
          resolveHomeDir={async () => {
            if (window.yaade?.getHomeDir) {
              return window.yaade.getHomeDir()
            }
            return homeDirRef.current
          }}
          quickOpenOpen={quickOpenOpen}
          onQuickOpenOpenChange={setQuickOpenOpen}
          onQuickOpenSearch={onQuickOpenSearch}
          onQuickOpenSelect={onQuickOpenSelect}
          projectSearchOpen={projectSearchOpen}
          onProjectSearchOpenChange={setProjectSearchOpen}
          onProjectSearch={onProjectSearch}
          onProjectSearchSelect={onProjectSearchSelect}
          onProjectSearchPreviewReplace={onProjectSearchPreviewReplace}
          onProjectSearchApplyReplace={onProjectSearchApplyReplace}
          onProjectSearchUndoReplace={onProjectSearchUndoReplace}
          saveAsOpen={saveAsUri != null}
          onSaveAsOpenChange={open => {
            if (!open) setSaveAsUri(null)
          }}
          saveAsRootPath={
            surface === "editors"
              ? editorWorkspacePath ?? sessionCwdPath
              : sessionCwdPath
          }
          onSaveAsTarget={completeSaveAs}
          />
        </Suspense>
      ) : null}


      <CheckoutPicker
        mode="dialog"
        open={terminalCheckoutOpen}
        onOpenChange={setTerminalCheckoutOpen}
        projectPath={sessionProjectPath}
        homeDir={homeDir}
        defaultBranch={terminalDefaultBranch}
        activeLabel="Main"
        activeCwdPath={sessionProjectPath}
        allowRemove={false}
        dialogTitle="New terminal"
        dialogDescription="Choose Main or a worktree for this shell."
        onSelectCheckout={async (selection: CheckoutSelection) => {
          await openTerminalInActiveWindow("right", {
            rootUri: pathToFileUri(selection.cwdPath),
          })
        }}
        onCreateWorktree={async input => {
          const created = await createProjectSession({
            rootPath: sessionProjectPath,
            title: "Main",
            worktree: input,
          })
          const wt = created.createdWorktree
          if (!wt) throw new Error("Worktree was not created")
          return {
            cwdPath: wt.path,
            title: wt.branch,
            worktreeBranch: wt.branch,
            worktreePath: wt.path,
            checkoutKey: wt.path,
          }
        }}
      />

      <ConfirmDialogHost />
      {editorRuntimeNeeded ? (
        <Suspense fallback={null}>
          <MuxLspHost
            workspace={workspace}
            processCwdUri={pathToFileUri(
              surface === "editors"
                ? editorWorkspacePath ?? sessionCwdPath
                : sessionCwdPath,
            )}
            applyWorkspaceEditTransaction={applyLspWorkspaceEditTransaction}
            onOpenFile={(uri, _path, line, column) => {
              openEditorInFocusedRef.current({ uri, line, column })
            }}
            onReady={handleLspReady}
          />
        </Suspense>
      ) : null}
      <Toaster position="bottom-right" />
    </>
  )

  return (
    <TooltipProvider>
      {embedded ? (
        <div
          className="flex h-full min-h-0 w-full flex-col overflow-hidden"
          data-yaade-app-shell=""
        >
          <div className="min-h-0 flex-1 overflow-hidden">{chrome}</div>
          {footer}
        </div>
      ) : (
        <AppShell footer={footer}>{chrome}</AppShell>
      )}
    </TooltipProvider>
  )
}
