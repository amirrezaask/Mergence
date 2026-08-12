import { useCallback, useEffect, useState, type ReactNode } from "react"
import type { HqAgentSummary, HqProjectSummary, ProjectSession } from "@yaade/rpc"
import type { AgentCliDriver } from "@yaade/ui/agent-picker"
import {
  findTerminalBufferMatch,
  readTerminalBufferText,
  readTerminalCellHeight,
  readTerminalCellSize,
  readTerminalCursor,
  readTerminalDims,
  readTerminalViewportY,
  scrollTerminalLines,
  focusRegisteredTerminal,
} from "@yaade/ui/terminal-registry"
import {
  clearHqAgentLaunch,
  queueHqAgentLaunch,
  type HqAgentLaunchIntent,
} from "./project/hq-agent-launch.js"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@yaade/ui/primitives"
import { AlertCircle } from "lucide-react"
import type { YaadeAgentAPI } from "./agent-bridge.js"
import { BuildModeBadge } from "./BuildModeBadge.js"
import { formatAppDocumentTitle } from "./build-branding.js"
import { HqPage, type KnownProject } from "./hq/HqPage.js"
import { ProjectPage } from "./project/ProjectPage.js"
import { preloadMuxApp } from "./mux/preload.js"
import { getEditorDiagnostics } from "./editor/editor-diagnostics.js"
import {
  createProjectSession,
  loadProjectSession,
  listProjectSessions,
} from "./project-session-client.js"
import {
  isHqPathname,
  knownProjectIdFromPathname,
  popToProjectUrl,
  projectRootFromLocation,
  pushProjectRoute,
  pushProjectUrl,
  replaceSessionUrl,
  sessionIdFromSearch,
  urlPathForKnownProject,
  urlPathForProjectRoot,
  workspaceDocumentTitle,
  projectRouteFromSearch,
  projectRouteUrl,
} from "./url-workspace.js"
import { openServerProject } from "./server-projects.js"

type HqCounts = { projects: number; agents: number; attention: number; unread: number }
type PendingAgentLaunch = HqAgentLaunchIntent

type BootState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "hq"
      homeDir: string
      machineHostname: string
    }
  | {
      status: "project"
      homeDir: string
      machineHostname: string
      project: KnownProject
      sessionId: string | null
      session: ProjectSession | null
      routeError?: string | null
    }

type SystemInfo = {
  homeDir?: string
  machineHostname?: string
}

function canonicalProjectPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "") || "/"
  return normalized.replace(/^\/private(?=\/(?:var|tmp)(?:\/|$))/, "")
}

function projectPathForHome(rootPath: string, homeDir: string): string {
  const root = canonicalProjectPath(rootPath)
  const home = canonicalProjectPath(homeDir)
  if (root === home) return homeDir.replace(/\/+$/, "") || "/"
  if (root.startsWith(`${home}/`)) {
    return `${homeDir.replace(/\/+$/, "")}${root.slice(home.length)}`
  }
  return rootPath
}

async function registerProject(rootPath: string): Promise<KnownProject> {
  return (await openServerProject(rootPath)).project
}

async function loadKnownProject(projectId: string): Promise<KnownProject> {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}`, {
    headers: { Accept: "application/json" },
  })
  const body = (await response.json()) as KnownProject & {
    error?: { message?: string }
  }
  if (!response.ok) {
    throw new Error(body.error?.message ?? "Known project was not found")
  }
  return body
}

function projectUrl(project: Pick<KnownProject, "id" | "rootPath">, homeDir: string): string {
  const home = canonicalProjectPath(homeDir)
  const root = canonicalProjectPath(project.rootPath)
  if (root === home || root.startsWith(`${home}/`)) {
    return urlPathForProjectRoot(root, homeDir)
  }
  return urlPathForKnownProject(project.id)
}

function basicAgentBridge(input: {
  route: "hq" | "project"
  workspace: string | null
  hqCounts?: HqCounts
  executeCommand?: (id: string) => void | Promise<void>
  createProjectSession?: YaadeAgentAPI["createProjectSession"]
  listProjectSessions?: YaadeAgentAPI["listProjectSessions"]
  openProjectSession?: YaadeAgentAPI["openProjectSession"]
  backToProject?: YaadeAgentAPI["backToProject"]
}): YaadeAgentAPI {
  const workspace = input.workspace
  return {
    openWorkspace: async () => undefined,
    addWorkspace: async () => undefined,
    listWorkspaces: () =>
      workspace ? [{ id: "project", path: workspace, name: workspace }] : [],
    openFile: async () => undefined,
    executeCommand: async id => {
      await input.executeCommand?.(id)
    },
    getState: () => ({
      workspace,
      activeWorkspace: workspace,
      workspaces: workspace
        ? [{ id: "project", path: workspace, name: workspace }]
        : [],
      message: null,
      paletteOpen: false,
      focusedPanel: null,
      openBuffers: [],
      panels: [],
      fontSize: 13,
      activeEditorDirty: false,
      searchReady: false,
      shellView: "home",
      sessionLayout: "sidebar",
      sessionMode: null,
      route: input.route,
      sessionId: null,
      sessionCwd: null,
      ...(input.hqCounts ? { hqCounts: input.hqCounts } : {}),
    }),
    waitForReady: async () => undefined,
    waitForEditor: async () => undefined,
    setFontSize: () => undefined,
    getEditorText: () => null,
    setEditorSelection: () => undefined,
    getCursorPosition: () => null,
    getSelectionRangeCount: () => null,
    getEditorDiagnostics: () =>
      getEditorDiagnostics({ activeDirty: false, openBuffers: [] }),
    acceptConfirm: async () => undefined,
    dismissConfirm: async () => undefined,
    readFixtureFile: async () => "",
    waitForListRows: async () => undefined,
    getPerfMeasures: () => [],
    clearPerf: () => undefined,
    markPerf: () => undefined,
    measurePerf: () => undefined,
    dropFilesOnTerminal: async () => false,
    dropFilesOnEditor: async () => false,
    getTerminalText: tabId => readTerminalBufferText(tabId),
    getTerminalCellHeight: tabId => readTerminalCellHeight(tabId),
    getTerminalCellSize: tabId => readTerminalCellSize(tabId),
    getTerminalDims: tabId => readTerminalDims(tabId),
    getTerminalCursor: tabId => readTerminalCursor(tabId),
    getTerminalViewportY: tabId => readTerminalViewportY(tabId),
    scrollTerminalLines: (amount, tabId) => scrollTerminalLines(amount, tabId),
    focusTerminal: tabId => focusRegisteredTerminal(tabId),
    findTerminalText: (needle, tabId) => findTerminalBufferMatch(needle, tabId),
    createProjectSession: input.createProjectSession,
    listProjectSessions: input.listProjectSessions,
    openProjectSession: input.openProjectSession,
    backToProject: input.backToProject,
  }
}

export function AppRoot() {
  const [boot, setBoot] = useState<BootState>({ status: "loading" })
  const [routeEpoch, setRouteEpoch] = useState(0)
  const [hqCounts, setHqCounts] = useState<HqCounts>({
    projects: 0,
    agents: 0,
    attention: 0,
    unread: 0,
  })
  const [pendingAgentLaunch, setPendingAgentLaunch] =
    useState<PendingAgentLaunch | null>(null)
  const [pendingAgentFocusTabId, setPendingAgentFocusTabId] = useState<
    string | null
  >(null)
  const [openProjectOnHq, setOpenProjectOnHq] = useState(false)

  const readRoute = useCallback(() => setRouteEpoch(value => value + 1), [])

  useEffect(() => {
    const onRoute = () => readRoute()
    window.addEventListener("popstate", onRoute)
    window.addEventListener("yaade:project-route", onRoute)
    return () => {
      window.removeEventListener("popstate", onRoute)
      window.removeEventListener("yaade:project-route", onRoute)
    }
  }, [readRoute])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        let systemInfo: SystemInfo | null = null
        try {
          const response = await fetch("/api/v1/system")
          if (response.ok) systemInfo = (await response.json()) as SystemInfo
        } catch {
          /* Compatibility fallback below. */
        }
        let homeDir = systemInfo?.homeDir ?? ""
        if (!homeDir) homeDir = (await window.yaade?.getHomeDir?.()) ?? ""
        const machineHostname = systemInfo?.machineHostname ?? "local"
        let pathname = location.pathname
        const requestedRoute = projectRouteFromSearch()
        const requestedSessionId = requestedRoute.workspaceId

        // Old home-session links used `/`; HQ owns `/` now.
        if (isHqPathname(pathname) && requestedSessionId) {
          pathname = "/~"
          history.replaceState(
            { sessionId: requestedSessionId },
            "",
            `/~?s=${encodeURIComponent(requestedSessionId)}`,
          )
        }

        if (isHqPathname(pathname)) {
          if (location.search) replaceSessionUrl("/", null)
          if (!cancelled) {
            setBoot({ status: "hq", homeDir, machineHostname })
          }
          return
        }

        const externalProjectId = knownProjectIdFromPathname(pathname)
        const loadedProject = externalProjectId
          ? await loadKnownProject(externalProjectId)
          : await registerProject(
              projectRootFromLocation(homeDir, pathname) ??
                (() => {
                  throw new Error("Could not resolve a project path from the URL.")
                })(),
            )
        const project = {
          ...loadedProject,
          rootPath: projectPathForHome(loadedProject.rootPath, homeDir),
        }
        document.title = formatAppDocumentTitle(
          workspaceDocumentTitle(project.rootPath, homeDir),
        )

        const sessionId = requestedRoute.workspaceId
        if (!sessionId) {
          if (!cancelled) {
            setBoot({
              status: "project",
              homeDir,
              machineHostname,
              project,
              sessionId: null,
              session: null,
              routeError: null,
            })
          }
          return
        }

        try {
          const [session] = await Promise.all([
            loadProjectSession(sessionId),
            preloadMuxApp(),
          ])
          if (cancelled) return
          if (
            canonicalProjectPath(session.projectPath) !==
            canonicalProjectPath(project.rootPath)
          ) {
            setBoot({
              status: "project",
              homeDir,
              machineHostname,
              project,
              sessionId: null,
              session: null,
              routeError: "This workspace is unavailable or was archived. Select a worktree to recover it.",
            })
            return
          }
          setBoot({
            status: "project",
            homeDir,
            machineHostname,
            project,
            sessionId,
            session,
            routeError: null,
          })
        } catch (error) {
          if (cancelled) return
          setBoot({
            status: "project",
            homeDir,
            machineHostname,
            project,
            sessionId: null,
            session: null,
            routeError:
              error instanceof Error
                ? error.message
                : "This workspace is unavailable.",
          })
          console.warn(
            "Failed to load deep-linked workspace:",
            error instanceof Error ? error.message : error,
          )
        }
      } catch (error) {
        if (!cancelled) {
          setBoot({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [routeEpoch])

  const openSession = useCallback(
    async (sessionId: string) => {
      if (boot.status !== "project") return
      const [session] = await Promise.all([
        loadProjectSession(sessionId),
        preloadMuxApp(),
      ])
      pushProjectRoute(location.pathname, {
        view: "running",
        workspaceId: sessionId,
      })
      setBoot({ ...boot, sessionId, session })
    },
    [boot],
  )

  const backToProject = useCallback(() => {
    if (boot.status !== "project") return
    popToProjectUrl(location.pathname)
    setBoot({ ...boot, sessionId: null, session: null })
  }, [boot])

  const openKnownProject = useCallback(
    (project: Pick<KnownProject, "id" | "rootPath">) => {
      if (boot.status !== "hq" && boot.status !== "project") return
      pushProjectUrl(projectUrl(project, boot.homeDir))
      readRoute()
    },
    [boot, readRoute],
  )

  const navigateProject = useCallback(
    (absolutePath: string) => {
      if (boot.status !== "project") return
      const nextPath = canonicalProjectPath(absolutePath)
      if (nextPath === canonicalProjectPath(boot.project.rootPath)) return
      if (
        nextPath === canonicalProjectPath(boot.homeDir) ||
        nextPath.startsWith(`${canonicalProjectPath(boot.homeDir)}/`)
      ) {
        pushProjectUrl(urlPathForProjectRoot(nextPath, boot.homeDir))
        readRoute()
        return
      }
      void registerProject(nextPath).then(project => {
        pushProjectUrl(urlPathForKnownProject(project.id))
        readRoute()
      })
    },
    [boot, readRoute],
  )

  const openAgentWorkspace = useCallback(
    (agent: HqAgentSummary) => {
      if (boot.status !== "hq" && boot.status !== "project") return
      setPendingAgentFocusTabId(agent.sessionId)
      const pathname = projectUrl(
        { id: agent.projectId, rootPath: agent.projectPath },
        boot.homeDir,
      )
      pushProjectUrl(
        projectRouteUrl(pathname, {
          view: "running",
          workspaceId: null,
          processId:
            "runId" in agent && typeof agent.runId === "string"
              ? agent.runId
              : agent.sessionId,
        }),
      )
      readRoute()
    },
    [boot, readRoute],
  )

  const agentHref = useCallback(
    (agent: HqAgentSummary) => {
      if (boot.status !== "hq" && boot.status !== "project") return "/"
      const pathname = projectUrl(
        { id: agent.projectId, rootPath: agent.projectPath },
        boot.homeDir,
      )
      return projectRouteUrl(pathname, {
        view: "running",
        workspaceId: null,
        processId:
          "runId" in agent && typeof agent.runId === "string"
            ? agent.runId
            : agent.sessionId,
      })
    },
    [boot],
  )

  const openProjectPath = useCallback(
    async (rootPath: string) => {
      const project = await registerProject(rootPath)
      openKnownProject(project)
    },
    [openKnownProject],
  )

  const launchAgentFromHq = useCallback(
    (
      project: Pick<HqProjectSummary, "id" | "rootPath">,
      driverId: AgentCliDriver["id"],
      options?: { useWorktree?: boolean; worktreeName?: string },
    ) => {
      const intent: PendingAgentLaunch = {
        id: `hq-launch-${Date.now()}-${driverId}`,
        projectId: project.id,
        driverId,
        useWorktree: options?.useWorktree === true,
        worktreeName: options?.worktreeName?.trim() || undefined,
      }
      // Module queue survives StrictMode remounts that wipe ProjectPage state.
      queueHqAgentLaunch(intent)
      setPendingAgentLaunch(intent)
      openKnownProject(project)
    },
    [openKnownProject],
  )

  useEffect(() => {
    if (boot.status === "loading" || boot.status === "error" || boot.status === "project" && boot.session) {
      return
    }
    if (boot.status === "hq") {
      window.__yaadeAgent = basicAgentBridge({
        route: "hq",
        workspace: null,
        hqCounts,
        executeCommand: id => {
          if (id === "settings.show") window.dispatchEvent(new Event("yaade:open-settings"))
        },
      })
    } else {
      const projectPath = boot.project.rootPath
      window.__yaadeAgent = basicAgentBridge({
        route: "project",
        workspace: projectPath,
        createProjectSession: async input => {
          const muxReady = preloadMuxApp()
          const created = await createProjectSession({
            rootPath: projectPath,
            title: input?.title ?? "Main",
            worktree: input?.worktree,
          })
          await muxReady
          await openSession(created.id)
          return {
            id: created.id,
            createdWorktree: created.createdWorktree,
          }
        },
        listProjectSessions: async () => {
          const rows = await listProjectSessions(projectPath)
          return rows.map(row => ({ id: row.id, title: row.title }))
        },
        openProjectSession: openSession,
        backToProject: async () => backToProject(),
      })
    }
    return () => {
      const route = window.__yaadeAgent?.getState?.().route
      if (route === "hq" || route === "project") delete window.__yaadeAgent
    }
  }, [backToProject, boot, hqCounts, openSession])

  let content: ReactNode
  if (boot.status === "loading") {
    content = <AppBootSkeleton />
  } else if (boot.status === "error") {
    content = (
      <div className="grid h-full place-items-center bg-background p-8 text-foreground" data-yaade-boot="error" role="alert">
        <Card className="w-full max-w-md text-left">
          <CardHeader><CardTitle>YAADE could not open this route</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <Alert variant="destructive">
              <AlertCircle aria-hidden />
              <AlertTitle>Unable to resolve project</AlertTitle>
              <AlertDescription>{boot.message}</AlertDescription>
            </Alert>
            <div className="flex gap-2">
              <Button onClick={() => window.location.reload()}>Retry</Button>
              <Button variant="outline" onClick={() => {
                setOpenProjectOnHq(true)
                pushProjectUrl("/")
                readRoute()
              }}>Open Project</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  } else if (boot.status === "hq") {
    content = (
      <HqPage
        homeDir={boot.homeDir}
        onOpenProject={openKnownProject}
        onOpenWorkspace={openAgentWorkspace}
        onOpenProjectPath={openProjectPath}
        agentHref={agentHref}
        initialOpenProject={openProjectOnHq}
        onLaunchAgent={launchAgentFromHq}
        onCountsChange={setHqCounts}
      />
    )
  } else {
    content = (
      <ProjectPage
        projectId={boot.project.id}
        projectName={boot.project.name}
        projectPath={boot.project.rootPath}
        homeDir={boot.homeDir}
        machineHostname={boot.machineHostname}
        routeRevision={routeEpoch}
        session={boot.session}
        routeError={boot.routeError}
        agentLaunchIntent={
          pendingAgentLaunch?.projectId === boot.project.id
            ? pendingAgentLaunch
            : null
        }
        onAgentLaunchIntentHandled={intentId => {
          clearHqAgentLaunch(intentId)
          setPendingAgentLaunch(current =>
            current?.id === intentId ? null : current,
          )
        }}
        initialAgentFocusTabId={
          pendingAgentFocusTabId ?? projectRouteFromSearch().processId
        }
        onInitialAgentFocusHandled={() => setPendingAgentFocusTabId(null)}
        onOpenSession={openSession}
        onClearSession={backToProject}
        onNavigateProject={navigateProject}
        onOpenHq={() => {
          pushProjectUrl("/")
          readRoute()
        }}
      />
    )
  }

  return (
    <>
      {content}
      <BuildModeBadge />
    </>
  )
}

function AppBootSkeleton() {
  return (
    <div className="flex h-full flex-col bg-background" data-yaade-boot="loading" role="status">
      <span className="sr-only">Loading YAADE…</span>
      <div className="h-11 shrink-0 border-b border-border px-3 py-3"><Skeleton className="h-4 w-48" /></div>
      <div className="mx-auto grid w-full max-w-screen-2xl gap-4 p-4 sm:p-6 lg:grid-cols-2">
        {[0, 1, 2, 3].map(index => (
          <Card key={index}>
            <CardHeader><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-48" /></CardHeader>
            <CardContent className="grid gap-2"><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-4/5" /></CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
