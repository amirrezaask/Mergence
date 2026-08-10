import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type {
  HqAgentSummary,
  ProjectSession,
} from "@yaade/rpc"
import { pathToFileUri } from "@yaade/shared"
import { isTerminalTabId, terminalTabId, type AgentRunInfo } from "@yaade/workspace"
import {
  AppShell,
  cn,
} from "@yaade/ui/project"
import { ConfirmDialogHost, requestConfirm } from "@yaade/ui"
import { bundledThemeList } from "@yaade/ui/appearance"
import {
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@yaade/ui/primitives"
import { showYaadeToast, Toaster } from "@yaade/ui/toast"
import { NotificationBell } from "@yaade/ui/notifications"
import { ChevronsUpDown, FolderKanban, House, SettingsIcon } from "lucide-react"
import { useAppearanceSettings } from "../hooks/useAppearanceSettings.js"
import { useHqOverview } from "../hooks/useHqOverview.js"
import { useSystemSignals } from "../system-signals/SystemSignalsProvider.js"
import { preloadMuxApp } from "../mux/preload.js"
import type {
  MuxLaunchAction,
  MuxLaunchRequest,
  MuxSurface,
} from "../mux/MuxApp.js"
import {
  projectRouteFromSearch,
  pushProjectRoute,
  type ProjectView,
  workspaceDocumentTitle,
} from "../url-workspace.js"
import {
  createProjectSession,
  deleteProjectSession,
  listProjectSessions,
  openCheckoutSession,
} from "../project-session-client.js"
import {
  loadProjectSurfaceState,
  saveProjectSurfaceState,
  type ProjectSurfaceSelection,
} from "../project-surface-state-client.js"
import {
  clearHqAgentLaunch,
  peekHqAgentLaunch,
} from "./hq-agent-launch.js"
import { OpenProjectOverlay } from "./OpenProjectOverlay.js"
import { sameCheckoutPath, WorktreeSwitcher } from "./WorktreeSwitcher.js"

const GitWorkspace = lazy(() =>
  import("@yaade/ui/git").then(m => ({ default: m.GitWorkspace })),
)
const AgentCliPickerOverlay = lazy(() =>
  import("@yaade/ui/agent-picker").then(m => ({
    default: m.AgentCliPickerOverlay,
  })),
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
  /** Active session — surface workspace renders in-page when set. */
  session: ProjectSession | null
  /** One-shot launch requested from HQ before navigating into this project. */
  agentLaunchIntent?: {
    id: string
    driverId: Extract<MuxLaunchAction, { kind: "agent" }>["driverId"]
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

function agentFocusTabId(identity: string | null): string | null {
  if (!identity) return null
  return isTerminalTabId(identity) ? identity : terminalTabId(identity)
}

export function ProjectPage({
  projectId,
  projectName,
  projectPath,
  homeDir,
  machineHostname,
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
  const notifications = useSystemSignals()
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
  const [openProjectOpen, setOpenProjectOpen] = useState(false)
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
  const [defaultBranch, setDefaultBranch] = useState("main")
  const [focusAgentTabId, setFocusAgentTabId] = useState<string | null>(
    agentFocusTabId(initialAgentFocusTabId),
  )
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
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
    setDefaultBranch("main")
    setActiveCheckout(mainCheckout(projectPath))
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
          const selected = sessions.find(
            item =>
              !item.archivedAt &&
              (item.checkoutKey === row.state.checkoutKey ||
                item.cwdPath === row.state.checkoutPath),
          )
          next.changes = selected
            ? {
                checkoutKey: selected.checkoutKey,
                checkoutPath: selected.cwdPath,
              }
            : { checkoutKey: "main", checkoutPath: projectPath }
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
      const routeCheckout = route.checkoutKey
        ? sessions.find(
            item =>
              !item.archivedAt &&
              (item.checkoutKey === route.checkoutKey ||
                item.cwdPath === route.checkoutKey),
          )
        : null
      if (routeCheckout) {
        setActiveCheckout(
          checkoutFromPaths(
            projectPath,
            routeCheckout.cwdPath,
            routeCheckout.worktreeBranch ?? routeCheckout.title,
            routeCheckout.checkoutKey,
          ),
        )
        return
      }
      if (route.checkoutKey === "main") {
        setActiveCheckout(mainCheckout(projectPath))
        return
      }

      const savedCheckout =
        next.changes?.checkoutPath ??
        next.editors?.checkoutPath ??
        next.terminals?.checkoutPath ??
        next.agents?.checkoutPath
      if (savedCheckout) {
        const summary = sessions.find(item => item.cwdPath === savedCheckout)
        setActiveCheckout(
          checkoutFromPaths(
            projectPath,
            savedCheckout,
            summary?.worktreeBranch ?? summary?.title,
            summary?.checkoutKey ??
              next.changes?.checkoutKey ??
              next.editors?.checkoutKey ??
              next.terminals?.checkoutKey ??
              next.agents?.checkoutKey,
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
  useEffect(() => {
    if (session) {
      const preferred = preferredSurfaceRef.current ?? "terminals"
      setView(current =>
        current === "history" || current === "changes" ? preferred : current,
      )
      const checkout = checkoutFromPaths(
        projectPath,
        session.cwdPath,
        session.worktreeBranch ?? session.title,
        session.checkoutKey,
      )
      setActiveCheckout(checkout)
      const selection = {
        workspaceId: session.id,
        checkoutKey: checkout.checkoutKey,
        checkoutPath: checkout.cwdPath,
      }
      setSurfaceSelections(current => ({
        ...current,
        [preferred]: {
          ...current[preferred],
          ...selection,
        },
        changes: {
          checkoutKey: checkout.checkoutKey,
          checkoutPath: checkout.cwdPath,
        },
      }))
      void saveProjectSurfaceState(projectId, preferred, selection)
      void saveProjectSurfaceState(projectId, "changes", {
        checkoutKey: checkout.checkoutKey,
        checkoutPath: checkout.cwdPath,
      })
    } else {
      preferredSurfaceRef.current = null
    }
  }, [projectId, projectPath, session?.id]) // eslint-disable-line react-hooks/exhaustive-deps -- session identity only

  useEffect(() => {
    if (!initialAgentFocusTabId) return
    preferredSurfaceRef.current = "agents"
    setFocusAgentTabId(agentFocusTabId(initialAgentFocusTabId))
    setView("agents")
    onInitialAgentFocusHandled?.()
  }, [initialAgentFocusTabId, onInitialAgentFocusHandled])

  const persistCheckout = useCallback(
    (checkout: ActiveCheckout, workspaceId?: string | null) => {
      const selection = {
        workspaceId: workspaceId ?? null,
        checkoutKey: checkout.checkoutKey,
        checkoutPath: checkout.cwdPath,
      }
      setSurfaceSelections(current => ({
        ...current,
        changes: {
          checkoutKey: checkout.checkoutKey,
          checkoutPath: checkout.cwdPath,
        },
        agents: { ...current.agents, ...selection, runId: current.agents?.runId },
        editors: { ...current.editors, ...selection },
        terminals: { ...current.terminals, ...selection },
      }))
      void saveProjectSurfaceState(projectId, "changes", {
        checkoutKey: checkout.checkoutKey,
        checkoutPath: checkout.cwdPath,
      })
      for (const surface of [
        "agents",
        "editors",
        "terminals",
      ] as const) {
        void saveProjectSurfaceState(projectId, surface, {
          ...selection,
          runId: surface === "agents" ? focusAgentTabId : undefined,
        })
      }
    },
    [focusAgentTabId, projectId],
  )

  const openCheckoutForSurface = useCallback(
    async (
      surface: MuxSurface,
      input: {
        cwdPath: string
        title?: string
        worktreeBranch?: string | null
        worktreePath?: string | null
      },
    ) => {
      preferredSurfaceRef.current = surface
      const muxReady = preloadMuxApp()
      const next = await openCheckoutSession({
        rootPath: projectPath,
        cwdPath: input.cwdPath,
        title: input.title,
        worktreeBranch: input.worktreeBranch,
        worktreePath: input.worktreePath,
      })
      await muxReady
      const checkout = checkoutFromPaths(
        projectPath,
        next.cwdPath,
        next.worktreeBranch ?? input.title ?? next.title,
        next.checkoutKey,
      )
      setActiveCheckout(checkout)
      setView(surface)
      await onOpenSession(next.id)
      persistCheckout(checkout, next.id)
      pushProjectRoute(location.pathname, {
        view: surface,
        workspaceId: next.id,
        checkoutKey: checkoutRouteKey(checkout),
        agentRunId: surface === "agents" ? focusAgentTabId : null,
      })
    },
    [focusAgentTabId, onOpenSession, persistCheckout, projectPath],
  )

  const handleSelectCheckout = useCallback(
    async (input: {
      cwdPath: string
      title?: string
      worktreeBranch?: string | null
      worktreePath?: string | null
    }) => {
      const checkout = checkoutFromPaths(
        projectPath,
        input.cwdPath,
        input.worktreeBranch ?? input.title,
        sameCheckoutPath(input.cwdPath, projectPath) ? "main" : input.cwdPath,
      )
      setActiveCheckout(checkout)
      persistCheckout(checkout, session?.id)
      try {
        if (isSurfaceView(view)) {
          await openCheckoutForSurface(view, input)
          return
        }
        pushProjectRoute(location.pathname, {
          view,
          checkoutKey: checkoutRouteKey(checkout),
          agentRunId: null,
        })
      } catch (error) {
        showYaadeToast(
          error instanceof Error ? error.message : "Could not open the workspace.",
          { variant: "destructive" },
        )
      }
    },
    [
      openCheckoutForSurface,
      persistCheckout,
      projectPath,
      session,
      view,
    ],
  )

  const handleCreateWorktree = useCallback(
    async (input: { branch: string; baseRef?: string }) => {
      try {
        const created = await createProjectSession({
          rootPath: projectPath,
          title: input.branch,
          worktree: {
            branch: input.branch,
            baseRef: input.baseRef,
          },
        })
        const checkout = checkoutFromPaths(
          projectPath,
          created.cwdPath,
          created.worktreeBranch ?? created.title,
          created.checkoutKey,
        )
        setActiveCheckout(checkout)
        persistCheckout(checkout, created.id)
        if (isSurfaceView(view)) {
          preferredSurfaceRef.current = view
          await preloadMuxApp()
          setView(view)
          await onOpenSession(created.id)
          pushProjectRoute(location.pathname, {
            view,
            workspaceId: created.id,
            checkoutKey: checkoutRouteKey(checkout),
            agentRunId: view === "agents" ? focusAgentTabId : null,
          })
          return
        }
        pushProjectRoute(location.pathname, {
          view,
          checkoutKey: checkoutRouteKey(checkout),
        })
      } catch (error) {
        showYaadeToast(
          error instanceof Error
            ? error.message
            : "Could not create the worktree.",
          { variant: "destructive" },
        )
      }
    },
    [focusAgentTabId, onOpenSession, persistCheckout, projectPath, view],
  )

  const handleSelectAgent = useCallback(
    async (agent: HqAgentSummary) => {
      preferredSurfaceRef.current = "agents"
      setFocusAgentTabId(agentFocusTabId(agent.sessionId))
      const muxReady = preloadMuxApp()
      await muxReady
      const checkout = checkoutFromPaths(
        projectPath,
        agent.cwdPath,
        agent.worktreeBranch,
        sameCheckoutPath(agent.cwdPath, projectPath) ? "main" : agent.cwdPath,
      )
      setActiveCheckout(checkout)
      setView("agents")
      await onOpenSession(agent.projectSessionId)
      const runId =
        "runId" in agent && typeof agent.runId === "string"
          ? agent.runId
          : agent.sessionId
      persistCheckout(checkout, agent.projectSessionId)
      setSurfaceSelections(current => ({
        ...current,
        agents: {
          workspaceId: agent.projectSessionId,
          checkoutKey: checkout.checkoutKey,
          checkoutPath: checkout.cwdPath,
          runId,
        },
      }))
      void saveProjectSurfaceState(projectId, "agents", {
        workspaceId: agent.projectSessionId,
        checkoutKey: checkout.checkoutKey,
        checkoutPath: checkout.cwdPath,
        runId,
      })
      pushProjectRoute(location.pathname, {
        view: "agents",
        workspaceId: agent.projectSessionId,
        checkoutKey: checkoutRouteKey(checkout),
        agentRunId: runId,
      })
    },
    [onOpenSession, persistCheckout, projectId, projectPath],
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
        if (session && sameCheckoutPath(session.cwdPath, activeCheckout.cwdPath)) {
          setView(surface)
          return
        }
        await openCheckoutForSurface(surface, {
          cwdPath: activeCheckout.cwdPath,
          title: activeCheckout.label,
          worktreeBranch:
            activeCheckout.checkoutKey === "main" ? null : activeCheckout.label,
          worktreePath:
            activeCheckout.checkoutKey === "main" ? null : activeCheckout.cwdPath,
        })
      } catch (error) {
        setLaunchRequest(current => (current?.id === request.id ? null : current))
        showYaadeToast(
          error instanceof Error ? error.message : "Could not open the workspace.",
          { variant: "destructive" },
        )
      }
    },
    [activeCheckout, openCheckoutForSurface, session],
  )

  const handleLaunchRequestHandled = useCallback(
    (
      requestId: string,
      result?: { agentTabId?: string | null; agentRunId?: string | null },
    ) => {
      clearHqAgentLaunch(requestId)
      setLaunchRequest(current => (current?.id === requestId ? null : current))
      onAgentLaunchIntentHandled?.(requestId)
      if (result?.agentTabId) {
        setFocusAgentTabId(result.agentTabId)
        setView("agents")
        preferredSurfaceRef.current = "agents"
        const selection = {
          workspaceId: session?.id ?? null,
          checkoutKey: activeCheckout.checkoutKey,
          checkoutPath: activeCheckout.cwdPath,
          runId: result.agentRunId ?? result.agentTabId,
        }
        setSurfaceSelections(current => ({ ...current, agents: selection }))
        void saveProjectSurfaceState(projectId, "agents", selection)
        pushProjectRoute(location.pathname, {
          view: "agents",
          workspaceId: session?.id ?? null,
          checkoutKey: checkoutRouteKey(activeCheckout),
          agentRunId: result.agentRunId ?? result.agentTabId,
        })
      }
    },
    [activeCheckout, onAgentLaunchIntentHandled, projectId, session],
  )

  // HQ launch intents must survive StrictMode remounts. Keep the stable intent
  // id on `launchRequest` and only clear after Mux confirms the pane opened.
  useEffect(() => {
    const queued = peekHqAgentLaunch(projectId)
    const intent =
      agentLaunchIntent ??
      (queued
        ? { id: queued.id, driverId: queued.driverId }
        : null)
    if (!intent) return

    preferredSurfaceRef.current = "agents"
    setLaunchRequest({
      id: intent.id,
      action: { kind: "agent", driverId: intent.driverId },
    })

    if (session && sameCheckoutPath(session.cwdPath, activeCheckout.cwdPath)) {
      setView("agents")
      return
    }

    let cancelled = false
    void openCheckoutForSurface("agents", {
      cwdPath: activeCheckout.cwdPath,
      title: activeCheckout.label,
      worktreeBranch:
        activeCheckout.checkoutKey === "main" ? null : activeCheckout.label,
      worktreePath:
        activeCheckout.checkoutKey === "main" ? null : activeCheckout.cwdPath,
    }).catch(error => {
      if (cancelled) return
      clearHqAgentLaunch(intent.id)
      setLaunchRequest(current =>
        current?.id === intent.id ? null : current,
      )
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
    activeCheckout,
    agentLaunchIntent,
    onAgentLaunchIntentHandled,
    openCheckoutForSurface,
    projectId,
    session,
  ])

  const handleRemoveWorktree = useCallback(
    async (input: { cwdPath: string; branch: string | null }) => {
      const confirmed = await requestConfirm({
        title: `Remove ${input.branch ?? "worktree"}?`,
        description:
          "YAADE will first verify that no live agents, terminals, or dirty editors depend on it.",
        confirmLabel: "Remove worktree",
        cancelLabel: "Cancel",
        destructive: true,
      })
      if (!confirmed) return
      try {
        const sessions = await listProjectSessions(projectPath)
        const workspace = sessions.find(
          item => !item.archivedAt && item.cwdPath === input.cwdPath,
        )
        if (!workspace) throw new Error("Canonical worktree workspace was not found")
        await deleteProjectSession(workspace.id, { removeWorktree: true })
        const checkout = mainCheckout(projectPath)
        setActiveCheckout(checkout)
        persistCheckout(checkout)
        if (isSurfaceView(view) || session) {
          await openCheckoutForSurface(
            isSurfaceView(view) ? view : preferredSurfaceRef.current ?? "terminals",
            { cwdPath: projectPath, title: "Main" },
          )
        } else {
          pushProjectRoute(location.pathname, {
            view,
            checkoutKey: null,
          })
        }
      } catch (error) {
        showYaadeToast(
          error instanceof Error ? error.message : "Could not remove worktree",
          { variant: "destructive" },
        )
        throw error
      }
    },
    [openCheckoutForSurface, persistCheckout, projectPath, session, view],
  )

  const ensureCheckoutSession = useCallback(
    async (surface: MuxSurface) => {
      if (session && sameCheckoutPath(session.cwdPath, activeCheckout.cwdPath)) {
        setView(surface)
        pushProjectRoute(location.pathname, {
          view: surface,
          workspaceId: session.id,
          checkoutKey: checkoutRouteKey(activeCheckout),
          agentRunId: surface === "agents" ? focusAgentTabId : null,
        })
        return
      }
      await openCheckoutForSurface(surface, {
        cwdPath: activeCheckout.cwdPath,
        title: activeCheckout.label,
        worktreeBranch:
          activeCheckout.checkoutKey === "main" ? null : activeCheckout.label,
        worktreePath:
          activeCheckout.checkoutKey === "main" ? null : activeCheckout.cwdPath,
      })
    },
    [activeCheckout, focusAgentTabId, openCheckoutForSurface, session],
  )

  const surface = surfaceForView(view)
  const muxSurface: MuxSurface =
    surface ?? preferredSurfaceRef.current ?? "terminals"
  const checkoutRootUri = useMemo(
    () => pathToFileUri(activeCheckout.cwdPath),
    [activeCheckout.cwdPath],
  )

  return (
    <AppShell>
      <div
        className="flex h-full min-h-0 w-full flex-col bg-background"
        data-yaade-shell="project"
        data-yaade-project-path={projectPath}
      >
        <Tabs
          value={view}
          onValueChange={value => {
            const next = value as ProjectView
            if (next === "history") setHistoryMounted(true)
            if (isSurfaceView(next)) {
              preferredSurfaceRef.current = next
              const saved = surfaceSelections[next]
              if (next === "agents") {
                setFocusAgentTabId(agentFocusTabId(saved?.runId ?? null))
              }
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
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <header
            className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto border-b border-border px-3 sm:px-4"
            data-yaade-app-header=""
          >
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Open HQ"
              onClick={onOpenHq}
            >
              <House />
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="max-w-56 justify-start"
              aria-label="Switch project"
              data-yaade-project-switcher=""
              onClick={() => setOpenProjectOpen(true)}
            >
              <FolderKanban data-icon="inline-start" />
              <span className="truncate font-semibold">{projectName}</span>
              <ChevronsUpDown className="size-3 opacity-60" aria-hidden />
            </Button>
            <div className="flex h-8 shrink-0 items-center gap-1.5">
              <TabsList className="h-7 gap-0.5 rounded-md bg-secondary/60 p-0.5">
                <TabsTrigger
                  value="changes"
                  data-yaade-project-tab="changes"
                  className="w-[4.5rem] flex-none px-2 text-xs after:inset-y-1 after:right-auto after:bottom-auto after:left-0 after:h-auto after:w-0.5 data-[state=active]:after:opacity-100"
                >
                  Changes
                </TabsTrigger>
                <TabsTrigger
                  value="agents"
                  data-yaade-project-tab="agents"
                  className="w-[4.25rem] flex-none px-2 text-xs after:inset-y-1 after:right-auto after:bottom-auto after:left-0 after:h-auto after:w-0.5 data-[state=active]:after:opacity-100"
                >
                  Agents
                </TabsTrigger>
                <TabsTrigger
                  value="editors"
                  data-yaade-project-tab="editors"
                  className="w-[4.25rem] flex-none px-2 text-xs after:inset-y-1 after:right-auto after:bottom-auto after:left-0 after:h-auto after:w-0.5 data-[state=active]:after:opacity-100"
                >
                  Editors
                </TabsTrigger>
                <TabsTrigger
                  value="terminals"
                  data-yaade-project-tab="terminals"
                  className="w-[5rem] flex-none px-2 text-xs after:inset-y-1 after:right-auto after:bottom-auto after:left-0 after:h-auto after:w-0.5 data-[state=active]:after:opacity-100"
                >
                  Terminals
                </TabsTrigger>
                <TabsTrigger
                  value="history"
                  data-yaade-project-tab="history"
                  className="w-[4.25rem] flex-none px-2 text-xs after:inset-y-1 after:right-auto after:bottom-auto after:left-0 after:h-auto after:w-0.5 data-[state=active]:after:opacity-100"
                >
                  History
                </TabsTrigger>
              </TabsList>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              <WorktreeSwitcher
                projectPath={projectPath}
                homeDir={homeDir}
                defaultBranch={defaultBranch}
                activeLabel={activeCheckout.label}
                activeCwdPath={activeCheckout.cwdPath}
                onIntent={() => void preloadMuxApp()}
                onSelectCheckout={handleSelectCheckout}
                onCreateWorktree={handleCreateWorktree}
                onRemoveWorktree={handleRemoveWorktree}
              />
              <NotificationBell
                counts={notifications.counts}
                onClick={() => notifications.setOpen(true)}
                className="size-6"
              />
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Settings"
                onPointerEnter={() => void preloadSettingsOverlay()}
                onFocus={() => void preloadSettingsOverlay()}
                onClick={() => setSettingsOpen(true)}
              >
                <SettingsIcon />
              </Button>
            </div>
          </header>

          {/* Keep mux mounted so PTYs survive surface switches. */}
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {historyMounted ? (
              <div
                className={cn(
                  "absolute inset-0 overflow-hidden",
                  view !== "history" && "pointer-events-none invisible",
                )}
                aria-hidden={view !== "history"}
                data-yaade-project-panel="history"
              >
                <Suspense
                  fallback={
                    <div
                      className="grid h-full place-items-center text-xs text-muted-foreground"
                      role="status"
                    >
                      Loading history…
                    </div>
                  }
                >
                  <GitWorkspace
                    key={`history:${activeCheckout.cwdPath}`}
                    rootUri={checkoutRootUri}
                    theme={activeTheme}
                    initialView="history"
                    unifiedHistory
                    onOpenFile={() => undefined}
                  />
                </Suspense>
              </div>
            ) : null}

            {view === "changes" ? (
              <div
                className={cn(
                  "absolute inset-0 overflow-hidden",
                  view !== "changes" && "pointer-events-none invisible",
                )}
                aria-hidden={view !== "changes"}
                data-yaade-project-panel="changes"
              >
                <Suspense
                  fallback={
                    <div
                      className="grid h-full place-items-center text-xs text-muted-foreground"
                      role="status"
                    >
                      Loading changes…
                    </div>
                  }
                >
                  <GitWorkspace
                    key={`changes:${activeCheckout.cwdPath}`}
                    rootUri={checkoutRootUri}
                    theme={activeTheme}
                    initialView="changes"
                    onOpenFile={() => undefined}
                  />
                </Suspense>
              </div>
            ) : null}

            {session && !(view === "agents" && (historicalRun || agentLookupMissing)) ? (
              <div
                className={cn(
                  "absolute inset-0 overflow-hidden",
                  !isSurfaceView(view) && "pointer-events-none invisible",
                )}
                aria-hidden={!isSurfaceView(view)}
                data-yaade-project-panel={muxSurface}
              >
                <Suspense
                  fallback={
                    <div
                      className="grid h-full place-items-center text-xs text-muted-foreground"
                      role="status"
                    >
                      Opening workspace…
                    </div>
                  }
                >
                  <MuxApp
                    key={session.id}
                    session={session}
                    projectId={projectId}
                    projectName={projectName}
                    homeDir={homeDir}
                    machineHostname={machineHostname}
                    embedded
                    surface={muxSurface}
                    focusAgentTabId={
                      muxSurface === "agents" ? focusAgentTabId : null
                    }
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
                        setHistoryMounted(false)
                        setView("changes")
                        pushProjectRoute(location.pathname, {
                          view: "changes",
                          workspaceId: session?.id ?? null,
                          checkoutKey: checkoutRouteKey(activeCheckout),
                          agentRunId: null,
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
                </Suspense>
              </div>
            ) : null}

            {view === "agents" && historicalRun ? (
              <div
                className="absolute inset-0 grid place-items-center overflow-auto p-6"
                data-yaade-project-panel="agents"
                data-yaade-agent-history={historicalRun.runId}
              >
                <div className="w-full max-w-lg rounded-md border border-border bg-card p-5">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Historical agent run
                  </p>
                  <h2 className="mt-1 text-lg font-semibold">{historicalRun.title}</h2>
                  <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                    <dt className="text-muted-foreground">Provider</dt>
                    <dd className="capitalize">{historicalRun.provider}</dd>
                    <dt className="text-muted-foreground">Worktree</dt>
                    <dd className="truncate font-mono">{historicalRun.checkoutKey}</dd>
                    <dt className="text-muted-foreground">Status</dt>
                    <dd>{historicalRun.endReason ?? historicalRun.processState}</dd>
                    <dt className="text-muted-foreground">Ended</dt>
                    <dd>{historicalRun.endedAt ? new Date(historicalRun.endedAt).toLocaleString() : "Host restarted"}</dd>
                  </dl>
                  <p className="mt-4 text-xs text-muted-foreground">
                    Terminal transcripts are intentionally not retained in HQ activity.
                  </p>
                </div>
              </div>
            ) : null}

            {view === "agents" && agentLookupMissing && agentLookupComplete && projectRouteFromSearch().agentRunId ? (
              <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground" data-yaade-agent-not-found="">
                This agent run was not found.
              </div>
            ) : null}

            {view === "agents" && !session ? (
              <div
                className="absolute inset-0 grid place-items-center overflow-hidden"
                data-yaade-project-panel="agents"
              >
                <div className="max-w-sm px-4 text-center text-sm text-muted-foreground">
                  <p>{routeError ?? "Select a running agent from the sidebar, or launch one."}</p>
                  <Button
                    className="mt-3"
                    variant="secondary"
                    size="sm"
                    onClick={() => setAgentPickerOpen(true)}
                  >
                    Launch agent…
                  </Button>
                </div>
              </div>
            ) : null}

            {(view === "editors" || view === "terminals") && !session ? (
              <div
                className="absolute inset-0 grid place-items-center overflow-hidden"
                data-yaade-project-panel={view}
              >
                <p className="max-w-sm px-4 text-center text-sm text-muted-foreground">
                  {routeError ?? (view === "editors"
                    ? "Opening the selected worktree for files…"
                    : "Opening the selected worktree for a shell…")}
                </p>
              </div>
            ) : null}
          </div>
        </Tabs>
      </div>

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

      <OpenProjectOverlay
        open={openProjectOpen}
        onOpenChange={setOpenProjectOpen}
        homeDir={homeDir}
        projects={hq.snapshot?.projects ?? []}
        onOpenProject={project => onNavigateProject(project.rootPath)}
        onOpenPath={async rootPath => onNavigateProject(rootPath)}
      />

      {agentPickerOpen ? (
        <Suspense fallback={null}>
          <AgentCliPickerOverlay
            open={agentPickerOpen}
            onOpenChange={setAgentPickerOpen}
            onSelect={driver => {
              setAgentPickerOpen(false)
              void handleLaunchAction({ kind: "agent", driverId: driver.id })
            }}
          />
        </Suspense>
      ) : null}

      {!session ? <Toaster position="bottom-right" /> : null}
      {!session ? <ConfirmDialogHost /> : null}
    </AppShell>
  )
}
