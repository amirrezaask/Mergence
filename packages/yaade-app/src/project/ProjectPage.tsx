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
import { pathToFileUri, type YaadeTheme } from "@yaade/shared"
import {
  isTerminalTabId,
  terminalTabId,
  type AgentRunInfo,
  type TerminalInstanceInfo,
} from "@yaade/workspace"
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
  type ProjectWorkspaceSidebarView,
} from "@yaade/ui"
import { bundledThemeList } from "@yaade/ui/appearance"
import {
  Button,
} from "@yaade/ui/primitives"
import { showYaadeToast, Toaster } from "@yaade/ui/toast"
import {
  Bot,
  ChevronDown,
  ChevronsUpDown,
  FolderKanban,
  GitBranch,
  Plus,
  SquareTerminal,
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
import {
  AgentsProjectSurface,
  TerminalsProjectSurface,
} from "./ProjectProcessSurfaces.js"
import {
  AgentLaunchMenu,
  TerminalLaunchMenu,
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
  return (
    view === "agents" ||
    view === "editors" ||
    view === "terminals"
  )
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
  projectPath,
  homeDir,
  defaultBranch,
  activeCheckout,
  onSelectCheckout,
  onCreateWorktree,
  onRemoveWorktree,
}: {
  view: "history" | "changes"
  active: boolean
  rootUri: string
  theme: YaadeTheme
  projectPath: string
  homeDir: string
  defaultBranch: string
  activeCheckout: ActiveCheckout
  onSelectCheckout: (checkout: CheckoutSelection) => void
  onCreateWorktree: (input: {
    branch: string
    baseRef?: string
  }) => Promise<CheckoutSelection | void>
  onRemoveWorktree: (input: {
    cwdPath: string
    branch: string | null
  }) => Promise<void>
}) {
  return (
    <GitWorkspace
      key={`${view}:${activeCheckout.cwdPath}`}
      rootUri={rootUri}
      theme={theme}
      initialView={view}
      unifiedHistory={view === "history"}
      active={active}
      toolbarStart={
        <CheckoutPicker
          projectPath={projectPath}
          homeDir={homeDir}
          defaultBranch={defaultBranch}
          activeLabel={activeCheckout.label}
          activeCwdPath={activeCheckout.cwdPath}
          onSelectCheckout={onSelectCheckout}
          onCreateWorktree={onCreateWorktree}
          onRemoveWorktree={onRemoveWorktree}
          triggerClassName="h-6 rounded-md bg-transparent px-2 hover:bg-accent/70"
        />
      }
      onOpenFile={() => undefined}
    />
  )
}

function agentFocusTabId(identity: string | null): string | null {
  if (!identity) return null
  return isTerminalTabId(identity) ? identity : terminalTabId(identity)
}

function processStatusVariant(
  status: AgentRunInfo["processState"] | TerminalInstanceInfo["processState"],
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "running") return "default"
  if (status === "starting" || status === "reserved") return "outline"
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
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
  const [terminalPickerOpen, setTerminalPickerOpen] = useState(false)
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
      return isSurfaceView(initialView) ? initialView : "terminals"
    })(),
  )
  const rootUri = useMemo(() => pathToFileUri(projectPath), [projectPath])
  const title = workspaceDocumentTitle(projectPath, homeDir)

  useEffect(() => {
    document.title = title
  }, [title])

  useEffect(() => {
    const route = projectRouteFromSearch()
    setView(route.view)
    if (route.view === "history") setHistoryMounted(true)
    if (route.view === "agents") {
      setSurfaceSelections(current => ({
        ...current,
        agents: { ...current.agents, runId: route.agentRunId },
      }))
    } else if (route.view === "terminals") {
      setSurfaceSelections(current => ({
        ...current,
        terminals: {
          ...current.terminals,
          terminalId: route.terminalInstanceId,
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
        next[row.surface] = {
          ...row.state,
          workspaceId:
            row.state.workspaceId && validWorkspaceIds.has(row.state.workspaceId)
              ? row.state.workspaceId
              : null,
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
    const runId = projectRouteFromSearch().agentRunId
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
      const preferred = preferredSurfaceRef.current ?? "terminals"
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
    preferredSurfaceRef.current = "agents"
    setFocusAgentTabId(agentFocusTabId(initialAgentFocusTabId))
    setView("agents")
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
        agentRunId: surface === "agents" ? focusAgentTabId : null,
      })
    },
    [ensureProjectSession, focusAgentTabId, projectId, surfaceSelections],
  )

  const handleSelectCheckout = useCallback(
    async (input: CheckoutSelection) => {
      const checkout = checkoutFromPaths(
        projectPath,
        input.cwdPath,
        input.title,
        input.checkoutKey,
      )
      setActiveCheckout(checkout)
      persistChangesCheckout(checkout)
      pushProjectRoute(location.pathname, {
        view,
        workspaceId: view === "editors" ? session?.id ?? null : null,
        checkoutKey: checkoutRouteKey(checkout),
        agentRunId: view === "agents" ? focusAgentTabId : null,
      })
    },
    [focusAgentTabId, persistChangesCheckout, projectPath, session, view],
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
        agentRunId: null,
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
      if (!session) await onOpenSession(created.id)
      pushProjectRoute(location.pathname, {
        view,
        workspaceId: created.id,
        checkoutKey: checkoutRouteKey(checkout),
        agentRunId: view === "agents" ? focusAgentTabId : null,
      })
      return selection
    },
    [focusAgentTabId, onOpenSession, persistChangesCheckout, projectPath, session, view],
  )

  const handleSelectAgent = useCallback(
    async (agent: HqAgentSummary) => {
      preferredSurfaceRef.current = "agents"
      setFocusAgentTabId(agentFocusTabId(agent.sessionId))
      const muxReady = preloadMuxApp()
      await muxReady
      setView("agents")
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
        runId,
      }
      setSurfaceSelections(current => ({
        ...current,
        agents: selection,
      }))
      void saveProjectSurfaceState(projectId, "agents", selection)
      pushProjectRoute(location.pathname, {
        view: "agents",
        workspaceId: agent.projectSessionId,
        checkoutKey: selection.checkoutKey === "main" ? null : selection.checkoutKey,
        agentRunId: runId,
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
          ? "agents"
          : action.kind === "editor"
            ? "editors"
            : "terminals"
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
      let checkoutLabel = input.checkoutLabel ?? "Main"
      let workspaceId = session?.id ?? null

      preferredSurfaceRef.current = "agents"
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
          checkoutLabel = wt.branch
          workspaceId = created.id
          if (!session) await onOpenSession(created.id)
          else if (session.id !== created.id) await onOpenSession(created.id)
        } else {
          workspaceId = (await ensureProjectSession()).id
        }

        const selection = {
          workspaceId,
          checkoutKey,
          checkoutPath,
        }
        setSurfaceSelections(current => ({ ...current, agents: selection }))
        void saveProjectSurfaceState(projectId, "agents", selection)

        const api = window.yaade?.agents
        if (!api || !workspaceId) throw new Error("Agent service unavailable")
        const launched = await api.launch({
          launchRequestId: input.requestId,
          provider: input.driverId,
          projectId,
          workspaceId,
          checkoutKey,
          checkoutPath,
          title: `${input.driverId.charAt(0).toUpperCase()}${input.driverId.slice(1)} agent`,
        })
        const runId = launched.run.runId
        const selected = { ...selection, runId }
        setSurfaceSelections(current => ({ ...current, agents: selected }))
        void saveProjectSurfaceState(projectId, "agents", selected)
        setFocusAgentTabId(agentFocusTabId(runId))
        clearHqAgentLaunch(input.requestId)
        setLaunchRequest(null)
        onAgentLaunchIntentHandled?.(input.requestId)
        setView("agents")
        pushProjectRoute(location.pathname, {
          view: "agents",
          workspaceId: null,
          checkoutKey: checkoutKey === "main" ? null : checkoutKey,
          agentRunId: runId,
        })
      } catch (error) {
        setLaunchRequest(current =>
          current?.id === input.requestId ? null : current,
        )
        throw error
      }
    },
    [
      ensureProjectSession,
      onAgentLaunchIntentHandled,
      onOpenSession,
      projectId,
      projectPath,
      session,
    ],
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
        setView("agents")
        preferredSurfaceRef.current = "agents"
        const selection = {
          workspaceId: session?.id ?? null,
          checkoutKey: launchedCheckout?.checkoutKey ?? "main",
          checkoutPath: launchedCheckout?.checkoutPath ?? projectPath,
          runId: result.agentRunId ?? result.agentTabId,
        }
        setSurfaceSelections(current => ({ ...current, agents: selection }))
        void saveProjectSurfaceState(projectId, "agents", selection)
        pushProjectRoute(location.pathname, {
          view: "agents",
          workspaceId: session?.id ?? null,
          checkoutKey:
            launchedCheckout?.checkoutKey === "main"
              ? null
              : launchedCheckout?.checkoutKey ?? null,
          agentRunId: result.agentRunId ?? result.agentTabId,
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
      preferredSurfaceRef.current = "agents"
      setView("agents")
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
    [persistChangesCheckout, projectPath, session, view],
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
          agentRunId: null,
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

  const handleViewSelect = useCallback(
    (next: ProjectView) => {
      if (next === "history") setHistoryMounted(true)
      if (next === "agents" || next === "terminals") {
        preferredSurfaceRef.current = next
        setView(next)
        const saved = surfaceSelections[next]
        pushProjectRoute(location.pathname, {
          view: next,
          workspaceId: null,
          checkoutKey: saved?.checkoutKey ?? checkoutRouteKey(activeCheckout),
          agentRunId: next === "agents" ? saved?.runId ?? null : null,
          terminalInstanceId: next === "terminals" ? saved?.terminalId ?? null : null,
        })
        return
      }
      if (next === "editors") {
        preferredSurfaceRef.current = next
        void ensureCheckoutSession(next).catch(error => {
          showYaadeToast(
            error instanceof Error ? error.message : "Workspace unavailable",
            { variant: "destructive" },
          )
        })
        return
      }
      setView(next)
      pushProjectRoute(location.pathname, {
        view: next,
        workspaceId: null,
        checkoutKey: checkoutRouteKey(activeCheckout),
        agentRunId: null,
      })
    },
    [activeCheckout, ensureCheckoutSession, surfaceSelections],
  )

  const handleAgentSelect = useCallback(
    (runId: string | null) => {
      setSurfaceSelections(current => ({
        ...current,
        agents: { ...current.agents, runId },
      }))
      void saveProjectSurfaceState(projectId, "agents", {
        ...surfaceSelections.agents,
        runId,
      })
      preferredSurfaceRef.current = "agents"
      setView("agents")
      replaceProjectRoute(location.pathname, {
        view: "agents",
        workspaceId: null,
        checkoutKey: surfaceSelections.agents?.checkoutKey ?? checkoutRouteKey(activeCheckout),
        agentRunId: runId,
      })
    },
    [activeCheckout, projectId, surfaceSelections.agents],
  )

  const handleTerminalSelect = useCallback(
    (
      terminalId: string | null,
      checkout?: { checkoutKey: string; checkoutPath: string },
    ) => {
      const selection = {
        ...surfaceSelections.terminals,
        terminalId,
        checkoutKey: checkout?.checkoutKey ?? activeCheckout.checkoutKey,
        checkoutPath: checkout?.checkoutPath ?? activeCheckout.cwdPath,
      }
      setSurfaceSelections(current => ({ ...current, terminals: selection }))
      void saveProjectSurfaceState(projectId, "terminals", selection)
      preferredSurfaceRef.current = "terminals"
      setView("terminals")
      replaceProjectRoute(location.pathname, {
        view: "terminals",
        workspaceId: null,
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
        terminalInstanceId: terminalId,
      })
    },
    [activeCheckout, projectId, projectPath, surfaceSelections.terminals],
  )

  const activeAgentId =
    projectRouteFromSearch().agentRunId ?? surfaceSelections.agents?.runId ?? null
  const activeTerminalId =
    projectRouteFromSearch().terminalInstanceId ?? surfaceSelections.terminals?.terminalId ?? null

  const agentSidebarItems = useMemo<ProjectWorkspaceSidebarProcess[]>(
    () =>
      processSidebar.agents.map(run => ({
        id: run.runId,
        label: run.title,
        subtitle: `${run.checkoutKey === "main" ? "Main" : run.checkoutKey}`,
        icon: <Bot aria-hidden />,
        selected: activeAgentId === run.runId,
        status: processStatusLabel(run.processState),
        statusVariant: processStatusVariant(run.processState),
        onSelect: () => handleAgentSelect(run.runId),
        onClose: () => void processSidebar.closeAgent(run),
      })),
    [activeAgentId, handleAgentSelect, processSidebar.agents, processSidebar.closeAgent],
  )

  const terminalSidebarItems = useMemo<ProjectWorkspaceSidebarProcess[]>(
    () =>
      processSidebar.terminals.map(instance => ({
        id: instance.id,
        label: instance.title,
        subtitle: `${instance.checkoutKey === "main" ? "Main" : instance.checkoutKey}`,
        icon: <SquareTerminal aria-hidden />,
        selected: activeTerminalId === instance.id,
        status: processStatusLabel(instance.processState),
        statusVariant: processStatusVariant(instance.processState),
        onSelect: () => handleTerminalSelect(instance.id),
        onClose: () => void processSidebar.closeTerminal(instance),
      })),
    [activeTerminalId, handleTerminalSelect, processSidebar.closeTerminal, processSidebar.terminals],
  )

  const projectViews = useMemo<ProjectWorkspaceSidebarView[]>(
    () => [
      { id: "history", label: "Git history", icon: <GitBranch aria-hidden />, selected: view === "history", onSelect: () => handleViewSelect("history") },
    ],
    [handleViewSelect, view],
  )

  const createTerminal = useCallback(async () => {
    try {
      const id = await processSidebar.createTerminal()
      handleTerminalSelect(id)
    } catch (error) {
      showYaadeToast(error instanceof Error ? error.message : "Could not create terminal", {
        variant: "destructive",
      })
    }
  }, [handleTerminalSelect, processSidebar.createTerminal])

  const createTerminalAtCheckout = useCallback(
    async (checkout: CheckoutSelection) => {
      try {
        const id = await processSidebar.createTerminal({
          checkoutKey: checkout.checkoutKey,
          checkoutPath: checkout.cwdPath,
        })
        handleTerminalSelect(id, {
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
    [handleTerminalSelect, processSidebar.createTerminal],
  )

  const launchAgentFromMenu = useCallback(
    (
      driverId: Extract<MuxLaunchAction, { kind: "agent" }>["driverId"],
      checkout: CheckoutSelection,
    ) => {
      setAgentPickerOpen(false)
      launchSequenceRef.current += 1
      const requestId = `launch-${Date.now()}-${launchSequenceRef.current}`
      void openAgentLaunch({
        requestId,
        driverId,
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
    [openAgentLaunch],
  )

  const agentLauncher = (
    <AgentLaunchMenu
      projectPath={projectPath}
      open={agentPickerOpen}
      onOpenChange={setAgentPickerOpen}
      onLaunch={(driver, checkout) => launchAgentFromMenu(driver.id, checkout)}
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="New agent"
          data-yaade-project-process-new="agents"
          data-yaade-instance-sidebar-new=""
        >
          <Plus />
        </Button>
      }
    />
  )

  const terminalLauncher = (
    <TerminalLaunchMenu
      projectPath={projectPath}
      open={terminalPickerOpen}
      onOpenChange={setTerminalPickerOpen}
      onSelect={createTerminalAtCheckout}
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="New terminal"
          data-yaade-project-process-new="terminals"
          data-yaade-instance-sidebar-new=""
        >
          <ChevronDown />
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
          views={projectViews}
          agents={agentSidebarItems}
          terminals={terminalSidebarItems}
          onOpenHq={onOpenHq}
          onNewAgent={() => setAgentPickerOpen(true)}
          onNewTerminal={() => void createTerminal()}
          agentLoading={processSidebar.agentLoading}
          terminalLoading={processSidebar.terminalLoading}
          agentError={processSidebar.agentError}
          terminalError={processSidebar.terminalError}
          agentLauncher={agentLauncher}
          terminalLauncher={terminalLauncher}
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
                projectPath={projectPath}
                homeDir={homeDir}
                defaultBranch={defaultBranch}
                activeCheckout={activeCheckout}
                onSelectCheckout={handleSelectCheckout}
                onCreateWorktree={handleCreateWorktree}
                onRemoveWorktree={handleRemoveWorktree}
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
                projectPath={projectPath}
                homeDir={homeDir}
                defaultBranch={defaultBranch}
                activeCheckout={activeCheckout}
                onSelectCheckout={handleSelectCheckout}
                onCreateWorktree={handleCreateWorktree}
                onRemoveWorktree={handleRemoveWorktree}
              />
            </ProjectSurfaceSlot>

            {session && view === "editors" ? (
              <ProjectSurfaceSlot
                panel="editors"
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
                    surface="editors"
                    editorWorkspacePath={editorCheckout.cwdPath}
                    editorToolbar={
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
                    }
                    focusAgentTabId={null}
                    onBackToProject={onClearSession}
                    onLaunchAgent={() => setAgentPickerOpen(true)}
                    onSelectAgentTab={tabId => {
                      preferredSurfaceRef.current = "agents"
                      setFocusAgentTabId(tabId)
                      const runId = tabId.startsWith("yaade:terminal:")
                        ? tabId.slice("yaade:terminal:".length)
                        : tabId
                      pushProjectRoute(location.pathname, {
                        view: "agents",
                        workspaceId: session?.id ?? null,
                        checkoutKey: checkoutRouteKey(activeCheckout),
                        agentRunId: runId,
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
                          agentRunId: null,
                        })
                        return
                      }
                      if (next === "agents" || next === "terminals") {
                        setView(next)
                        pushProjectRoute(location.pathname, {
                          view: next,
                          workspaceId: null,
                          checkoutKey: checkoutRouteKey(activeCheckout),
                          agentRunId: next === "agents" ? surfaceSelections.agents?.runId ?? null : null,
                          terminalInstanceId: next === "terminals"
                            ? surfaceSelections.terminals?.terminalId ?? null
                            : null,
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

            {view === "agents" ? (
              <ProjectSurfaceSlot panel="agents" active fallback="Loading agents…">
                <AgentsProjectSurface
                  projectId={projectId}
                  selectedId={
                    projectRouteFromSearch().agentRunId ??
                    surfaceSelections.agents?.runId ??
                    null
                  }
                  theme={activeTheme}
                  onSelect={handleAgentSelect}
                />
              </ProjectSurfaceSlot>
            ) : null}

            {view === "terminals" ? (
              <ProjectSurfaceSlot panel="terminals" active fallback="Loading terminals…">
                <TerminalsProjectSurface
                  projectId={projectId}
                  selectedId={
                    projectRouteFromSearch().terminalInstanceId ??
                    surfaceSelections.terminals?.terminalId ??
                    null
                  }
                  theme={activeTheme}
                  onSelect={handleTerminalSelect}
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

      {!session ? <Toaster position="bottom-right" /> : null}
      {!session ? <ConfirmDialogHost /> : null}
    </AppShell>
  )
}
