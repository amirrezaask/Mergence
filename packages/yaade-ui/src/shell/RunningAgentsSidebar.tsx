import { AnimatePresence } from "motion/react"
import { li as MotionLi } from "motion/react-m"
import { Bot } from "lucide-react"
import type { ReactNode } from "react"
import { Skeleton } from "../primitives.js"
import { AgentProviderIcon } from "../home/AgentProviderIcon.js"
import { cn } from "../lib/utils.js"
import { yaadeMotion } from "../motion/tokens.js"
import { SidebarShell } from "./SidebarShell.js"

export type RunningAgentSidebarStatus =
  | "starting"
  | "working"
  | "running_tool"
  | "waiting_for_permission"
  | "waiting_for_user"
  | "idle"
  | "failed"

export type RunningAgentSidebarItem = {
  id: string
  provider: string
  title: string
  toolUseId?: string | null
  ptyId?: string | null
  projectName: string
  checkoutLabel?: string
  activity: string
  status: RunningAgentSidebarStatus
  telemetry?: "connecting" | "connected" | "degraded" | "process_only"
}

export type RunningAgentsSidebarProps = {
  /** Header control supplied by the session shell (the active session switcher). */
  header?: ReactNode
  agents: readonly RunningAgentSidebarItem[]
  loading?: boolean
  error?: string | null
  onSelectAgent?: (agent: RunningAgentSidebarItem) => void
  className?: string
}

function providerLabel(provider: string): string {
  switch (provider.toLowerCase()) {
    case "claude":
      return "Claude"
    case "codex":
      return "Codex"
    case "cursor":
      return "Cursor"
    case "opencode":
      return "OpenCode"
    case "grok":
      return "Grok"
    case "pi":
      return "Pi"
    default:
      return provider || "Agent"
  }
}

function statusTone(status: RunningAgentSidebarStatus): string {
  switch (status) {
    case "working":
    case "running_tool":
      return "bg-success"
    case "waiting_for_permission":
    case "waiting_for_user":
      return "bg-warning"
    case "starting":
      return "bg-info"
    case "failed":
      return "bg-destructive"
    case "idle":
      return "bg-muted-foreground/50"
  }
}

function telemetryLabel(
  telemetry: RunningAgentSidebarItem["telemetry"],
): string | null {
  switch (telemetry) {
    case "connecting":
      return "Telemetry connecting"
    case "degraded":
      return "Limited telemetry"
    case "process_only":
      return "Process telemetry"
    default:
      return null
  }
}

function AgentRow({
  agent,
  onSelect,
}: {
  agent: RunningAgentSidebarItem
  onSelect?: (agent: RunningAgentSidebarItem) => void
}) {
  const telemetry = telemetryLabel(agent.telemetry)
  const title = agent.title.trim() || providerLabel(agent.provider)
  const provider = providerLabel(agent.provider)
  return (
    <MotionLi
      layout
      initial={{ opacity: 0, transform: "translateY(4px) scale(0.98)" }}
      animate={{ opacity: 1, transform: "translateY(0) scale(1)" }}
      exit={{ opacity: 0, transform: "translateY(-4px) scale(0.98)" }}
      transition={{
        layout: yaadeMotion.layoutTransition,
        default: yaadeMotion.layoutTransition,
      }}
      className="rounded-[var(--yaade-control-radius)] border border-sidebar-border/50 bg-sidebar-accent/35 px-2.5 py-2.5"
      data-yaade-running-agent={agent.id}
      data-yaade-agent-status={agent.status}
    >
      <button
        type="button"
        aria-label={`${title}, ${agent.activity}`}
        className="block w-full cursor-pointer rounded-[calc(var(--yaade-control-radius)-0.125rem)] text-left outline-none transition-colors duration-[var(--yaade-motion-hot)] hover:bg-sidebar-accent/45 focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
        onClick={() => onSelect?.(agent)}
      >
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="relative mt-0.5 grid size-7 shrink-0 place-items-center rounded-[var(--yaade-control-radius)] bg-sidebar-accent text-sidebar-accent-foreground">
          <AgentProviderIcon agent={agent.provider} className="size-4" />
          <span
            className={cn(
              "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-sidebar",
              statusTone(agent.status),
            )}
            aria-hidden
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-xs font-medium text-sidebar-foreground">
              {title}
            </span>
            {title.toLowerCase() === provider.toLowerCase() ? null : (
              <span className="shrink-0 text-4xs font-medium uppercase tracking-[0.08em] text-sidebar-foreground/45">
                {provider}
              </span>
            )}
          </span>
          <span className="mt-0.5 block truncate text-3xs text-sidebar-foreground/60">
            {agent.projectName}
            {agent.checkoutLabel ? ` · ${agent.checkoutLabel}` : ""}
          </span>
          <span className="mt-1 block truncate text-3xs text-sidebar-foreground/75">
            {agent.activity}
          </span>
          {telemetry ? (
            <span className="mt-0.5 block truncate text-4xs text-sidebar-foreground/45">
              {telemetry}
            </span>
          ) : null}
        </span>
      </div>
      </button>
    </MotionLi>
  )
}

function LoadingRows() {
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Loading running agents">
      {["one", "two", "three"].map(id => (
        <li
          key={id}
          className="flex items-start gap-2.5 rounded-[var(--yaade-control-radius)] border border-sidebar-border/50 px-2.5 py-2.5"
        >
          <Skeleton className="size-7 shrink-0 rounded-[var(--yaade-control-radius)]" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
            <Skeleton className="h-2.5 w-3/5" />
            <Skeleton className="h-2 w-4/5" />
            <Skeleton className="h-2 w-2/5" />
          </span>
        </li>
      ))}
    </ul>
  )
}

function AgentsUnavailable(props: { error: string }) {
  return (
    <div className="flex min-h-24 flex-col items-center justify-center gap-1 px-3 py-5 text-center">
      <Bot className="size-4 text-destructive/80" aria-hidden />
      <p className="text-xs font-medium">Agents unavailable</p>
      <p className="text-3xs text-sidebar-foreground/55">{props.error}</p>
    </div>
  )
}

function NoAgents() {
  return (
    <div
      className="flex min-h-32 flex-col items-center justify-center gap-2 px-3 py-6 text-center"
      data-yaade-running-agents-empty=""
    >
      <span className="grid size-8 place-items-center rounded-full bg-sidebar-accent text-sidebar-foreground/55">
        <Bot className="size-4" aria-hidden />
      </span>
      <span className="text-xs font-medium">No agents</span>
    </div>
  )
}

function AgentList(props: {
  agents: readonly RunningAgentSidebarItem[]
  onSelect?: (agent: RunningAgentSidebarItem) => void
}) {
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Running agents">
      <AnimatePresence initial={false} mode="popLayout">
        {props.agents.map(agent => (
          <AgentRow
            key={agent.id}
            agent={agent}
            onSelect={props.onSelect}
          />
        ))}
      </AnimatePresence>
    </ul>
  )
}

function sidebarBody(props: {
  agents: readonly RunningAgentSidebarItem[]
  loading: boolean
  error: string | null
  onSelectAgent?: (agent: RunningAgentSidebarItem) => void
}) {
  if (props.loading) return <LoadingRows />
  if (props.error && props.agents.length === 0) {
    return <AgentsUnavailable error={props.error} />
  }
  if (props.agents.length === 0) return <NoAgents />
  return <AgentList agents={props.agents} onSelect={props.onSelectAgent} />
}

export function RunningAgentsSidebar({
  header,
  agents,
  loading = false,
  error = null,
  onSelectAgent,
  className,
}: RunningAgentsSidebarProps) {
  return (
    <SidebarShell
      aria-label="Running agents"
      className={cn(
        "w-64 shrink-0 border-sidebar-border/80 bg-sidebar text-sidebar-foreground",
        className,
      )}
      dataAttributes={{
        "data-yaade-running-agents-sidebar": "",
      }}
      headerClassName="min-h-12 border-sidebar-border/80 bg-sidebar/80 px-3"
      header={
        <div className="flex min-w-0 flex-1 items-center">
          {header}
        </div>
      }
      contentAs="nav"
      contentProps={{ "aria-label": "Running agent list" }}
      contentClassName="overflow-y-auto bg-sidebar/45 p-2"
    >
      {sidebarBody({ agents, loading, error, onSelectAgent })}
    </SidebarShell>
  )
}
