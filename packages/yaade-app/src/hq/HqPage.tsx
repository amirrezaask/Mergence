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
import { ConfirmDialogHost, requestConfirm } from "@yaade/ui"
import { bundledThemeList } from "@yaade/ui/appearance"
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@yaade/ui/primitives"
import {
  AlertTriangle,
  Bot,
  FolderOpen,
  Plus,
  Search,
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
  onOpenProject: (project: Pick<HqProjectSummary, "id" | "rootPath">) => void
  onOpenWorkspace: (agent: HqAgentSummary) => void
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
  onOpenProject,
  onOpenWorkspace,
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
    <div
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      data-yaade-shell="hq"
    >
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

            <div className="min-w-0">
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
                    <OpenProjectOverlay
                      open={openProjectOpen}
                      onOpenChange={setOpenProjectOpen}
                      homeDir={homeDir}
                      projects={[]}
                      onOpenProject={() => undefined}
                      onOpenPath={onOpenProjectPath}
                      side="bottom"
                      align="end"
                      trigger={
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label="Add project"
                          data-yaade-project-switcher=""
                        >
                          <FolderOpen data-icon="inline-start" />
                          Add project
                        </Button>
                      }
                    />
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
            </div>
          </div>
        </main>

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

function HqSkeleton() {
  return (
    <div
      className="flex h-full flex-col bg-background"
      data-yaade-boot="hq-loading"
      role="status"
    >
      <span className="sr-only">Loading HQ…</span>
      <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-4 p-4 sm:p-5 lg:p-6">
        <Skeleton className="h-96" />
      </div>
    </div>
  )
}
