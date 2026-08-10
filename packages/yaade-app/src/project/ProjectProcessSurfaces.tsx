import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react"
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

type ProcessStatus = AgentRunInfo["processState"] | TerminalInstanceInfo["processState"]

type ProcessSurfaceEvent<T> =
  | { kind: "upsert"; item: T }
  | { kind: "remove"; id: string }
  | { kind: "refresh" }

type ProcessSurfaceAdapter<T extends { revision: number }> = {
  list: () => Promise<readonly T[]>
  subscribe: (onEvent: (event: ProcessSurfaceEvent<T>) => void) => (() => void) | undefined
  idOf: (item: T) => string
  getTranscript: (item: T) => Promise<string>
  restart?: (item: T) => Promise<T | null>
}

function useProcessSurface<T extends { revision: number }>({
  adapter,
  selectedId,
  onSelect,
}: {
  adapter: ProcessSurfaceAdapter<T>
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const [rows, setRows] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [transcript, setTranscript] = useState("")

  const refresh = useCallback(async () => {
    const next = await adapter.list()
    setRows([...next])
    setError(null)
    setLoading(false)
  }, [adapter])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void refresh().catch(reason => {
      if (cancelled) return
      setError(reason instanceof Error ? reason.message : String(reason))
      setLoading(false)
    })
    const unsubscribe = adapter.subscribe(event => {
      if (event.kind === "refresh") {
        void refresh().catch(() => undefined)
        return
      }
      if (event.kind === "remove") {
        setRows(current => current.filter(row => adapter.idOf(row) !== event.id))
        return
      }
      setRows(current =>
        upsertByRevision(current, adapter.idOf(event.item), event.item, adapter.idOf),
      )
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [adapter, refresh])

  const activeId = selectedId && rows.some(row => adapter.idOf(row) === selectedId)
    ? selectedId
    : rows[0] ? adapter.idOf(rows[0]) : null

  useEffect(() => {
    if (activeId !== selectedId) onSelect(activeId)
  }, [activeId, onSelect, selectedId])

  const selected = rows.find(row => adapter.idOf(row) === activeId) ?? null

  useEffect(() => {
    setTranscript("")
    if (!selected) return
    let cancelled = false
    void adapter.getTranscript(selected).then(value => {
      if (!cancelled) setTranscript(value)
    })
    return () => {
      cancelled = true
    }
  }, [adapter, selected])

  const restart = useCallback(() => {
    if (!selected || !adapter.restart) return
    void adapter.restart(selected)
      .then(next => {
        if (!next) return
        setRows(current =>
          upsertByRevision(current, adapter.idOf(next), next, adapter.idOf),
        )
      })
      .catch(reason =>
        showYaadeToast(
          reason instanceof Error ? reason.message : "Could not restart process",
          { variant: "destructive" },
        ),
      )
  }, [adapter, selected])

  return { selected, transcript, loading, error, restart }
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
  status: ProcessStatus
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
  const adapter = useMemo<ProcessSurfaceAdapter<AgentRunInfo>>(
    () => ({
      list: async () => {
        const api = window.yaade?.agents
        if (!api) throw new Error("Agent service unavailable")
        return api.listProject(projectId)
      },
      subscribe: onEvent =>
        window.yaade?.agents?.onEvent(event => {
          if (event.type !== "agents.run" || !event.run || event.run.projectId !== projectId) return
          if (event.kind === "run.ended") {
            onEvent({ kind: "refresh" })
            return
          }
          onEvent({ kind: "upsert", item: event.run })
        }),
      idOf: run => run.runId,
      getTranscript: async run => {
        const value = await window.yaade?.agents?.getTranscript(run.runId)
        return value?.output ?? ""
      },
    }),
    [projectId],
  )
  const { selected, transcript, loading, error } = useProcessSurface({
    adapter,
    selectedId,
    onSelect,
  })

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
  const adapter = useMemo<ProcessSurfaceAdapter<TerminalInstanceInfo>>(
    () => ({
      list: async () => {
        const api = window.yaade?.terminal
        if (!api) throw new Error("Terminal service unavailable")
        return api.listInstances(projectId)
      },
      subscribe: onEvent =>
        window.yaade?.terminal?.onInstanceEvent(event => {
          const instance = event.instance
          if (instance.projectId !== projectId) return
          if (event.kind === "instance.removed") {
            onEvent({ kind: "remove", id: instance.id })
            return
          }
          onEvent({ kind: "upsert", item: instance })
        }),
      idOf: instance => instance.id,
      getTranscript: async instance => {
        const value = await window.yaade?.terminal?.getInstanceTranscript(instance.id)
        return value?.output ?? ""
      },
      restart: async instance => {
        const api = window.yaade?.terminal
        if (!api) throw new Error("Terminal service unavailable")
        return api.restartInstance({ id: instance.id, generation: instance.generation })
      },
    }),
    [projectId],
  )
  const { selected, transcript, loading, error, restart } = useProcessSurface({
    adapter,
    selectedId,
    onSelect,
  })

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
