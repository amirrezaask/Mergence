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
  const openingLiveAgentSessionRef = useRef<string | null>(null)
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

  // Opening the project link from an HQ agent row lands on the project page
  // without a session id. Pick a live session when the user selects Agents so
  // the project surface does not look empty just because navigation started at
  // the project instead of the agent anchor.
  useEffect(() => {
    if (view !== "agents" || session || !hq.snapshot) return
    const liveAgent = hq.snapshot.agents.find(agent => agent.projectId === projectId)
    if (!liveAgent || openingLiveAgentSessionRef.current) return
    const runId = liveAgent.runId || liveAgent.sessionId
    openingLiveAgentSessionRef.current = liveAgent.projectSessionId
    preferredSurfaceRef.current = "agents"
    setFocusAgentTabId(agentFocusTabId(runId))
    void onOpenSession(liveAgent.projectSessionId)
      .then(() => {
        pushProjectRoute(location.pathname, {
          view: "agents",
          workspaceId: liveAgent.projectSessionId,
          checkoutKey: null,
          agentRunId: runId,
        })
      })
      .catch(error => {
        openingLiveAgentSessionRef.current = null
        showYaadeToast(
          error instanceof Error ? error.message : "Workspace unavailable",
          { variant: "destructive" },
        )
      })
  }, [hq.snapshot, onOpenSession, projectId, session, view])

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
        workspaceId: isSurfaceView(view) ? session?.id ?? null : null,
        checkoutKey: checkoutRouteKey(checkout),
        agentRunId: view === "agents" ? focusAgentTabId : null,
      })
    },
    [focusAgentTabId, persistChangesCheckout, projectPath, session, view],
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

        const request: MuxLaunchRequest = {
          id: input.requestId,
          action: {
            kind: "agent",
            driverId: input.driverId,
            checkoutPath,
            checkoutKey,
            checkoutLabel,
          },
        }
        setLaunchRequest(request)
        setView("agents")
        pushProjectRoute(location.pathname, {
          view: "agents",
          workspaceId,
          checkoutKey: checkoutKey === "main" ? null : checkoutKey,
          agentRunId: null,
        })
      } catch (error) {
        setLaunchRequest(current =>
          current?.id === input.requestId ? null : current,
        )
        throw error
      }
    },
    [ensureProjectSession, onOpenSession, projectId, projectPath, session],
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
      setLaunchRequest({
        id: intent.id,
        action: { kind: "agent", driverId: intent.driverId },
      })
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
          workspaceId: isSurfaceView(view) ? session?.id ?? null : null,
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

  const ensureCheckoutSession = useCallback(
    async (surface: MuxSurface) => {
      await openSurface(surface)
    },
    [openSurface],
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
              {view === "changes" || view === "history" ? (
                <CheckoutPicker
                  projectPath={projectPath}
                  homeDir={homeDir}
                  defaultBranch={defaultBranch}
                  activeLabel={activeCheckout.label}
                  activeCwdPath={activeCheckout.cwdPath}
                  onSelectCheckout={handleSelectCheckout}
                  onCreateWorktree={handleCreateWorktree}
                  onRemoveWorktree={handleRemoveWorktree}
                />
              ) : null}
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
                    ? "Open a file from the project…"
                    : "Launch a terminal in Main or a worktree…")}
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
            onSelect={selection => {
              setAgentPickerOpen(false)
              launchSequenceRef.current += 1
              const requestId = `launch-${Date.now()}-${launchSequenceRef.current}`
              void openAgentLaunch({
                requestId,
                driverId: selection.driver.id,
                useWorktree: selection.useWorktree,
                worktreeName: selection.worktreeName,
                checkoutPath: selection.checkoutPath,
                checkoutKey: selection.checkoutKey,
                checkoutLabel: selection.checkoutLabel,
              }).catch(error => {
                showYaadeToast(
                  error instanceof Error
                    ? error.message
                    : "Could not launch the agent.",
                  { variant: "destructive" },
                )
              })
            }}
            projectPath={projectPath}
            homeDir={homeDir}
            defaultBranch={defaultBranch}
          />
        </Suspense>
      ) : null}

      {!session ? <Toaster position="bottom-right" /> : null}
      {!session ? <ConfirmDialogHost /> : null}
    </AppShell>
  )
}
