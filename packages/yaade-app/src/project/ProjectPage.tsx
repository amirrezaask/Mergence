import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import type {
  HqAgentSummary,
  ProjectSession,
} from "@yaade/rpc"
import {
  pathToFileUri,
  type GitWorktree,
  type YaadeTheme,
} from "@yaade/shared"
import {
  isTerminalTabId,
  terminalTabId,
  type AgentRunInfo,
  type TerminalInstanceInfo,
} from "@yaade/workspace"
import { AgentProviderIcon } from "@yaade/ui/agent-picker"
import {
  AppShell,
  cn,
} from "@yaade/ui/project"
import {
  ConfirmDialogHost,
  ProjectWorkspaceSidebar,
  SidebarInset,
  SidebarProvider,
  requestConfirm,
  type ProjectWorkspaceSidebarProcess,
  type ProjectWorkspaceSidebarWorktree,
} from "@yaade/ui"
import { bundledThemeList } from "@yaade/ui/appearance"
import {
  Button,
} from "@yaade/ui/primitives"
import { showYaadeToast, Toaster } from "@yaade/ui/toast"
import {
  ChevronsUpDown,
  FolderKanban,
  Plus,
} from "lucide-react"
import { useAppearanceSettings } from "../hooks/useAppearanceSettings.js"
import { useHqOverview } from "../hooks/useHqOverview.js"
import { preloadMuxApp } from "../mux/preload.js"
import type {
  MuxLaunchAction,
  MuxLaunchRequest,
  MuxSurface,
} from "../mux/MuxApp.js"
import {
  projectRouteFromSearch,
  pushProjectRoute,
  replaceProjectRoute,
  type ProjectView,
  workspaceDocumentTitle,
} from "../url-workspace.js"
import {
  createProjectSession,
  listProjectSessions,
  openCheckoutSession,
  removeProjectWorktree,
} from "../project-session-client.js"
import {
  loadProjectSurfaceState,
  saveProjectSurfaceState,
  type ProjectSurfaceSelection,
} from "../project-surface-state-client.js"
import { defaultAgentWorktreeName } from "./agent-worktree-name.js"
import {
  claimHqAgentLaunch,
  clearHqAgentLaunch,
  peekHqAgentLaunch,
} from "./hq-agent-launch.js"
import { OpenProjectOverlay } from "./OpenProjectOverlay.js"
import {
  CheckoutPicker,
  checkoutLabelForPath,
  sameCheckoutPath,
  selectionFromPaths,
  type CheckoutSelection,
} from "./CheckoutPicker.js"
import { CreateWorktreeDialog } from "./CreateWorktreeDialog.js"
import {
  RunningProjectSurface,
} from "./ProjectProcessSurfaces.js"
import {
  ProcessLaunchMenu,
  type ProcessLaunchSelection,
} from "./ProjectLaunchMenus.js"
import {
  processStatusLabel,
  useProjectProcessSidebar,
} from "./project-process-sidebar.js"

const GitWorkspace = lazy(() =>
  import("@yaade/ui/git").then(m => ({ default: m.GitWorkspace })),
)
function preloadSettingsOverlay() {
  return import("@yaade/ui/settings")
}

const MuxApp = lazy(() =>
  preloadMuxApp().then(m => ({ default: m.MuxApp })),
)
const SettingsOverlay = lazy(() =>
  preloadSettingsOverlay().then(m => ({ default: m.SettingsOverlay })),
)

export type ProjectPageProps = {
  projectId: string
  projectName: string
  projectPath: string
  homeDir: string
  machineHostname: string
  routeRevision?: number
  /** Active session — surface workspace renders in-page when set. */
  session: ProjectSession | null
  /** One-shot launch requested from HQ before navigating into this project. */
  agentLaunchIntent?: {
    id: string
    driverId: Extract<MuxLaunchAction, { kind: "agent" }>["driverId"]
    useWorktree?: boolean
    worktreeName?: string
  } | null
  onAgentLaunchIntentHandled?: (intentId: string) => void
  /** Focus a specific agent leaf when opening from HQ agent list. */
  initialAgentFocusTabId?: string | null
  routeError?: string | null
  onInitialAgentFocusHandled?: () => void
  onOpenSession: (sessionId: string) => Promise<void>
  /** Clear the active session (leave surface view, keep project chrome). */
  onClearSession?: () => void
  onNavigateProject: (absolutePath: string) => void
  onOpenHq: () => void
}

type ActiveCheckout = {
  cwdPath: string
  label: string
  checkoutKey: string
}

function isSurfaceView(view: ProjectView): view is MuxSurface {
  return view === "running" || view === "editors"
}

function surfaceForView(view: ProjectView): MuxSurface | null {
  return isSurfaceView(view) ? view : null
}

function mainCheckout(projectPath: string): ActiveCheckout {
  return { cwdPath: projectPath, label: "Main", checkoutKey: "main" }
}

function checkoutFromPaths(
  projectPath: string,
  cwdPath: string,
  label?: string | null,
  checkoutKey?: string | null,
): ActiveCheckout {
  if (sameCheckoutPath(cwdPath, projectPath)) return mainCheckout(projectPath)
  return {
    cwdPath,
    label: label?.trim() || cwdPath,
    checkoutKey: checkoutKey?.trim() || cwdPath,
  }
}

function checkoutRouteKey(checkout: ActiveCheckout): string | null {
  return checkout.checkoutKey === "main" ? null : checkout.checkoutKey
}

function projectWorktreeLabel(worktree: GitWorktree): string {
  if (worktree.branch) return worktree.branch.replace(/^refs\/heads\//, "")
  if (worktree.detached && worktree.head) {
    return `detached@${worktree.head.slice(0, 7)}`
  }
  return worktree.path.split("/").filter(Boolean).pop() ?? worktree.path
}

function useProjectWorktrees(projectPath: string) {
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const api = window.yaade?.git
      if (!api) throw new Error("Git service unavailable")
      const rootUri = pathToFileUri(projectPath)
      const isRepo = await api.isRepo(rootUri)
      const rows = isRepo ? await api.worktreeList(rootUri) : []
      setWorktrees(
        rows.filter(worktree => !worktree.bare && !worktree.prunable),
      )
    } catch (reason) {
      setWorktrees([])
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [projectPath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { worktrees, loading, error, refresh }
}

function ProjectSurfaceSlot({
  panel,
  active,
  mounted = true,
  fallback,
  children,
  className,
}: {
  panel: string
  active: boolean
  mounted?: boolean
  fallback: ReactNode
  children: ReactNode
  className?: string
}) {
  if (!mounted) return null
  return (
    <div
      className={cn(
        "absolute inset-0 overflow-hidden",
        !active && "pointer-events-none invisible",
        className,
      )}
      aria-hidden={!active}
      data-yaade-project-panel={panel}
    >
      <Suspense
        fallback={
          <div
            className="grid h-full place-items-center text-xs text-muted-foreground"
            role="status"
          >
            {fallback}
          </div>
        }
      >
        {children}
      </Suspense>
    </div>
  )
}

function ProjectGitSurface({
  view,
  active,
  rootUri,
  theme,
  activeCheckout,
}: {
  view: "history" | "changes"
  active: boolean
  rootUri: string
  theme: YaadeTheme
  activeCheckout: ActiveCheckout
}) {
  return (
    <GitWorkspace
      key={`${view}:${activeCheckout.cwdPath}`}
      rootUri={rootUri}
      theme={theme}
      initialView={view}
      unifiedHistory={view === "history"}
      active={active}
      onOpenFile={() => undefined}
    />
  )
}

function agentFocusTabId(identity: string | null): string | null {
  if (!identity) return null
  return isTerminalTabId(identity) ? identity : terminalTabId(identity)
}

function processStatusVariant(
  status: TerminalInstanceInfo["processState"],
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "running") return "default"
  if (status === "starting") return "outline"
  if (status === "failed") return "destructive"
  return "secondary"
}

export function ProjectPage({
  projectId,
  projectName,
  projectPath,
  homeDir,
  machineHostname,
  routeRevision = 0,
  session,
  agentLaunchIntent = null,
  onAgentLaunchIntentHandled,
  initialAgentFocusTabId = null,
  routeError = null,
  onInitialAgentFocusHandled,
  onOpenSession,
  onClearSession,
  onNavigateProject,
  onOpenHq,
}: ProjectPageProps) {
  const hq = useHqOverview()
  const {
    appearanceSettings,
    setAppearanceSettings,
    activeTheme,
    resetAppearanceSettings,
  } = useAppearanceSettings()
  const [view, setView] = useState<ProjectView>(
    () => projectRouteFromSearch().view,
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false)
  const [surfaceSelections, setSurfaceSelections] = useState<
    Partial<Record<Exclude<ProjectView, "history">, ProjectSurfaceSelection>>
  >({})
  const [historicalRun, setHistoricalRun] = useState<AgentRunInfo | null>(null)
  const [agentLookupComplete, setAgentLookupComplete] = useState(false)
  const [agentLookupMissing, setAgentLookupMissing] = useState(false)
  const [historyMounted, setHistoryMounted] = useState(
    () => projectRouteFromSearch().view === "history",
  )
  const [activeCheckout, setActiveCheckout] = useState<ActiveCheckout>(() =>
    mainCheckout(projectPath),
  )
  const [editorCheckout, setEditorCheckout] = useState<ActiveCheckout>(() =>
    mainCheckout(projectPath),
  )
  const [defaultBranch, setDefaultBranch] = useState("main")
  const [focusAgentTabId, setFocusAgentTabId] = useState<string | null>(
    agentFocusTabId(initialAgentFocusTabId),
  )
  const [processPickerOpen, setProcessPickerOpen] = useState(false)
  const [worktreeCreateOpen, setWorktreeCreateOpen] = useState(false)
  // Seed from the module queue so StrictMode remounts still see the HQ intent.
  const [launchRequest, setLaunchRequest] = useState<MuxLaunchRequest | null>(
    () => {
      const queued = peekHqAgentLaunch(projectId)
      return queued
        ? {
            id: queued.id,
            action: { kind: "agent", driverId: queued.driverId },
          }
        : null
    },
  )
  const launchSequenceRef = useRef(0)
  const preferredSurfaceRef = useRef<MuxSurface | null>(
    (() => {
      if (!session) return null
      const initialView = projectRouteFromSearch().view
      return isSurfaceView(initialView) ? initialView : "running"
    })(),
  )
  const rootUri = useMemo(() => pathToFileUri(projectPath), [projectPath])
  const {
    worktrees,
    loading: worktreesLoading,
    error: worktreesError,
    refresh: refreshWorktrees,
  } = useProjectWorktrees(projectPath)
  const title = workspaceDocumentTitle(projectPath, homeDir)

  useEffect(() => {
    document.title = title
  }, [title])

  useEffect(() => {
    const route = projectRouteFromSearch()
    setView(route.view)
    if (route.view === "history") setHistoryMounted(true)
    if (route.view === "running") {
      setSurfaceSelections(current => ({
        ...current,
        running: {
          ...current.running,
          processId: route.processId,
          runId: route.processId,
        },
      }))
    }
  }, [routeRevision])

  useEffect(() => {
    setDefaultBranch("main")
    setActiveCheckout(mainCheckout(projectPath))
    setEditorCheckout(mainCheckout(projectPath))
  }, [projectPath])

  useEffect(() => {
    let cancelled = false
    void window.yaade?.git
      ?.defaultBranch(rootUri)
      .then(branch => {
        if (!cancelled && branch?.trim()) setDefaultBranch(branch.trim())
      })
      .catch(() => {
        /* keep "main" fallback */
      })
    return () => {
      cancelled = true
    }
  }, [rootUri])

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      loadProjectSurfaceState(projectId),
      listProjectSessions(projectPath),
    ]).then(([rows, sessions]) => {
      if (cancelled) return
      const validWorkspaceIds = new Set(
        sessions.filter(item => !item.archivedAt).map(item => item.id),
      )
      const next: Partial<
        Record<Exclude<ProjectView, "history">, ProjectSurfaceSelection>
      > = {}
      for (const row of rows) {
        if (row.surface === "changes") {
          const path =
            typeof row.state.checkoutPath === "string" && row.state.checkoutPath.trim()
              ? row.state.checkoutPath.trim()
              : projectPath
          const key =
            typeof row.state.checkoutKey === "string" && row.state.checkoutKey.trim()
              ? row.state.checkoutKey.trim()
              : sameCheckoutPath(path, projectPath)
                ? "main"
                : path
          next.changes = {
            checkoutKey: key,
            checkoutPath: path,
          }
          continue
        }
        if (
          row.surface === "running" ||
          row.surface === "agents" ||
          row.surface === "terminals"
        ) {
          const processId =
            row.state.processId ?? row.state.runId ?? row.state.terminalId ?? null
          next.running = {
            ...next.running,
            ...row.state,
            processId,
            runId: processId,
            workspaceId:
              row.state.workspaceId && validWorkspaceIds.has(row.state.workspaceId)
                ? row.state.workspaceId
                : null,
          }
          continue
        }
        if (row.surface === "editors") {
          next.editors = {
            ...row.state,
            workspaceId:
              row.state.workspaceId && validWorkspaceIds.has(row.state.workspaceId)
                ? row.state.workspaceId
                : null,
          }
        }
      }
      setSurfaceSelections(next)

      const route = projectRouteFromSearch()
      const savedEditor = next.editors
      const editorPath =
        route.view === "editors" && route.checkoutKey === "main"
          ? projectPath
          : route.view === "editors" && route.checkoutKey?.startsWith("/")
            ? route.checkoutKey
            : savedEditor?.checkoutPath ?? projectPath
      setEditorCheckout(
        checkoutFromPaths(
          projectPath,
          editorPath,
          checkoutLabelForPath(projectPath, editorPath),
          route.view === "editors" ? route.checkoutKey : savedEditor?.checkoutKey,
        ),
      )
      if (route.checkoutKey && route.checkoutKey !== "main") {
        const fromSurface = next.changes?.checkoutPath
        const cwdPath =
          fromSurface && !sameCheckoutPath(fromSurface, projectPath)
            ? fromSurface
            : route.checkoutKey.startsWith("/")
              ? route.checkoutKey
              : projectPath
        if (!sameCheckoutPath(cwdPath, projectPath)) {
          setActiveCheckout(
            checkoutFromPaths(
              projectPath,
              cwdPath,
              checkoutLabelForPath(projectPath, cwdPath),
              route.checkoutKey,
            ),
          )
        }
      } else if (route.checkoutKey === "main") {
        setActiveCheckout(mainCheckout(projectPath))
      } else {
        const summary = next.changes
        const path = summary?.checkoutPath ?? projectPath
        setActiveCheckout(
          checkoutFromPaths(
            projectPath,
            path,
            checkoutLabelForPath(projectPath, path),
            summary?.checkoutKey ??
              (sameCheckoutPath(path, projectPath) ? "main" : path),
          ),
        )
      }
    }).catch(() => {
      /* project remains usable with Main defaults */
    })
    return () => {
      cancelled = true
    }
  }, [projectId, projectPath])

  useEffect(() => {
    const runId = projectRouteFromSearch().processId
    if (!runId) {
      setHistoricalRun(null)
      setAgentLookupComplete(false)
      setAgentLookupMissing(false)
      return
    }
    let cancelled = false
    void window.yaade?.agents?.get(runId).then(run => {
      if (cancelled) return
      setHistoricalRun(
        run && run.processState !== "running" && run.processState !== "starting"
          ? run
          : null,
      )
      setAgentLookupMissing(run == null)
      setAgentLookupComplete(true)
    })
    return () => {
      cancelled = true
    }
  }, [initialAgentFocusTabId])

  // Opening / restoring a workspace keeps the selected surface. Missing telemetry
  // must not clear a just-launched agent while HQ reconciliation catches up.
  // Changes checkout is independent of the session row (always Main).
  useEffect(() => {
    if (session) {
      const preferred = preferredSurfaceRef.current ?? "running"
      setView(current =>
        current === "history" || current === "changes" ? preferred : current,
      )
      setSurfaceSelections(current => {
        const selection = {
          ...current[preferred],
          workspaceId: session.id,
        }
        void saveProjectSurfaceState(projectId, preferred, selection)
        return { ...current, [preferred]: selection }
      })
    } else {
      preferredSurfaceRef.current = null
    }
    // Intentionally omit activeCheckout — only react to session identity.
  }, [projectId, session?.id]) // eslint-disable-line react-hooks/exhaustive-deps -- session identity only

  useEffect(() => {
    if (!initialAgentFocusTabId) return
    preferredSurfaceRef.current = "running"
    setFocusAgentTabId(agentFocusTabId(initialAgentFocusTabId))
    setView("running")
    onInitialAgentFocusHandled?.()
  }, [initialAgentFocusTabId, onInitialAgentFocusHandled])

  const persistChangesCheckout = useCallback(
    (checkout: ActiveCheckout) => {
      setSurfaceSelections(current => ({
        ...current,
        changes: {
          checkoutKey: checkout.checkoutKey,
          checkoutPath: checkout.cwdPath,
        },
      }))
      void saveProjectSurfaceState(projectId, "changes", {
        checkoutKey: checkout.checkoutKey,
        checkoutPath: checkout.cwdPath,
      })
    },
    [projectId],
  )

  const persistEditorCheckout = useCallback(
    (checkout: ActiveCheckout) => {
      const selection = {
        checkoutKey: checkout.checkoutKey,
        checkoutPath: checkout.cwdPath,
      }
      setEditorCheckout(checkout)
      setSurfaceSelections(current => ({
        ...current,
        editors: { ...current.editors, ...selection },
      }))
      void saveProjectSurfaceState(projectId, "editors", selection)
    },
    [projectId],
  )

  const ensureProjectSession = useCallback(async () => {
    if (session) return session
    const next = await openCheckoutSession({ rootPath: projectPath, title: "Main" })
    await onOpenSession(next.id)
    return next
  }, [onOpenSession, projectPath, session])

  const openSurface = useCallback(
    async (surface: MuxSurface) => {
      preferredSurfaceRef.current = surface
      const muxReady = preloadMuxApp()
      const next = await ensureProjectSession()
      await muxReady
      setView(surface)
      const selection = {
        ...surfaceSelections[surface],
        workspaceId: next.id,
      }
      setSurfaceSelections(current => ({
        ...current,
        [surface]: selection,
      }))
      void saveProjectSurfaceState(projectId, surface, selection)
      pushProjectRoute(location.pathname, {
        view: surface,
        workspaceId: next.id,
        checkoutKey: selection.checkoutKey ?? null,
        processId: surface === "running" ? focusAgentTabId : null,
      })
    },
    [ensureProjectSession, focusAgentTabId, projectId, surfaceSelections],
  )

  const handleSelectHistoryCheckout = useCallback(
    async (input: CheckoutSelection) => {
      const checkout = checkoutFromPaths(
        projectPath,
        input.cwdPath,
        input.title,
        input.checkoutKey,
      )
      setActiveCheckout(checkout)
      persistChangesCheckout(checkout)
      setHistoryMounted(true)
      setView("history")
      pushProjectRoute(location.pathname, {
        view: "history",
        workspaceId: null,
        checkoutKey: checkoutRouteKey(checkout),
        processId: null,
      })
    },
    [persistChangesCheckout, projectPath],
  )

  const handleSelectEditorCheckout = useCallback(
    async (input: CheckoutSelection) => {
      const checkout = checkoutFromPaths(
        projectPath,
        input.cwdPath,
        input.title,
        input.checkoutKey,
      )
      persistEditorCheckout(checkout)
      pushProjectRoute(location.pathname, {
        view: "editors",
        workspaceId: session?.id ?? null,
        checkoutKey: checkoutRouteKey(checkout),
        processId: null,
      })
    },
    [persistEditorCheckout, projectPath, session],
  )

  const handleCreateEditorWorktree = useCallback(
    async (input: { branch: string; baseRef?: string }): Promise<CheckoutSelection> => {
      const created = await createProjectSession({
        rootPath: projectPath,
        title: "Main",
        worktree: input,
      })
      const wt = created.createdWorktree
      if (!wt) throw new Error("Worktree was not created")
      return selectionFromPaths(projectPath, wt.path, wt.branch, wt.branch)
    },
    [projectPath],
  )

  const handleCreateWorktree = useCallback(
    async (input: { branch: string; baseRef?: string }): Promise<CheckoutSelection> => {
      const created = await createProjectSession({
        rootPath: projectPath,
        title: "Main",
        worktree: {
          branch: input.branch,
          baseRef: input.baseRef,
        },
      })
      const wt = created.createdWorktree
      if (!wt) throw new Error("Worktree was not created")
      const selection = selectionFromPaths(
        projectPath,
        wt.path,
        wt.branch,
        wt.branch,
      )
      const checkout = checkoutFromPaths(
        projectPath,
        selection.cwdPath,
        selection.title,
        selection.checkoutKey,
      )
      setActiveCheckout(checkout)
      persistChangesCheckout(checkout)
      await refreshWorktrees()
      if (!session) await onOpenSession(created.id)
      pushProjectRoute(location.pathname, {
        view,
        workspaceId: created.id,
        checkoutKey: checkoutRouteKey(checkout),
        processId: view === "running" ? focusAgentTabId : null,
      })
      return selection
    },
    [
      focusAgentTabId,
      onOpenSession,
      persistChangesCheckout,
      projectPath,
      refreshWorktrees,
      session,
      view,
    ],
  )

  const handleSelectAgent = useCallback(
    async (agent: HqAgentSummary) => {
      preferredSurfaceRef.current = "running"
      setFocusAgentTabId(agentFocusTabId(agent.sessionId))
      const muxReady = preloadMuxApp()
      await muxReady
      setView("running")
      await onOpenSession(agent.projectSessionId)
      const runId =
        "runId" in agent && typeof agent.runId === "string"
          ? agent.runId
          : agent.sessionId
      const selection = {
        workspaceId: agent.projectSessionId,
        checkoutKey: sameCheckoutPath(agent.cwdPath, projectPath)
          ? "main"
          : agent.cwdPath,
        checkoutPath: agent.cwdPath,
        processId: runId,
        runId,
      }
      setSurfaceSelections(current => ({
        ...current,
        running: selection,
      }))
      void saveProjectSurfaceState(projectId, "running", selection)
      pushProjectRoute(location.pathname, {
        view: "running",
        workspaceId: agent.projectSessionId,
        checkoutKey: selection.checkoutKey === "main" ? null : selection.checkoutKey,
        processId: runId,
      })
    },
    [onOpenSession, projectId, projectPath],
  )

  const handleLaunchAction = useCallback(
    async (action: MuxLaunchAction) => {
      launchSequenceRef.current += 1
      const request: MuxLaunchRequest = {
        id: `launch-${Date.now()}-${launchSequenceRef.current}`,
        action,
      }
      setLaunchRequest(request)
      const surface: MuxSurface =
        action.kind === "agent"
          ? "running"
          : action.kind === "editor"
            ? "editors"
            : "running"
      preferredSurfaceRef.current = surface
      try {
        await openSurface(surface)
      } catch (error) {
        setLaunchRequest(current => (current?.id === request.id ? null : current))
        showYaadeToast(
          error instanceof Error ? error.message : "Could not open the workspace.",
          { variant: "destructive" },
        )
      }
    },
    [openSurface],
  )

  const openAgentLaunch = useCallback(
    async (input: {
      requestId: string
      driverId: Extract<MuxLaunchAction, { kind: "agent" }>["driverId"]
      useWorktree?: boolean
      worktreeName?: string
      checkoutPath?: string
      checkoutKey?: string
      checkoutLabel?: string
    }) => {
      let checkoutPath = input.checkoutPath ?? projectPath
      let checkoutKey = input.checkoutKey ?? "main"

      preferredSurfaceRef.current = "running"
      try {
        if (input.useWorktree) {
          const branch =
            input.worktreeName?.trim() ||
            defaultAgentWorktreeName(input.driverId)
          const created = await createProjectSession({
            rootPath: projectPath,
            title: "Main",
            worktree: { branch },
          })
          const wt = created.createdWorktree
          if (!wt) throw new Error("Worktree was not created")
          checkoutPath = wt.path
          checkoutKey = wt.path
        }

        // Agents are project-scoped processes (same as terminals). Do not open a
        // mux session here — that stacks InstanceSidebar on ProjectWorkspaceSidebar.
        const api = window.yaade?.terminal
        if (!api) throw new Error("Terminal service unavailable")
        const instance = await api.createInstance({
          projectId,
          ...(session?.id ? { workspaceId: session.id } : {}),
          provider: input.driverId,
          launchRequestId: input.requestId,
          checkoutKey,
          checkoutPath,
          title: `${input.driverId.charAt(0).toUpperCase()}${input.driverId.slice(1)} agent`,
        })
        const processId = instance.id
        const selection = {
          workspaceId: session?.id ?? null,
          checkoutKey,
          checkoutPath,
          processId,
          runId: processId,
        }
        setSurfaceSelections(current => ({ ...current, running: selection }))
        void saveProjectSurfaceState(projectId, "running", selection)
        setFocusAgentTabId(agentFocusTabId(processId))
        clearHqAgentLaunch(input.requestId)
        setLaunchRequest(null)
        onAgentLaunchIntentHandled?.(input.requestId)
        setView("running")
        replaceProjectRoute(location.pathname, {
          view: "running",
          workspaceId: session?.id ?? null,
          checkoutKey: checkoutKey === "main" ? null : checkoutKey,
          processId,
        })
      } catch (error) {
        setLaunchRequest(current =>
          current?.id === input.requestId ? null : current,
        )
        throw error
      }
    },
    [onAgentLaunchIntentHandled, projectId, projectPath, session],
  )

  const handleLaunchRequestHandled = useCallback(
    (
      requestId: string,
      result?: { agentTabId?: string | null; agentRunId?: string | null },
    ) => {
      const launchedCheckout =
        launchRequest?.action.kind === "agent" ? launchRequest.action : null
      clearHqAgentLaunch(requestId)
      setLaunchRequest(current => (current?.id === requestId ? null : current))
      onAgentLaunchIntentHandled?.(requestId)
      if (result?.agentTabId) {
        setFocusAgentTabId(result.agentTabId)
        setView("running")
        preferredSurfaceRef.current = "running"
        const processId = result.agentRunId ?? result.agentTabId
        const selection = {
          workspaceId: session?.id ?? null,
          checkoutKey: launchedCheckout?.checkoutKey ?? "main",
          checkoutPath: launchedCheckout?.checkoutPath ?? projectPath,
          processId,
          runId: processId,
        }
        setSurfaceSelections(current => ({ ...current, running: selection }))
        void saveProjectSurfaceState(projectId, "running", selection)
        pushProjectRoute(location.pathname, {
          view: "running",
          workspaceId: session?.id ?? null,
          checkoutKey:
            launchedCheckout?.checkoutKey === "main"
              ? null
              : launchedCheckout?.checkoutKey ?? null,
          processId,
        })
      }
    },
    [
      launchRequest,
      onAgentLaunchIntentHandled,
      projectId,
      projectPath,
      session,
    ],
  )

  useEffect(() => {
    const queued = peekHqAgentLaunch(projectId)
    const intent =
      agentLaunchIntent ??
      (queued
        ? {
            id: queued.id,
            driverId: queued.driverId,
            useWorktree: queued.useWorktree,
            worktreeName: queued.worktreeName,
          }
        : null)
    if (!intent) return
    if (!claimHqAgentLaunch(intent.id)) {
      preferredSurfaceRef.current = "running"
      setView("running")
      return
    }

    let cancelled = false
    void openAgentLaunch({
      requestId: intent.id,
      driverId: intent.driverId,
      useWorktree: intent.useWorktree,
      worktreeName: intent.worktreeName,
    }).catch(error => {
      if (cancelled) return
      clearHqAgentLaunch(intent.id)
      onAgentLaunchIntentHandled?.(intent.id)
      showYaadeToast(
        error instanceof Error
          ? error.message
          : "Could not open the workspace for agent launch.",
        { variant: "destructive" },
      )
    })
    return () => {
      cancelled = true
    }
  }, [
    agentLaunchIntent,
    onAgentLaunchIntentHandled,
    openAgentLaunch,
    projectId,
  ])

  const handleRemoveWorktree = useCallback(
    async (input: { cwdPath: string; branch: string | null }) => {
      const confirmed = await requestConfirm({
        title: `Remove ${input.branch ?? "worktree"}?`,
        description:
          "YAADE will first verify that no live agents or terminals depend on it.",
        confirmLabel: "Remove worktree",
        cancelLabel: "Cancel",
        destructive: true,
      })
      if (!confirmed) return
      try {
        await removeProjectWorktree({
          rootPath: projectPath,
          worktreePath: input.cwdPath,
        })
        await refreshWorktrees()
        const checkout = mainCheckout(projectPath)
        setActiveCheckout(checkout)
        persistChangesCheckout(checkout)
        pushProjectRoute(location.pathname, {
          view,
          workspaceId: view === "editors" ? session?.id ?? null : null,
          checkoutKey: null,
        })
      } catch (error) {
        showYaadeToast(
          error instanceof Error ? error.message : "Could not remove worktree",
          { variant: "destructive" },
        )
        throw error
      }
    },
    [persistChangesCheckout, projectPath, refreshWorktrees, session, view],
  )

  const handleRemoveEditorWorktree = useCallback(
    async (input: { cwdPath: string; branch: string | null }) => {
      const confirmed = await requestConfirm({
        title: `Remove ${input.branch ?? "worktree"}?`,
        description:
          "YAADE will first verify that no live agents or terminals depend on it.",
        confirmLabel: "Remove worktree",
        cancelLabel: "Cancel",
        destructive: true,
      })
      if (!confirmed) return
      try {
        await removeProjectWorktree({
          rootPath: projectPath,
          worktreePath: input.cwdPath,
        })
        const checkout = mainCheckout(projectPath)
        persistEditorCheckout(checkout)
        pushProjectRoute(location.pathname, {
          view: "editors",
          workspaceId: session?.id ?? null,
          checkoutKey: null,
          processId: null,
        })
      } catch (error) {
        showYaadeToast(
          error instanceof Error ? error.message : "Could not remove worktree",
          { variant: "destructive" },
        )
        throw error
      }
    },
    [persistEditorCheckout, projectPath, session],
  )

  const ensureCheckoutSession = useCallback(
    async (surface: MuxSurface) => {
      await openSurface(surface)
    },
    [openSurface],
  )

  const processSidebar = useProjectProcessSidebar(
    projectId,
    activeCheckout.checkoutKey,
    activeCheckout.cwdPath,
  )

  const handleProcessSelect = useCallback(
    (
      processId: string | null,
      checkout?: { checkoutKey: string; checkoutPath: string },
    ) => {
      const selection = {
        ...surfaceSelections.running,
        processId,
        runId: processId,
        checkoutKey: checkout?.checkoutKey ?? activeCheckout.checkoutKey,
        checkoutPath: checkout?.checkoutPath ?? activeCheckout.cwdPath,
        workspaceId: session?.id ?? null,
      }
      setSurfaceSelections(current => ({ ...current, running: selection }))
      void saveProjectSurfaceState(projectId, "running", selection)
      preferredSurfaceRef.current = "running"
      setFocusAgentTabId(agentFocusTabId(processId))
      setView("running")
      replaceProjectRoute(location.pathname, {
        view: "running",
        // Keep an open mux session in the URL; otherwise stay process-scoped.
        workspaceId: session?.id ?? null,
        checkoutKey: checkout
          ? checkoutRouteKey(
              checkoutFromPaths(
                projectPath,
                checkout.checkoutPath,
                checkout.checkoutKey === "main" ? "Main" : checkout.checkoutKey,
                checkout.checkoutKey,
              ),
            )
          : checkoutRouteKey(activeCheckout),
        processId,
      })
    },
    [activeCheckout, projectId, projectPath, session, surfaceSelections.running],
  )

  const activeProcessId =
    projectRouteFromSearch().processId ??
    surfaceSelections.running?.processId ??
    surfaceSelections.running?.runId ??
    null

  const runningSidebarItems = useMemo<ProjectWorkspaceSidebarProcess[]>(
    () =>
      processSidebar.processes.map(instance => ({
        id: instance.id,
        label: instance.title,
        subtitle: `${instance.checkoutKey === "main" ? "Main" : instance.checkoutKey}`,
        icon: <AgentProviderIcon agent={instance.provider ?? "terminal"} />,
        selected: activeProcessId === instance.id,
        status: processStatusLabel(instance.processState),
        statusVariant: processStatusVariant(instance.processState),
        onSelect: () => handleProcessSelect(instance.id),
        onClose: () => void processSidebar.closeProcess(instance),
      })),
    [
      activeProcessId,
      handleProcessSelect,
      processSidebar.closeProcess,
      processSidebar.processes,
    ],
  )

  const gitHistoryWorktrees = useMemo<ProjectWorkspaceSidebarWorktree[]>(
    () => [
      {
        id: "main",
        label: "Main",
        subtitle: projectPath,
        selected: sameCheckoutPath(activeCheckout.cwdPath, projectPath),
        onSelect: () =>
          void handleSelectHistoryCheckout(
            selectionFromPaths(projectPath, projectPath, "Main"),
          ),
      },
      ...worktrees
        .filter(worktree => !sameCheckoutPath(worktree.path, projectPath))
        .map(worktree => {
          const branch = worktree.branch?.replace(/^refs\/heads\//, "") ?? null
          const label = projectWorktreeLabel(worktree)
          const selected = sameCheckoutPath(
            activeCheckout.cwdPath,
            worktree.path,
          )
          return {
            id: worktree.path,
            label,
            subtitle: worktree.path,
            selected,
            onSelect: () =>
              void handleSelectHistoryCheckout(
                selectionFromPaths(
                  projectPath,
                  worktree.path,
                  label,
                  branch,
                ),
              ),
            onRemove: selected
              ? () =>
                  void handleRemoveWorktree({
                    cwdPath: worktree.path,
                    branch,
                  })
              : undefined,
          }
        }),
    ],
    [
      activeCheckout.cwdPath,
      handleRemoveWorktree,
      handleSelectHistoryCheckout,
      projectPath,
      worktrees,
    ],
  )

  const handleCreateGitWorktree = useCallback(
    async (input: { branch: string; baseRef?: string }) => {
      const selection = await handleCreateWorktree(input)
      if (selection) await handleSelectHistoryCheckout(selection)
    },
    [handleCreateWorktree, handleSelectHistoryCheckout],
  )

  const createTerminalAtCheckout = useCallback(
    async (checkout: CheckoutSelection) => {
      try {
        const id = await processSidebar.createTerminal({
          checkoutKey: checkout.checkoutKey,
          checkoutPath: checkout.cwdPath,
          workspaceId: session?.id ?? null,
        })
        handleProcessSelect(id, {
          checkoutKey: checkout.checkoutKey,
          checkoutPath: checkout.cwdPath,
        })
      } catch (error) {
        showYaadeToast(
          error instanceof Error ? error.message : "Could not create terminal",
          { variant: "destructive" },
        )
      }
    },
    [handleProcessSelect, processSidebar.createTerminal, session],
  )

  const launchFromMenu = useCallback(
    (
      selection: ProcessLaunchSelection,
      checkout: CheckoutSelection,
    ) => {
      setProcessPickerOpen(false)
      if (selection.kind === "terminal") {
        void createTerminalAtCheckout(checkout)
        return
      }
      launchSequenceRef.current += 1
      const requestId = `launch-${Date.now()}-${launchSequenceRef.current}`
      void openAgentLaunch({
        requestId,
        driverId: selection.driver.id,
        useWorktree: false,
        checkoutPath: checkout.cwdPath,
        checkoutKey: checkout.checkoutKey,
        checkoutLabel: checkout.title,
      }).catch(error => {
        showYaadeToast(
          error instanceof Error ? error.message : "Could not launch the agent.",
          { variant: "destructive" },
        )
      })
    },
    [createTerminalAtCheckout, openAgentLaunch],
  )

  const processLauncher = (
    <ProcessLaunchMenu
      projectPath={projectPath}
      open={processPickerOpen}
      onOpenChange={setProcessPickerOpen}
      onLaunch={launchFromMenu}
      onCreateWorktree={handleCreateEditorWorktree}
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="New process"
          data-yaade-project-process-new="running"
        >
          <Plus />
        </Button>
      }
    />
  )

  const surface = surfaceForView(view)
  const checkoutRootUri = useMemo(
    () => pathToFileUri(activeCheckout.cwdPath),
    [activeCheckout.cwdPath],
  )

  return (
    <AppShell>
      <SidebarProvider
        className="h-full min-h-0"
        storageKey="yaade_project_sidebar_state"
        enableKeyboardShortcut
      >
        <ProjectWorkspaceSidebar
          projectName={projectName}
          gitHistoryWorktrees={gitHistoryWorktrees}
          gitHistoryLoading={worktreesLoading}
          gitHistoryError={worktreesError}
          onNewGitWorktree={() => setWorktreeCreateOpen(true)}
          processes={runningSidebarItems}
          onOpenHq={onOpenHq}
          onOpenSettings={() => {
            if (session) {
              window.dispatchEvent(new Event("yaade:open-settings"))
            } else {
              setSettingsOpen(true)
            }
          }}
          loading={processSidebar.loading}
          error={processSidebar.error}
          launcher={processLauncher}
          projectSwitcher={
            <OpenProjectOverlay
              open={projectSwitcherOpen}
              onOpenChange={setProjectSwitcherOpen}
              homeDir={homeDir}
              projects={hq.snapshot?.projects ?? []}
              selectedRootPath={projectPath}
              onOpenProject={project => onNavigateProject(project.rootPath)}
              onOpenPath={async rootPath => onNavigateProject(rootPath)}
              side="right"
              align="start"
              trigger={
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full max-w-none justify-start gap-1.5 px-1.5 text-left group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:[&>span]:hidden group-data-[collapsible=icon]:[&>svg:last-child]:hidden"
                  aria-label="Switch project"
                  title="Go to project"
                  data-yaade-project-switcher=""
                >
                  <FolderKanban data-icon="inline-start" />
                  <span className="truncate font-semibold">{projectName}</span>
                  <ChevronsUpDown
                    className="size-3 shrink-0 opacity-60"
                    aria-hidden
                  />
                </Button>
              }
            />
          }
        />
        <SidebarInset className="min-h-0 overflow-hidden">
          <div
            className="relative flex h-full min-h-0 w-full flex-col bg-background"
            data-yaade-shell="project"
            data-yaade-project-id={projectId}
            data-yaade-project-path={projectPath}
          >
          {/* Keep mux mounted so PTYs survive surface switches. */}
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <ProjectSurfaceSlot
              panel="history"
              active={view === "history"}
              mounted={historyMounted}
              fallback="Loading history…"
            >
              <ProjectGitSurface
                view="history"
                active={view === "history"}
                rootUri={checkoutRootUri}
                theme={activeTheme}
                activeCheckout={activeCheckout}
              />
            </ProjectSurfaceSlot>

            <ProjectSurfaceSlot
              panel="changes"
              active={view === "changes"}
              mounted={view === "changes"}
              fallback="Loading changes…"
            >
              <ProjectGitSurface
                view="changes"
                active
                rootUri={checkoutRootUri}
                theme={activeTheme}
                activeCheckout={activeCheckout}
              />
            </ProjectSurfaceSlot>

            {session && (view === "editors" || view === "running") ? (
              <ProjectSurfaceSlot
                panel={view}
                active
                fallback="Opening workspace…"
              >
                  <MuxApp
                    key={session.id}
                    session={session}
                    projectId={projectId}
                    projectName={projectName}
                    homeDir={homeDir}
                    machineHostname={machineHostname}
                    embedded
                    surface={view}
                    editorWorkspacePath={editorCheckout.cwdPath}
                    editorToolbar={
                      view === "editors" ? (
                        <CheckoutPicker
                          projectPath={projectPath}
                          homeDir={homeDir}
                          defaultBranch={defaultBranch}
                          activeLabel={editorCheckout.label}
                          activeCwdPath={editorCheckout.cwdPath}
                          onSelectCheckout={handleSelectEditorCheckout}
                          onCreateWorktree={handleCreateEditorWorktree}
                          onRemoveWorktree={handleRemoveEditorWorktree}
                          triggerClassName="h-6 rounded-md bg-transparent px-2 hover:bg-accent/70"
                        />
                      ) : undefined
                    }
                    focusAgentTabId={view === "running" ? focusAgentTabId : null}
                    onBackToProject={onClearSession}
                    onSelectAgentTab={tabId => {
                      preferredSurfaceRef.current = "running"
                      setFocusAgentTabId(tabId)
                      const runId = tabId.startsWith("yaade:terminal:")
                        ? tabId.slice("yaade:terminal:".length)
                        : tabId
                      pushProjectRoute(location.pathname, {
                        view: "running",
                        workspaceId: session?.id ?? null,
                        checkoutKey: checkoutRouteKey(activeCheckout),
                        processId: runId,
                      })
                    }}
                    onRequestSurface={next => {
                      if (next === "changes") {
                        setHistoryMounted(true)
                        setView("history")
                        pushProjectRoute(location.pathname, {
                          view: "history",
                          workspaceId: session?.id ?? null,
                          checkoutKey: checkoutRouteKey(activeCheckout),
                          processId: null,
                        })
                        return
                      }
                      if (next === "running") {
                        preferredSurfaceRef.current = "running"
                        setView("running")
                        pushProjectRoute(location.pathname, {
                          view: "running",
                          workspaceId: session.id,
                          checkoutKey: checkoutRouteKey(activeCheckout),
                          processId:
                            surfaceSelections.running?.processId ??
                            surfaceSelections.running?.runId ??
                            null,
                        })
                        return
                      }
                      void ensureCheckoutSession(next).catch(error => {
                        showYaadeToast(
                          error instanceof Error
                            ? error.message
                            : "Workspace unavailable",
                          { variant: "destructive" },
                        )
                      })
                    }}
                    launchRequest={launchRequest}
                    onLaunchRequestHandled={handleLaunchRequestHandled}
                  />
              </ProjectSurfaceSlot>
            ) : null}

            {!session && view === "running" ? (
              <ProjectSurfaceSlot panel="running" active fallback="Loading processes…">
                <RunningProjectSurface
                  projectId={projectId}
                  selectedId={
                    projectRouteFromSearch().processId ??
                    surfaceSelections.running?.processId ??
                    surfaceSelections.running?.runId ??
                    null
                  }
                  theme={activeTheme}
                  onSelect={id => handleProcessSelect(id)}
                />
              </ProjectSurfaceSlot>
            ) : null}

            {view === "editors" && !session ? (
              <ProjectSurfaceSlot
                panel="editors"
                active
                fallback="Loading workspace…"
                className="grid place-items-center"
              >
                <p className="max-w-sm px-4 text-center text-sm text-muted-foreground">
                  {routeError ?? (view === "editors"
                    ? "Open a file from the project…"
                    : "Launch a terminal in Main or a worktree…")}
                </p>
              </ProjectSurfaceSlot>
            ) : null}
          </div>

        </div>
        </SidebarInset>
      </SidebarProvider>

      {settingsOpen ? (
        <Suspense fallback={null}>
          <SettingsOverlay
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            settings={appearanceSettings}
            onSettingsChange={setAppearanceSettings}
            themes={bundledThemeList}
            onReset={resetAppearanceSettings}
          />
        </Suspense>
      ) : null}

      <CreateWorktreeDialog
        open={worktreeCreateOpen}
        onOpenChange={setWorktreeCreateOpen}
        projectPath={projectPath}
        homeDir={homeDir}
        defaultBranch={defaultBranch}
        onCreate={async input => {
          await handleCreateGitWorktree(input)
        }}
      />

      {!session ? <Toaster position="bottom-right" /> : null}
      {!session || view === "history" || view === "changes" ? (
        <ConfirmDialogHost />
      ) : null}
    </AppShell>
  )
}
