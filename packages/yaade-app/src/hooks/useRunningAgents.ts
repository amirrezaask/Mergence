import { useCallback, useEffect, useRef, useState } from "react"
import type { ToolUseId } from "@yaade/rpc"
import type { RunningAgentSidebarItem } from "@yaade/ui/session"
import type { AgentRunInfo } from "@yaade/workspace"

const LIVE_PROCESS_STATES = new Set<AgentRunInfo["processState"]>([
  "starting",
  "running",
])

function isLiveAgent(run: AgentRunInfo): boolean {
  return LIVE_PROCESS_STATES.has(run.processState)
}

function sortAgents(agents: readonly AgentRunInfo[]): AgentRunInfo[] {
  return [...agents].sort((left, right) => {
    const leftAt = left.startedAt ?? left.createdAt
    const rightAt = right.startedAt ?? right.createdAt
    return rightAt.localeCompare(leftAt)
  })
}

function agentActivityLabel(status: AgentRunInfo["activityState"]): string {
  switch (status) {
    case "starting":
      return "Starting"
    case "working":
      return "Working"
    case "running_tool":
      return "Running a tool"
    case "waiting_for_permission":
      return "Needs permission"
    case "waiting_for_user":
      return "Waiting for you"
    case "idle":
      return "Idle"
    case "failed":
      return "Failed"
  }
}

function pathLeaf(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "")
  return normalized.split("/").pop() || value
}

export function toRunningAgentSidebarItems(
  agents: readonly AgentRunInfo[],
  toolUseIdByPty: ReadonlyMap<string, ToolUseId>,
  projectNamesById: ReadonlyMap<string, string>,
): RunningAgentSidebarItem[] {
  return agents.map(agent => ({
    id: agent.runId,
    provider: agent.provider,
    title: agent.title.trim(),
    toolUseId:
      agent.toolUseId ??
      (agent.ptyId ? (toolUseIdByPty.get(agent.ptyId) ?? null) : null),
    ptyId: agent.ptyId,
    projectName: projectNamesById.get(agent.projectId) ?? agent.projectId,
    checkoutLabel: pathLeaf(agent.checkoutPath),
    activity: agentActivityLabel(agent.activityState),
    status: agent.activityState,
    telemetry: agent.telemetryState,
  }))
}

export type RunningAgentsState = {
  agents: readonly AgentRunInfo[]
  loading: boolean
  error: string | null
}

/** Subscribe to the host-owned process roster without polling on every render. */
export function useRunningAgents(): RunningAgentsState {
  const [agents, setAgents] = useState<readonly AgentRunInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)
  const refreshTimer = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    const api = window.yaade?.agents
    if (!api) {
      setAgents([])
      setError(null)
      setLoading(false)
      return
    }
    const request = ++sequence.current
    try {
      const next = await api.listLive()
      if (request !== sequence.current) return
      setAgents(sortAgents(next.filter(isLiveAgent)))
      setError(null)
    } catch (cause) {
      if (request !== sequence.current) return
      setError(
        cause instanceof Error ? cause.message : "Could not load running agents",
      )
    } finally {
      if (request === sequence.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    void refresh()

    const scheduleRefresh = () => {
      if (refreshTimer.current !== null) return
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null
        void refresh()
      }, 120)
    }

    const agentsApi = window.yaade?.agents
    const terminalApi = window.yaade?.terminal
    const disposeAgentEvents = agentsApi?.onEvent(event => {
      const run = event.run
      if (event.type === "agents.run" && run) {
        sequence.current += 1
        setAgents(previous => {
          const withoutCurrent = previous.filter(agent => agent.runId !== run.runId)
          return isLiveAgent(run)
            ? sortAgents([...withoutCurrent, run])
            : withoutCurrent
        })
        setError(null)
        setLoading(false)
        return
      }
      scheduleRefresh()
    })
    const disposeInstanceEvents = terminalApi?.onInstanceEvent(scheduleRefresh)
    const disposeTerminalExit = terminalApi?.onExit(scheduleRefresh)
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh()
    }

    const interval = window.setInterval(() => void refresh(), 15_000)
    window.addEventListener("focus", onVisibilityChange)
    window.addEventListener("yaade:host-reconnected", onVisibilityChange)
    document.addEventListener("visibilitychange", onVisibilityChange)

    return () => {
      if (refreshTimer.current !== null) {
        window.clearTimeout(refreshTimer.current)
        refreshTimer.current = null
      }
      window.clearInterval(interval)
      disposeAgentEvents?.()
      disposeInstanceEvents?.()
      disposeTerminalExit?.()
      window.removeEventListener("focus", onVisibilityChange)
      window.removeEventListener("yaade:host-reconnected", onVisibilityChange)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [refresh])

  return { agents, loading, error }
}
