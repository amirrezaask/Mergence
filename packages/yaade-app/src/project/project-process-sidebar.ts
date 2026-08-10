import { useCallback, useEffect, useState } from "react"
import type { AgentRunInfo, TerminalInstanceInfo } from "@yaade/workspace"
import { showYaadeToast } from "@yaade/ui/toast"

function upsertByRevision<T extends { revision: number }>(
  rows: readonly T[],
  id: string,
  next: T,
  idOf: (row: T) => string,
): T[] {
  const index = rows.findIndex(row => idOf(row) === id)
  if (index < 0) return [next, ...rows]
  if (rows[index]!.revision >= next.revision) return [...rows]
  const copy = [...rows]
  copy[index] = next
  return copy
}

export function processStatusLabel(
  status: AgentRunInfo["processState"] | TerminalInstanceInfo["processState"],
): string {
  if (status === "running" || status === "starting") return status
  if (status === "disconnected") return "offline"
  return "exited"
}

export function useProjectProcessSidebar(
  projectId: string,
  checkoutKey: string,
  checkoutPath: string,
) {
  const [agents, setAgents] = useState<AgentRunInfo[]>([])
  const [terminals, setTerminals] = useState<TerminalInstanceInfo[]>([])
  const [agentLoading, setAgentLoading] = useState(true)
  const [terminalLoading, setTerminalLoading] = useState(true)
  const [agentError, setAgentError] = useState<string | null>(null)
  const [terminalError, setTerminalError] = useState<string | null>(null)

  const refreshAgents = useCallback(async () => {
    const api = window.yaade?.agents
    if (!api) throw new Error("Agent service unavailable")
    setAgents(await api.listProject(projectId))
    setAgentError(null)
    setAgentLoading(false)
  }, [projectId])

  const refreshTerminals = useCallback(async () => {
    const api = window.yaade?.terminal
    if (!api) throw new Error("Terminal service unavailable")
    setTerminals(await api.listInstances(projectId))
    setTerminalError(null)
    setTerminalLoading(false)
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    setAgentLoading(true)
    void refreshAgents().catch(reason => {
      if (cancelled) return
      setAgentError(reason instanceof Error ? reason.message : String(reason))
      setAgentLoading(false)
    })
    const unsubscribe = window.yaade?.agents?.onEvent(event => {
      if (event.type !== "agents.run" || !event.run || event.run.projectId !== projectId) return
      if (event.kind === "run.ended") {
        void refreshAgents().catch(() => undefined)
        return
      }
      setAgents(current => upsertByRevision(current, event.run!.runId, event.run!, row => row.runId))
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [projectId, refreshAgents])

  useEffect(() => {
    let cancelled = false
    setTerminalLoading(true)
    void refreshTerminals().catch(reason => {
      if (cancelled) return
      setTerminalError(reason instanceof Error ? reason.message : String(reason))
      setTerminalLoading(false)
    })
    const unsubscribe = window.yaade?.terminal?.onInstanceEvent(event => {
      if (event.instance.projectId !== projectId) return
      if (event.kind === "instance.removed") {
        setTerminals(current => current.filter(item => item.id !== event.instance.id))
        return
      }
      setTerminals(current => upsertByRevision(current, event.instance.id, event.instance, row => row.id))
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [projectId, refreshTerminals])

  const createTerminal = useCallback(async (checkout?: {
    checkoutKey: string
    checkoutPath: string
  }) => {
    const api = window.yaade?.terminal
    if (!api) throw new Error("Terminal service unavailable")
    const instance = await api.createInstance({
      projectId,
      checkoutKey: checkout?.checkoutKey ?? checkoutKey,
      checkoutPath: checkout?.checkoutPath ?? checkoutPath,
    })
    setTerminals(current => upsertByRevision(current, instance.id, instance, row => row.id))
    return instance.id
  }, [checkoutKey, checkoutPath, projectId])

  const closeAgent = useCallback(async (run: AgentRunInfo) => {
    try {
      await window.yaade?.agents?.close({ runId: run.runId, generation: run.generation })
      setAgents(current => current.filter(item => item.runId !== run.runId))
    } catch (error) {
      showYaadeToast(error instanceof Error ? error.message : "Could not close agent", {
        variant: "destructive",
      })
    }
  }, [])

  const closeTerminal = useCallback(async (instance: TerminalInstanceInfo) => {
    try {
      await window.yaade?.terminal?.closeInstance({ id: instance.id, generation: instance.generation })
      setTerminals(current => current.filter(item => item.id !== instance.id))
    } catch (error) {
      showYaadeToast(error instanceof Error ? error.message : "Could not close terminal", {
        variant: "destructive",
      })
    }
  }, [])

  return {
    agents,
    terminals,
    agentLoading,
    terminalLoading,
    agentError,
    terminalError,
    createTerminal,
    closeAgent,
    closeTerminal,
  }
}
