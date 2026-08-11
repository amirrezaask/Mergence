import { useCallback, useEffect, useState } from "react"
import type { TerminalInstanceInfo } from "@yaade/workspace"
import { showYaadeToast } from "@yaade/ui/toast"

function upsertByRevision(
  rows: readonly TerminalInstanceInfo[],
  next: TerminalInstanceInfo,
): TerminalInstanceInfo[] {
  const index = rows.findIndex(row => row.id === next.id)
  if (index < 0) return [next, ...rows]
  if (rows[index]!.revision >= next.revision) return [...rows]
  const copy = [...rows]
  copy[index] = next
  return copy
}

export function processStatusLabel(
  status: TerminalInstanceInfo["processState"],
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
  const [processes, setProcesses] = useState<TerminalInstanceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const api = window.yaade?.terminal
    if (!api) throw new Error("Terminal service unavailable")
    setProcesses(await api.listInstances(projectId))
    setError(null)
    setLoading(false)
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void refresh().catch(reason => {
      if (cancelled) return
      setError(reason instanceof Error ? reason.message : String(reason))
      setLoading(false)
    })
    const unsubscribe = window.yaade?.terminal?.onInstanceEvent(event => {
      if (event.instance.projectId !== projectId) return
      if (event.kind === "instance.removed") {
        setProcesses(current => current.filter(item => item.id !== event.instance.id))
        return
      }
      setProcesses(current => upsertByRevision(current, event.instance))
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [projectId, refresh])

  const createTerminal = useCallback(async (checkout?: {
    checkoutKey: string
    checkoutPath: string
    workspaceId?: string | null
  }) => {
    const api = window.yaade?.terminal
    if (!api) throw new Error("Terminal service unavailable")
    const instance = await api.createInstance({
      projectId,
      checkoutKey: checkout?.checkoutKey ?? checkoutKey,
      checkoutPath: checkout?.checkoutPath ?? checkoutPath,
      ...(checkout?.workspaceId ? { workspaceId: checkout.workspaceId } : {}),
    })
    setProcesses(current => upsertByRevision(current, instance))
    return instance.id
  }, [checkoutKey, checkoutPath, projectId])

  const createAgent = useCallback(async (input: {
    provider: NonNullable<TerminalInstanceInfo["provider"]>
    workspaceId: string
    launchRequestId: string
    checkoutKey?: string
    checkoutPath?: string
    title?: string
    args?: string[]
  }) => {
    const api = window.yaade?.terminal
    if (!api) throw new Error("Terminal service unavailable")
    const instance = await api.createInstance({
      projectId,
      provider: input.provider,
      workspaceId: input.workspaceId,
      launchRequestId: input.launchRequestId,
      checkoutKey: input.checkoutKey ?? checkoutKey,
      checkoutPath: input.checkoutPath ?? checkoutPath,
      title: input.title,
      args: input.args,
    })
    setProcesses(current => upsertByRevision(current, instance))
    return instance
  }, [checkoutKey, checkoutPath, projectId])

  const closeProcess = useCallback(async (instance: TerminalInstanceInfo) => {
    try {
      await window.yaade?.terminal?.closeInstance({
        id: instance.id,
        generation: instance.generation,
      })
      setProcesses(current => current.filter(item => item.id !== instance.id))
    } catch (error) {
      showYaadeToast(error instanceof Error ? error.message : "Could not close process", {
        variant: "destructive",
      })
    }
  }, [])

  return {
    processes,
    loading,
    error,
    createTerminal,
    createAgent,
    closeProcess,
  }
}
