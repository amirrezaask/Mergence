import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"
import type { HqAgentSummary, HqProjectSummary } from "@yaade/rpc"
import { pathToFileUri } from "@yaade/shared"
import type { AgentCliDriver } from "@yaade/ui/agent-picker"
import { AgentActivityList, ConfirmDialogHost, requestConfirm } from "@yaade/ui"
import type { AgentRunInfo } from "@yaade/workspace"
import { bundledThemeList } from "@yaade/ui/appearance"
import { NotificationBell } from "@yaade/ui/notifications"
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Input,
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@yaade/ui/primitives"
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  CircleDot,
  FolderKanban,
  FolderOpen,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
} from "lucide-react"
import { useAppearanceSettings } from "../hooks/useAppearanceSettings.js"
import { useHqOverview } from "../hooks/useHqOverview.js"
import {
  loadProjectSession,
  saveProjectSessionPayload,
} from "../project-session-client.js"
import { useSystemSignals } from "../system-signals/SystemSignalsProvider.js"
import { filterHqAgents, type HqAgentFilter } from "./hq-model.js"
import { OpenProjectOverlay } from "../project/OpenProjectOverlay.js"
import { projectRouteUrl, urlPathForKnownProject } from "../url-workspace.js"

const AgentCliPickerOverlay = lazy(() =>
  import("@yaade/ui/agent-picker").then(module => ({
    default: module.AgentCliPickerOverlay,
  })),
)
const SettingsOverlay = lazy(() =>
  import("@yaade/ui/settings").then(module => ({
    default: module.SettingsOverlay,
  })),
)

export type KnownProject = {
  id: string
  name: string
  rootPath: string
}

export type HqPageProps = {
  homeDir: string
  machineHostname: string
  onOpenProject: (project: Pick<HqProjectSummary, "id" | "rootPath">) => void
  onOpenWorkspace: (agent: HqAgentSummary) => void
  onOpenRegisteredProject: (project: KnownProject) => void
  onOpenProjectPath: (rootPath: string) => Promise<void>
  agentHref: (agent: HqAgentSummary) => string
  initialOpenProject?: boolean
  onLaunchAgent: (
    project: Pick<HqProjectSummary, "id" | "rootPath">,
    driverId: AgentCliDriver["id"],
    options?: { useWorktree?: boolean; worktreeName?: string },
  ) => void
  onCountsChange?: (counts: {
    projects: number
    agents: number
    attention: number
    unread: number
  }) => void
}

type BadgeVariant = "default" | "secondary" | "destructive" | "outline"

function relativeTime(value: string | null): string {
  if (!value) return "No activity"
  const delta = Math.max(0, Date.now() - new Date(value).getTime())
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return "Just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function formatRuntime(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function statusLabel(agent: HqAgentSummary): string {
  if (agent.telemetry === "pending") return "Connecting"
  if (agent.telemetry === "degraded") return "Limited telemetry"
  if (agent.telemetry === "process_only") return "Running"
  return agent.status.replaceAll("_", " ")
}

function statusVariant(agent: HqAgentSummary): BadgeVariant {
  if (agent.attention) return "destructive"
  if (agent.status === "working" || agent.status === "running_tool") {
    return "default"
  }
  if (agent.telemetry === "pending") return "outline"
  return "secondary"
}

export function HqPage({
  homeDir,
  machineHostname,
  onOpenProject,
  onOpenWorkspace,
  onOpenRegisteredProject,
  onOpenProjectPath,
  agentHref,
  initialOpenProject = false,
  onLaunchAgent,
  onCountsChange,
}: HqPageProps) {
  const overview = useHqOverview()
  const notifications = useSystemSignals()
  const {
    appearanceSettings,
    setAppearanceSettings,
    resetAppearanceSettings,
  } = useAppearanceSettings()
  const [query, setQuery] = useState("")
  const [projectId, setProjectId] = useState("")
  const [filter, setFilter] = useState<HqAgentFilter>("all")
  const [activityProvider, setActivityProvider] = useState("")
  const [activityRuns, setActivityRuns] = useState<AgentRunInfo[]>([])
  const [activityCursor, setActivityCursor] = useState<string | null>(null)
  const [activityLoading, setActivityLoading] = useState(false)
  const [launchPickerOpen, setLaunchPickerOpen] = useState(false)
  const [selectedLaunchRootUri, setSelectedLaunchRootUri] = useState<string | null>(null)
  const [openProjectOpen, setOpenProjectOpen] = useState(initialOpenProject)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const snapshot = overview.snapshot

  useEffect(() => {
    document.title = "HQ · YAADE"
  }, [])

  useEffect(() => {
    const openSettings = () => setSettingsOpen(true)
    window.addEventListener("yaade:open-settings", openSettings)
    return () => window.removeEventListener("yaade:open-settings", openSettings)
  }, [])

  const agents = useMemo(
    () =>
      filterHqAgents(snapshot?.agents ?? [], {
        query,
        projectId,
        filter,
      }),
    [filter, projectId, query, snapshot?.agents],
  )
  const attentionCount =
    snapshot?.agents.filter(agent => agent.attention).length ?? 0
  const workingCount =
    snapshot?.agents.filter(
      agent => agent.status === "working" || agent.status === "running_tool",
    ).length ?? 0
  const availableProjectCount =
    snapshot?.projects.filter(project => project.availability === "available")
      .length ?? 0
  const launchProjects = useMemo(
    () =>
      (snapshot?.projects ?? [])
        .filter(project => project.availability === "available")
        .map(project => ({
          rootUri: pathToFileUri(project.rootPath),
          name: project.name,
          path: project.rootPath,
        })),
    [snapshot?.projects],
  )

  const openLaunchPicker = useCallback(
    (rootUri?: string | null) => {
      setSelectedLaunchRootUri(
        rootUri ?? launchProjects[0]?.rootUri ?? null,
      )
      setLaunchPickerOpen(true)
    },
    [launchProjects],
  )

  const closeLaunchPicker = useCallback(() => {
    setLaunchPickerOpen(false)
    setSelectedLaunchRootUri(null)
  }, [])

  const loadActivity = useCallback(
    async (reset = false) => {
      const api = window.yaade?.agents
      if (!api || activityLoading) return
      setActivityLoading(true)
      try {
        const page = await api.listActivity({
          limit: 100,
          ...(reset ? {} : activityCursor ? { cursor: activityCursor } : {}),
          ...(projectId ? { projectId } : {}),
        })
        setActivityRuns(current => {
          const next = reset ? page.runs : [...current, ...page.runs]
          return [...new Map(next.map(run => [run.runId, run])).values()]
        })
        setActivityCursor(page.nextCursor)
      } finally {
        setActivityLoading(false)
      }
    },
    [activityCursor, activityLoading, projectId],
  )

  useEffect(() => {
    setActivityRuns([])
    setActivityCursor(null)
    void loadActivity(true)
    const off = window.yaade?.agents?.onEvent(event => {
      if (event.type === "agents.run" && event.kind === "run.ended") {
        void loadActivity(true)
      }
    })
    return () => off?.()
    // Re-run only when the server-side project filter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const filteredActivityRuns = useMemo(
    () =>
      activityProvider
        ? activityRuns.filter(run => run.provider === activityProvider)
        : activityRuns,
    [activityProvider, activityRuns],
  )

  const activityHref = useCallback(
    (run: AgentRunInfo) =>
      projectRouteUrl(urlPathForKnownProject(run.projectId), {
        view: "agents",
        workspaceId: run.workspaceId,
        agentRunId: run.runId,
      }),
    [],
  )

  useEffect(() => {
    onCountsChange?.({
      projects: snapshot?.projects.length ?? 0,
      agents: snapshot?.agents.length ?? 0,
      attention: Math.max(attentionCount, notifications.counts.actionRequired),
      unread: notifications.counts.totalUnread,
    })
  }, [
    attentionCount,
    notifications.counts.actionRequired,
    notifications.counts.totalUnread,
    onCountsChange,
    snapshot?.agents.length,
    snapshot?.projects.length,
  ])

  const forgetProject = async (project: HqProjectSummary) => {
    await fetch(`/api/v1/projects/${encodeURIComponent(project.id)}`, {
      method: "DELETE",
    })
    await overview.refresh()
  }

  const killAgent = useCallback(
    async (agent: HqAgentSummary) => {
      const ok = await requestConfirm({
        title: `Kill ${agent.title}?`,
        description:
          "The agent process will be stopped. Opening the workspace later will not respawn it.",
        confirmLabel: "Kill agent",
        cancelLabel: "Keep running",
        destructive: true,
      })
      if (!ok) return

      await window.yaade?.terminal?.dispose(agent.ptyId)

      // Strip launch metadata so a later mux attach does not recreate the CLI.
      if (!agent.sessionId.startsWith("pty:")) {
        try {
          const session = await loadProjectSession(agent.projectSessionId)
          const sessions = session.payload.sessions.map(leaf => {
            if (
              leaf.ptyTabId !== agent.sessionId &&
              leaf.ptyId !== agent.ptyId
            ) {
              return leaf
            }
            return {
              ptyTabId: leaf.ptyTabId,
              cwdRootUri: leaf.cwdRootUri,
              ...(leaf.liveCwdUri ? { liveCwdUri: leaf.liveCwdUri } : {}),
              ...(leaf.label ? { label: leaf.label } : {}),
            }
          })
          await saveProjectSessionPayload(agent.projectSessionId, {
            ...session.payload,
            sessions,
          })
        } catch {
          /* dispose already ran; HQ refresh still drops the live row */
        }
      }

      await overview.refresh()
    },
    [overview.refresh],
  )

  if (overview.loading && !snapshot) {
    return <HqSkeleton />
  }

  return (
    <TooltipProvider>
      <div
        className="flex h-full min-h-0 flex-col bg-background text-foreground"
        data-yaade-shell="hq"
      >
        <header
          className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto border-b border-border px-3 sm:px-4"
          data-yaade-app-header=""
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/12 text-primary">
              <Bot aria-hidden />
            </span>
            <div className="flex min-w-0 items-baseline gap-1.5 text-sm">
              <span className="font-semibold">YAADE</span>
              <span className="text-xs text-muted-foreground">HQ</span>
            </div>
            <Badge
              variant={overview.error ? "destructive" : "outline"}
              className="hidden h-6 max-w-64 gap-1 px-1.5 text-xs sm:inline-flex"
            >
              <CircleDot aria-hidden />
              <span className="truncate font-mono">
                {snapshot?.machineHostname ?? machineHostname}
              </span>
            </Badge>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setOpenProjectOpen(true)}
            >
              <FolderOpen data-icon="inline-start" />
              <span className="hidden sm:inline">Open Project</span>
            </Button>
            <NotificationBell
              counts={notifications.counts}
              onClick={() => notifications.setOpen(true)}
              className="size-6"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Refresh HQ"
                  disabled={overview.refreshing}
                  onClick={() => void overview.refresh()}
                >
                  {overview.refreshing ? <Spinner /> : <RefreshCw />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh system snapshot</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Settings"
                  onPointerEnter={() => void import("@yaade/ui/settings")}
                  onFocus={() => void import("@yaade/ui/settings")}
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </Tooltip>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-4 px-3 py-4 sm:px-5 lg:px-6">
            {overview.error ? (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                  <span>
                    Live reconciliation failed. Showing the latest available
                    system snapshot.
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void overview.refresh()}
                  >
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}

            <section
              aria-label="System overview"
              className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4"
              data-yaade-hq-summary=""
            >
              <SummaryCard
                title="Needs attention"
                value={Math.max(
                  attentionCount,
                  notifications.counts.actionRequired,
                )}
                description="Waiting, permission, or failed"
                icon={AlertTriangle}
                statId="attention"
              />
              <SummaryCard
                title="Live agents"
                value={snapshot?.agents.length ?? 0}
                description={`${workingCount} actively working`}
                icon={Bot}
                statId="live-agents"
              />
              <SummaryCard
                title="Known projects"
                value={snapshot?.projects.length ?? 0}
                description={`${availableProjectCount} available`}
                icon={FolderKanban}
                statId="projects"
              />
              <SummaryCard
                title="Unread"
                value={notifications.counts.totalUnread}
                description={`${notifications.counts.errors} errors`}
                icon={Activity}
                statId="unread"
              />
            </section>

            <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1.65fr)_minmax(20rem,0.65fr)] lg:items-start">
              <section
                className="min-w-0 p-3 sm:p-4"
                aria-labelledby="hq-live-agents-heading"
                data-yaade-hq-column="agents"
                data-yaade-island=""
              >
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <h2 id="hq-live-agents-heading" className="text-base font-semibold">
                      Live agents
                    </h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Running agent workloads on this machine.
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label="Launch agent"
                      data-yaade-hq-launch-agent=""
                      disabled={launchProjects.length === 0}
                      onClick={() => openLaunchPicker()}
                    >
                      <Plus data-icon="inline-start" />
                      Launch
                    </Button>
                    <Badge variant="secondary">
                      {agents.length} of {snapshot?.agents.length ?? 0}
                    </Badge>
                  </div>
                </div>
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-2.5 xl:flex-row xl:items-center xl:justify-between">
                    <div className="flex flex-1 flex-col gap-3 sm:flex-row">
                      <div className="relative min-w-0 flex-1">
                        <Search
                          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                          aria-hidden
                        />
                        <Input
                          value={query}
                          onChange={event => setQuery(event.target.value)}
                          placeholder="Search agents, projects, or activity"
                          aria-label="Search live agents"
                          className="pl-9"
                        />
                      </div>
                      <Select
                        value={projectId || "__all__"}
                        onValueChange={value =>
                          setProjectId(value === "__all__" ? "" : value)
                        }
                      >
                        <SelectTrigger
                          className="w-full sm:w-52"
                          aria-label="Filter agents by project"
                        >
                          <SelectValue placeholder="All projects" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="__all__">All projects</SelectItem>
                            {snapshot?.projects.map(project => (
                              <SelectItem key={project.id} value={project.id}>
                                {project.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </div>
                    <Tabs
                      value={filter}
                      onValueChange={value => setFilter(value as HqAgentFilter)}
                    >
                      <TabsList aria-label="Filter agents by status">
                        <TabsTrigger value="all">All</TabsTrigger>
                        <TabsTrigger value="attention">Attention</TabsTrigger>
                        <TabsTrigger value="working">Working</TabsTrigger>
                        <TabsTrigger value="idle">Idle</TabsTrigger>
                      </TabsList>
                    </Tabs>
                  </div>

                  <AgentTable
                    agents={agents}
                    totalAgents={snapshot?.agents.length ?? 0}
                    canLaunch={launchProjects.length > 0}
                    onLaunch={() => openLaunchPicker()}
                    onOpen={onOpenWorkspace}
                    hrefForAgent={agentHref}
                    onOpenProject={agent =>
                      onOpenProject({
                        id: agent.projectId,
                        rootPath: agent.projectPath,
                      })
                    }
                    onKill={agent => void killAgent(agent)}
                  />
                </div>
              </section>

              <ProjectShortcuts
                projects={snapshot?.projects ?? []}
                onOpen={onOpenProject}
                onLaunch={project =>
                  openLaunchPicker(pathToFileUri(project.rootPath))
                }
                onForget={project => void forgetProject(project)}
              />
            </div>

            <section
              className="min-w-0 p-3 sm:p-4"
              aria-labelledby="hq-recent-activity-heading"
              data-yaade-island=""
            >
              <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 id="hq-recent-activity-heading" className="text-base font-semibold">
                    Recent activity
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Ended agent runs remain available without terminal transcripts.
                  </p>
                </div>
                <Select
                  value={activityProvider || "__all__"}
                  onValueChange={value =>
                    setActivityProvider(value === "__all__" ? "" : value)
                  }
                >
                  <SelectTrigger className="w-44" aria-label="Filter activity by provider">
                    <SelectValue placeholder="All providers" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All providers</SelectItem>
                    {(["claude", "codex", "cursor", "opencode", "grok"] as const).map(provider => (
                      <SelectItem key={provider} value={provider} className="capitalize">
                        {provider}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <AgentActivityList
                runs={filteredActivityRuns}
                loading={activityLoading}
                hasMore={activityCursor != null}
                onLoadMore={() => void loadActivity(false)}
                hrefForRun={activityHref}
              />
            </section>
          </div>
        </main>

        <OpenProjectOverlay
          open={openProjectOpen}
          onOpenChange={setOpenProjectOpen}
          homeDir={homeDir}
          projects={snapshot?.projects ?? []}
          onOpenProject={project => onOpenRegisteredProject(project)}
          onOpenPath={onOpenProjectPath}
        />

        {launchPickerOpen ? (
          <Suspense fallback={null}>
            <AgentCliPickerOverlay
              open
              onOpenChange={open => {
                if (!open) closeLaunchPicker()
              }}
              projects={launchProjects}
              selectedRootUri={selectedLaunchRootUri}
              onSelectedRootUriChange={setSelectedLaunchRootUri}
              onSelect={selection => {
                const rootUri =
                  selectedLaunchRootUri ?? launchProjects[0]?.rootUri ?? null
                const project = snapshot?.projects.find(
                  candidate =>
                    candidate.availability === "available" &&
                    pathToFileUri(candidate.rootPath) === rootUri,
                )
                if (!project) return
                closeLaunchPicker()
                onLaunchAgent(project, selection.driver.id, {
                  useWorktree: selection.useWorktree,
                  worktreeName: selection.worktreeName,
                })
              }}
            />
          </Suspense>
        ) : null}

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

        <ConfirmDialogHost />
      </div>
    </TooltipProvider>
  )
}

function SummaryCard({
  title,
  value,
  description,
  icon: Icon,
  statId,
}: {
  title: string
  value: number
  description: string
  icon: typeof Activity
  statId: string
}) {
  return (
    <Card
      className="gap-2 border-border bg-card py-3"
      data-yaade-hq-stat={statId}
    >
      <CardHeader className="gap-1 px-3">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction>
          <span className="flex size-7 items-center justify-center rounded-md bg-secondary text-muted-foreground">
            <Icon className="size-3.5" aria-hidden />
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="px-3">
        <p
          className="text-xl font-semibold tabular-nums"
          data-yaade-hq-stat-value=""
        >
          {value}
        </p>
      </CardContent>
    </Card>
  )
}

function AgentTable({
  agents,
  totalAgents,
  canLaunch,
  onLaunch,
  onOpen,
  hrefForAgent,
  onOpenProject,
  onKill,
}: {
  agents: readonly HqAgentSummary[]
  totalAgents: number
  canLaunch: boolean
  onLaunch: () => void
  onOpen: (agent: HqAgentSummary) => void
  hrefForAgent: (agent: HqAgentSummary) => string
  onOpenProject: (agent: HqAgentSummary) => void
  onKill: (agent: HqAgentSummary) => void
}) {
  if (agents.length === 0) {
    return (
      <div data-yaade-list-panel="hq-agents">
        <Empty className="min-h-64 border-0 bg-secondary/50">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Bot />
            </EmptyMedia>
            <EmptyTitle>No live agents</EmptyTitle>
            <EmptyDescription>
              {totalAgents > 0
                ? "No live agents match the current filters."
                : "Launch an agent to start a provider in a project workspace."}
            </EmptyDescription>
          </EmptyHeader>
          {totalAgents === 0 && canLaunch ? (
            <EmptyContent>
              <Button
                size="sm"
                variant="outline"
                aria-label="Launch agent from empty state"
                data-yaade-hq-launch-agent-empty=""
                onClick={onLaunch}
              >
                <Plus data-icon="inline-start" />
                Launch agent
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      </div>
    )
  }

  return (
    <div
      className="overflow-hidden rounded-md border border-border bg-secondary/20"
      data-yaade-list-panel="hq-agents"
    >
      <Table aria-label="Live agents">
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>Project</TableHead>
            <TableHead className="hidden lg:table-cell">Activity</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden md:table-cell">Runtime</TableHead>
            <TableHead className="text-right">Unread</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {agents.map(agent => (
            <ContextMenu key={`${agent.sessionId}:${agent.ptyId}`}>
              <ContextMenuTrigger asChild>
                <TableRow
                  data-yaade-list-item
                  data-yaade-hq-agent={agent.sessionId}
                  className="shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  tabIndex={0}
                  onClick={() => onOpen(agent)}
                  onKeyDown={event => {
                    if (event.key !== "Enter" && event.key !== " ") return
                    event.preventDefault()
                    onOpen(agent)
                  }}
                >
                  <TableCell>
                    <div className="min-w-44">
                      <Button asChild size="sm" variant="ghost" className="max-w-full justify-start">
                        <a
                          href={hrefForAgent(agent)}
                          onClick={event => {
                            if (
                              event.metaKey ||
                              event.ctrlKey ||
                              event.shiftKey ||
                              event.altKey ||
                              event.button !== 0
                            ) {
                              event.stopPropagation()
                              return
                            }
                            event.preventDefault()
                            event.stopPropagation()
                            onOpen(agent)
                          }}
                        >
                          <Bot data-icon="inline-start" />
                          <span className="truncate">{agent.title}</span>
                        </a>
                      </Button>
                      <div className="flex max-w-64 items-center gap-2 px-2">
                        <Badge variant="outline">{agent.provider}</Badge>
                        <span className="truncate text-xs text-muted-foreground">
                          {agent.projectSessionTitle}
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="link"
                      onClick={event => {
                        event.stopPropagation()
                        onOpenProject(agent)
                      }}
                    >
                      <span className="max-w-40 truncate">{agent.projectName}</span>
                    </Button>
                  </TableCell>
                  <TableCell className="hidden max-w-80 lg:table-cell">
                    <p className="truncate">{agent.activity}</p>
                    {agent.currentTool ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {agent.currentTool.name}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(agent)} className="capitalize">
                      {statusLabel(agent)}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden font-mono md:table-cell">
                    {formatRuntime(agent.runtimeMs)}
                  </TableCell>
                  <TableCell className="text-right">
                    {agent.unreadCount > 0 ? (
                      <Badge>{agent.unreadCount}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              </ContextMenuTrigger>
              <ContextMenuContent data-yaade-hq-agent-context-menu="">
                <ContextMenuItem onSelect={() => onOpen(agent)}>
                  Open
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => onOpenProject(agent)}>
                  Open project
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  variant="destructive"
                  data-yaade-hq-agent-kill=""
                  onSelect={() => onKill(agent)}
                >
                  Kill agent
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function ProjectShortcuts({
  projects,
  onOpen,
  onLaunch,
  onForget,
}: {
  projects: readonly HqProjectSummary[]
  onOpen: (project: Pick<HqProjectSummary, "id" | "rootPath">) => void
  onLaunch: (project: HqProjectSummary) => void
  onForget: (project: HqProjectSummary) => void
}) {
  return (
    <section
      className="min-w-0 p-3 sm:p-4"
      aria-labelledby="hq-projects-heading"
      data-yaade-hq-column="projects"
      data-yaade-island=""
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 id="hq-projects-heading" className="text-base font-semibold">
            Projects
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Open a workspace or launch an agent.
          </p>
        </div>
        <div>
          <Badge variant="secondary">{projects.length}</Badge>
        </div>
      </div>
      {projects.length === 0 ? (
        <div data-yaade-list-panel="hq-projects">
          <Empty className="min-h-56 border-0 bg-secondary/50">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderKanban />
              </EmptyMedia>
              <EmptyTitle>No known projects</EmptyTitle>
              <EmptyDescription>
                Open a project to add it to this host.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <ItemGroup
          className="gap-0.5"
          data-yaade-list-panel="hq-projects"
        >
          {projects.map(project => {
            const available = project.availability === "available"
            return (
              <Item
                key={project.id}
                size="sm"
                className="min-w-0 flex-nowrap data-[available=true]:cursor-pointer data-[available=true]:hover:bg-accent"
                role={available ? "link" : undefined}
                aria-label={available ? `Open ${project.name}` : undefined}
                tabIndex={available ? 0 : undefined}
                data-available={available}
                data-yaade-list-item
                data-yaade-hq-project={project.id}
                onClick={available ? () => onOpen(project) : undefined}
                onKeyDown={
                  available
                    ? event => {
                        if (
                          event.target !== event.currentTarget ||
                          event.key !== "Enter"
                        ) {
                          return
                        }
                        event.preventDefault()
                        onOpen(project)
                      }
                    : undefined
                }
              >
                <FolderKanban className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <ItemContent>
                  <ItemTitle className="flex items-center gap-2">
                    <span className="truncate">{project.name}</span>
                    {!available ? (
                      <Badge variant="destructive" className="shrink-0 capitalize">
                        {project.availability}
                      </Badge>
                    ) : null}
                  </ItemTitle>
                  <ItemDescription className="truncate font-mono text-xs">
                    {project.rootPath}
                  </ItemDescription>
                  <ItemDescription className="flex flex-wrap items-center gap-x-2 text-xs">
                    <span>{project.sessionCount} sessions</span>
                    <span>{project.liveAgentCount} live</span>
                    <span>{relativeTime(project.lastActivityAt)}</span>
                  </ItemDescription>
                  {project.attentionCount > 0 || project.unreadCount > 0 ? (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {project.attentionCount > 0 ? (
                        <Badge variant="destructive">
                          {project.attentionCount} attention
                        </Badge>
                      ) : null}
                      {project.unreadCount > 0 ? (
                        <Badge>{project.unreadCount} unread</Badge>
                      ) : null}
                    </div>
                  ) : null}
                </ItemContent>
                {available ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Launch agent in ${project.name}`}
                          onClick={event => {
                            event.stopPropagation()
                            onLaunch(project)
                          }}
                        >
                          <Bot />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Launch agent</TooltipContent>
                    </Tooltip>
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </div>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Forget ${project.name}`}
                        onClick={event => {
                          event.stopPropagation()
                          onForget(project)
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Forget project</TooltipContent>
                  </Tooltip>
                )}
              </Item>
            )
          })}
        </ItemGroup>
      )}
    </section>
  )
}

function HqSkeleton() {
  return (
    <div
      className="flex h-full flex-col bg-background"
      data-yaade-boot="hq-loading"
      role="status"
    >
      <span className="sr-only">Loading HQ…</span>
      <div className="flex h-11 items-center gap-3 border-b px-4" data-yaade-app-header="">
        <Skeleton className="size-5" />
        <Skeleton className="h-4 w-28" />
      </div>
      <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-4 p-4 sm:p-5 lg:p-6">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map(index => (
            <Skeleton key={index} className="h-32" />
          ))}
        </div>
        <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.65fr)_minmax(20rem,0.65fr)]">
          <Skeleton className="h-96" />
          <Skeleton className="h-80" />
        </div>
      </div>
    </div>
  )
}
