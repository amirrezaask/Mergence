import { lazy, Suspense, useCallback, useEffect, useState } from "react"
import type { YaadeTheme } from "@yaade/shared"
import {
  type AgentRunInfo,
  type TerminalInstanceInfo,
} from "@yaade/workspace"
import { Circle, RotateCcw } from "lucide-react"
import { Button } from "@yaade/ui/primitives"
import { pathToFileUri } from "@yaade/shared"
import { showYaadeToast } from "@yaade/ui/toast"

const TerminalPanel = lazy(() =>
  import("@yaade/ui/terminal").then(module => ({ default: module.TerminalPanel })),
)

function terminalStatus(status: TerminalInstanceInfo["processState"] | AgentRunInfo["processState"]): string {
  return status === "running" || status === "starting" ? status : status === "disconnected" ? "disconnected" : "exited"
}

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

function ProcessDetail({
  id,
  ptyId,
  cwdPath,
  title,
  status,
  exitCode,
  generation,
  transcript,
  theme,
  onRestart,
}: {
  id: string
  ptyId: string | null
  cwdPath: string
  title: string
  status: "reserved" | "starting" | "running" | "exited" | "failed" | "disconnected"
  exitCode: number | null
  generation: number
  transcript: string
  theme: YaadeTheme
  onRestart?: () => void
}) {
  const live = (status === "running" || status === "starting" || status === "reserved") && ptyId
  return (
    <div className="relative min-w-0 flex-1" data-yaade-process-detail={id}>
      <Suspense
        fallback={
          <div className="grid h-full place-items-center text-xs text-muted-foreground" role="status">
            Opening terminal…
          </div>
        }
      >
      {live ? (
        <TerminalPanel
          cwdRootUri={pathToFileUri(cwdPath)}
          theme={theme}
          tabId={id}
          focused
          isActive
          existingPtyId={ptyId}
          status={status === "reserved" ? "starting" : status}
          sessionGeneration={generation}
          attachOnly
        />
      ) : transcript ? (
        <TerminalPanel
          cwdRootUri={pathToFileUri(cwdPath)}
          theme={theme}
          tabId={id}
          focused
          isActive
          initialOutput={transcript}
          status="exited"
          exitCode={exitCode ?? undefined}
          sessionGeneration={generation}
          readOnly
          attachOnly
        />
      ) : (
        <div className="grid h-full place-items-center px-6 text-center">
          <div className="flex max-w-md flex-col items-center gap-3">
            <Circle className="size-2 fill-current text-muted-foreground" aria-hidden />
            <div>
              <h2 className="text-sm font-medium">{title}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {status === "disconnected"
                  ? "The host restarted, so this process can no longer be attached."
                  : status === "reserved" || status === "starting"
                    ? "Starting process…"
                  : status === "failed"
                    ? "The process could not be started."
                    : `Process exited${exitCode == null ? "" : ` with code ${exitCode}`}.`}
              </p>
            </div>
            {onRestart ? (
              <Button variant="secondary" size="sm" onClick={onRestart}>
                <RotateCcw data-icon="inline-start" />
                Restart
              </Button>
            ) : null}
          </div>
        </div>
      )}
      </Suspense>
    </div>
  )
}

export function AgentsProjectSurface({
  projectId,
  selectedId,
  theme,
  onSelect,
}: {
  projectId: string
  selectedId: string | null
  theme: YaadeTheme
  onSelect: (id: string | null) => void
}) {
  const [runs, setRuns] = useState<AgentRunInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [transcript, setTranscript] = useState("")

  const refresh = useCallback(async () => {
    const api = window.yaade?.agents
    if (!api) throw new Error("Agent service unavailable")
    const next = await api.listProject(projectId)
    setRuns(next)
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
    const unsubscribe = window.yaade?.agents?.onEvent(event => {
      if (event.type !== "agents.run" || !event.run || event.run.projectId !== projectId) return
      if (event.kind === "run.ended") {
        void refresh().catch(() => undefined)
        return
      }
      setRuns(current => upsertByRevision(current, event.run!.runId, event.run!, row => row.runId))
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [projectId, refresh])

  const activeId = selectedId && runs.some(run => run.runId === selectedId)
    ? selectedId
    : runs[0]?.runId ?? null
  useEffect(() => {
    if (activeId !== selectedId) onSelect(activeId)
  }, [activeId, onSelect, selectedId])

  const selected = runs.find(run => run.runId === activeId) ?? null
  useEffect(() => {
    setTranscript("")
    if (!selected || selected.processState === "running" || selected.processState === "starting") return
    let cancelled = false
    void window.yaade?.agents?.getTranscript(selected.runId).then(value => {
      if (!cancelled) setTranscript(value?.output ?? "")
    })
    return () => { cancelled = true }
  }, [selected?.processState, selected?.revision, selected?.runId])

  return (
    <div className="flex h-full min-h-0" data-yaade-project-panel="agents">
      {selected ? (
        <ProcessDetail
          id={selected.runId}
          ptyId={selected.ptyId}
          cwdPath={selected.checkoutPath}
          title={selected.title}
          status={selected.processState}
          exitCode={selected.exitCode}
          generation={selected.generation}
          transcript={transcript}
          theme={theme}
        />
      ) : (
        <div className="grid min-w-0 flex-1 place-items-center text-xs text-muted-foreground">
          {error ?? (loading ? "Loading agents…" : "Launch an agent to start working.")}
        </div>
      )}
    </div>
  )
}

export function TerminalsProjectSurface({
  projectId,
  selectedId,
  theme,
  onSelect,
}: {
  projectId: string
  selectedId: string | null
  theme: YaadeTheme
  onSelect: (id: string | null) => void
}) {
  const [instances, setInstances] = useState<TerminalInstanceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [transcript, setTranscript] = useState("")

  const refresh = useCallback(async () => {
    const api = window.yaade?.terminal
    if (!api) throw new Error("Terminal service unavailable")
    const next = await api.listInstances(projectId)
    setInstances(next)
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
      const instance = event.instance
      if (instance.projectId !== projectId) return
      if (event.kind === "instance.removed") {
        setInstances(current => current.filter(item => item.id !== instance.id))
        return
      }
      setInstances(current => upsertByRevision(current, instance.id, instance, row => row.id))
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [projectId, refresh])

  const activeId = selectedId && instances.some(instance => instance.id === selectedId)
    ? selectedId
    : instances[0]?.id ?? null
  useEffect(() => {
    if (activeId !== selectedId) onSelect(activeId)
  }, [activeId, onSelect, selectedId])

  const selected = instances.find(instance => instance.id === activeId) ?? null
  useEffect(() => {
    setTranscript("")
    if (!selected || selected.processState === "running" || selected.processState === "starting") return
    let cancelled = false
    void window.yaade?.terminal?.getInstanceTranscript(selected.id).then(value => {
      if (!cancelled) setTranscript(value?.output ?? "")
    })
    return () => { cancelled = true }
  }, [selected?.processState, selected?.revision, selected?.id])

  const restart = useCallback(() => {
    if (!selected) return
    void window.yaade?.terminal?.restartInstance({ id: selected.id, generation: selected.generation })
      .then(instance => {
        if (instance) setInstances(current => upsertByRevision(current, instance.id, instance, row => row.id))
      })
      .catch(reason => showYaadeToast(reason instanceof Error ? reason.message : "Could not restart terminal", { variant: "destructive" }))
  }, [selected])

  return (
    <div className="flex h-full min-h-0" data-yaade-project-panel="terminals">
      {selected ? (
        <ProcessDetail
          id={selected.id}
          ptyId={selected.ptyId}
          cwdPath={selected.checkoutPath}
          title={selected.title}
          status={selected.processState}
          exitCode={selected.exitCode}
          generation={selected.generation}
          transcript={transcript}
          theme={theme}
          onRestart={selected.processState === "running" || selected.processState === "starting" ? undefined : restart}
        />
      ) : (
        <div className="grid min-w-0 flex-1 place-items-center text-xs text-muted-foreground">
          {error ?? (loading ? "Loading terminals…" : "Create a terminal in Main or a worktree.")}
        </div>
      )}
    </div>
  )
}
