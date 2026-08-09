import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import {
  AgentCommandEnvelope,
  AgentConnectionState,
  type AgentActionResponse,
  type AgentDriverDiscovery,
  type AgentThreadSnapshot,
} from "@yaade/agent-protocol"
import { pathToFileUri } from "@yaade/shared"
import {
  AgentChatView,
  buildProviderInstanceEntries,
  defaultSelectionForInstances,
  requestConfirm,
  showYaadeToast,
  type AgentComposerAttachment,
  type ChatComposerSubmitPayload,
  type ProviderOptionSelection,
} from "@yaade/ui"
import { cn } from "@yaade/ui/project"
import { Button, Skeleton } from "@yaade/ui/primitives"
import { Bot, Plus, Trash2, X } from "lucide-react"
import { Schema } from "effect"
import { AgentRuntimeClient } from "./runtime-client.js"

export type MuxAgentChatPaneProps = {
  projectSessionId: string
  cwdPath: string
  initialThreadId?: string | null
  onThreadSelected?: (threadId: string | null) => void
}

export default function MuxAgentChatPane({
  projectSessionId,
  cwdPath,
  initialThreadId = null,
  onThreadSelected,
}: MuxAgentChatPaneProps) {
  const api = window.yaade?.agentRuntime
  const client = useMemo(() => (api ? new AgentRuntimeClient(api) : null), [api])
  const [threadId, setThreadId] = useState<string | null>(initialThreadId)
  const [threads, setThreads] = useState<AgentThreadSnapshot[]>([])
  const [drivers, setDrivers] = useState<AgentDriverDiscovery[]>([])
  const [loading, setLoading] = useState(true)
  const [sendBusy, setSendBusy] = useState(false)
  const [threadAction, setThreadAction] = useState<"close" | "delete" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeInstanceId, setActiveInstanceId] = useState<string>("")
  const [model, setModel] = useState<string>("")
  const [modelOptions, setModelOptions] = useState<
    ReadonlyArray<ProviderOptionSelection> | undefined
  >(undefined)
  const actionCommandIds = useRef(new Map<string, string>())

  const selected = useSyncExternalStore(
    client?.store.subscribe.bind(client.store) ?? (() => () => {}),
    () => (threadId && client ? client.store.getThread(threadId) : EMPTY_SELECTION),
  )

  const { instanceEntries, modelOptionsByInstance } = useMemo(() => {
    return buildProviderInstanceEntries(
      drivers.map(discovery => ({
        id: String(discovery.descriptor.id),
        name: discovery.descriptor.name,
        providerId: String(discovery.descriptor.providerId),
        integration: discovery.descriptor.integration,
        available: discovery.available,
        reason: discovery.reason,
      })),
    )
  }, [drivers])

  useEffect(() => {
    if (activeInstanceId && instanceEntries.some(entry => entry.instanceId === activeInstanceId)) {
      return
    }
    const defaults = defaultSelectionForInstances(instanceEntries)
    if (!defaults) {
      setActiveInstanceId("")
      setModel("")
      return
    }
    setActiveInstanceId(defaults.instanceId)
    setModel(defaults.model)
    setModelOptions(undefined)
  }, [activeInstanceId, instanceEntries])

  const load = useCallback(async () => {
    if (!api || !client) {
      setError("The host does not provide the interactive agent runtime.")
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [nextThreads, nextDrivers] = await Promise.all([
        api.listThreads(projectSessionId),
        api.listDrivers(pathToFileUri(cwdPath)),
      ])
      setThreads(nextThreads)
      setDrivers(nextDrivers)
      for (const snapshot of nextThreads) client.hydrate(snapshot)
      // Draft-first: only auto-select when an initial thread was requested.
      const nextId =
        (threadId && nextThreads.some(item => String(item.state.id) === threadId)
          ? threadId
          : null) ??
        (initialThreadId &&
        nextThreads.some(item => String(item.state.id) === initialThreadId)
          ? initialThreadId
          : null)
      setThreadId(nextId)
      onThreadSelected?.(nextId)
      setError(null)
    } catch (cause) {
      setError(message(cause, "Could not load agent threads."))
    } finally {
      setLoading(false)
    }
  }, [api, client, cwdPath, initialThreadId, onThreadSelected, projectSessionId, threadId])

  useEffect(() => {
    void load()
    return () => client?.close()
    // The selected thread is intentionally not a load dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, client, projectSessionId])

  useEffect(() => {
    if (!api || !client) return
    return client.onRegistryChanged(() => {
      void api.listDrivers(pathToFileUri(cwdPath)).then(setDrivers).catch(() => {})
    })
  }, [api, client, cwdPath])

  const selectThread = useCallback(
    (nextThreadId: string | null) => {
      setThreadId(nextThreadId)
      onThreadSelected?.(nextThreadId)
    },
    [onThreadSelected],
  )

  const startDraft = useCallback(() => {
    selectThread(null)
  }, [selectThread])

  const closeThread = useCallback(async () => {
    if (!api || !client || !threadId) return
    setThreadAction("close")
    try {
      const snapshot = await api.closeThread(threadId)
      client.hydrate(snapshot)
      setThreads(current =>
        current.map(item => (String(item.state.id) === threadId ? snapshot : item)),
      )
    } catch (cause) {
      showYaadeToast(message(cause, "Could not close the agent thread."), {
        variant: "destructive",
      })
    } finally {
      setThreadAction(null)
    }
  }, [api, client, threadId])

  const deleteThread = useCallback(async () => {
    if (!api || !threadId) return
    const confirmed = await requestConfirm({
      title: "Delete native agent thread?",
      description:
        "This removes the durable YAADE thread, its events, and uploaded attachments.",
      confirmLabel: "Delete thread",
      cancelLabel: "Cancel",
      destructive: true,
    })
    if (!confirmed) return
    setThreadAction("delete")
    try {
      await api.deleteThread(threadId)
      const remaining = threads.filter(item => String(item.state.id) !== threadId)
      setThreads(remaining)
      selectThread(null)
    } catch (cause) {
      showYaadeToast(message(cause, "Could not delete the agent thread."), {
        variant: "destructive",
      })
    } finally {
      setThreadAction(null)
    }
  }, [api, selectThread, threadId, threads])

  const sendToThread = useCallback(
    async (
      targetThreadId: string,
      command: AgentCommandEnvelope["command"],
      expectedRevision?: number,
      commandId: string = crypto.randomUUID(),
    ) => {
      if (!api) return
      const envelope = Schema.decodeUnknownSync(AgentCommandEnvelope)({
        protocolVersion: 1,
        commandId,
        threadId: targetThreadId,
        issuedAt: new Date().toISOString(),
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
        command,
      })
      const result = await api.sendCommand(envelope)
      if (result.status === "rejected") {
        throw new Error(result.error.message)
      }
    },
    [api],
  )

  const applyModelConfiguration = useCallback(
    async (
      targetThreadId: string,
      snapshot: AgentThreadSnapshot,
      payload: ChatComposerSubmitPayload,
    ) => {
      const liveOptions = snapshot.state.configuration
      const desired = new Map<string, string | boolean | number>()
      desired.set("model", payload.model)
      for (const option of payload.modelOptions ?? []) {
        desired.set(option.id, option.value)
      }
      // Common aliases used by ACP drivers
      const reasoning = payload.modelOptions?.find(option => option.id === "reasoningEffort")
      if (reasoning && typeof reasoning.value === "string") {
        desired.set("thought_level", reasoning.value)
        desired.set("reasoning", reasoning.value)
      }

      for (const [optionId, value] of desired) {
        const advertised = liveOptions.find(option => option.id === optionId)
        if (!advertised) continue
        try {
          await sendToThread(
            targetThreadId,
            { type: "configuration.set", optionId, value },
            snapshot.state.revision,
          )
        } catch {
          // Best-effort: skip options the live session rejects.
        }
      }
    },
    [sendToThread],
  )

  const handleComposerSubmit = useCallback(
    async (payload: ChatComposerSubmitPayload) => {
      if (!api || !client) {
        showYaadeToast("The host does not provide the interactive agent runtime.", {
          variant: "destructive",
        })
        return
      }
      const entry = instanceEntries.find(item => item.instanceId === payload.instanceId)
      if (!entry?.available) {
        showYaadeToast(entry?.unavailableReason ?? "Selected provider is unavailable.", {
          variant: "destructive",
        })
        return
      }

      setSendBusy(true)
      setError(null)
      try {
        let targetThreadId = threadId
        let snapshot = selected.snapshot

        if (!targetThreadId || !snapshot) {
          snapshot = await api.createThread({
            projectSessionId,
            cwdUri: pathToFileUri(cwdPath),
            driverId: payload.yaadeDriverId,
          })
          client.hydrate(snapshot)
          targetThreadId = String(snapshot.state.id)
          setThreads(current => [snapshot!, ...current])
          selectThread(targetThreadId)
          await applyModelConfiguration(targetThreadId, snapshot, payload)
          // Refresh snapshot after config if possible
          snapshot = client.store.getThread(targetThreadId).snapshot ?? snapshot
        }

        await sendToThread(
          targetThreadId,
          {
            type: "turn.submit",
            input: [{ type: "text", text: payload.text }],
          },
          snapshot.state.revision,
        )
      } catch (cause) {
        const detail = message(cause, "Could not send message.")
        setError(detail)
        showYaadeToast(detail, { variant: "destructive" })
      } finally {
        setSendBusy(false)
      }
    },
    [
      api,
      applyModelConfiguration,
      client,
      cwdPath,
      instanceEntries,
      projectSessionId,
      selectThread,
      selected.snapshot,
      sendToThread,
      threadId,
    ],
  )

  if (loading) {
    return (
      <div className="flex h-full flex-col gap-3 p-4" data-yaade-tool-pane="agentChat">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="min-h-0 flex-1" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  const snapshot = selected.snapshot
  const runningTurn = snapshot?.state.turns.find(turn => turn.status === "running")
  const connection = !snapshot
    ? null
    : selected.recovering
      ? AgentConnectionState.make({
          status: "reconnecting",
          generation: snapshot.state.connectionGeneration,
        })
      : (selected.connection ??
        AgentConnectionState.make({
          status: snapshot.state.status === "closed" ? "disconnected" : "connecting",
          generation: snapshot.state.connectionGeneration,
        }))

  return (
    <div className="flex h-full min-h-0 flex-row" data-yaade-tool-pane="agentChat">
      <aside
        className="flex w-56 shrink-0 flex-col border-r border-border bg-secondary/10"
        data-yaade-native-agent-sidebar=""
        aria-label="Agents in this worktree"
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2.5">
        <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">Agents</span>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            data-yaade-native-agent-new=""
            onClick={startDraft}
          >
            <Plus data-icon="inline-start" />
            New
          </Button>
        </div>
        <nav
          className="min-h-0 flex-1 overflow-y-auto p-1.5"
          data-yaade-list-panel="native-agent-threads"
        >
          <button
            type="button"
            data-yaade-list-item=""
            data-yaade-native-agent-draft=""
            aria-current={threadId === null ? "true" : undefined}
            className={cn(
              "mb-1 flex w-full shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
              threadId === null
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
            onClick={startDraft}
          >
            <Plus className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate font-medium">New agent</span>
          </button>
          {threads.length === 0 ? (
            <p className="px-2 py-3 text-3xs text-muted-foreground">
              No agents in this worktree yet.
            </p>
          ) : (
            threads.map((item, index) => {
              const id = String(item.state.id)
              const selectedThread = threadId === id
              const running = item.state.turns.some(turn => turn.status === "running")
              const status =
                item.state.status === "closed"
                  ? "Closed"
                  : running
                    ? "Working"
                    : item.state.status.replaceAll("-", " ")
              return (
                <div
                  key={id}
                  data-yaade-list-item=""
                  className={cn(
                    "group mb-0.5 flex w-full shrink-0 items-stretch gap-0.5 rounded-md",
                    selectedThread && "bg-accent",
                  )}
                >
                  <button
                    type="button"
                    data-yaade-native-agent-thread={id}
                    aria-current={selectedThread ? "true" : undefined}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                      selectedThread
                        ? "text-accent-foreground"
                        : "hover:bg-accent/60",
                    )}
                    onClick={() => selectThread(id)}
                  >
                    <Bot className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">
                        {item.state.providerId} · Thread {threads.length - index}
                      </span>
                      <span className="block truncate text-3xs text-muted-foreground capitalize">
                        {status}
                      </span>
                    </span>
                  </button>
                  {selectedThread ? (
                    <div className="flex shrink-0 items-center gap-0.5 pr-1">
                      {item.state.status !== "closed" ? (
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          disabled={threadAction !== null}
                          aria-label="Close thread"
                          data-yaade-native-agent-close=""
                          onClick={() => void closeThread()}
                        >
                          <X />
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        disabled={threadAction !== null}
                        aria-label="Delete thread"
                        data-yaade-native-agent-delete=""
                        onClick={() => void deleteThread()}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ) : null}
      </div>
              )
            })
          )}
        </nav>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {error ? (
        <p
          role="alert"
          className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
      <AgentChatView
        snapshot={snapshot}
        connection={connection}
        showDraftHero={!snapshot}
        composer={{
          instanceEntries,
          modelOptionsByInstance,
          activeInstanceId,
          model,
          modelOptions,
          isSendBusy: sendBusy,
          onInstanceModelChange: (instanceId, nextModel) => {
            setActiveInstanceId(instanceId)
            setModel(nextModel)
            setModelOptions(undefined)
          },
          onModelOptionsChange: next => setModelOptions(next),
        }}
        onComposerSubmit={handleComposerSubmit}
        onUploadAttachment={async file => {
          if (!api || !threadId) throw new Error("Agent thread is not connected")
          const contentBase64 = await fileAsBase64(file)
          const uploaded = await api.uploadAttachment({
            threadId,
            name: file.name,
            mediaType: file.type || "application/octet-stream",
            contentBase64,
          })
          return {
            ...uploaded,
            kind: "upload",
          } satisfies AgentComposerAttachment
        }}
        onInterrupt={() => {
          if (!runningTurn || !threadId) return
          void sendToThread(threadId, { type: "turn.interrupt", turnId: runningTurn.id }).catch(
            cause =>
              showYaadeToast(message(cause, "Could not interrupt the agent."), {
                variant: "destructive",
              }),
          )
        }}
        onRespondToAction={async (actionId, response) => {
          if (!threadId || !snapshot) return
          const commandId = actionCommandIds.current.get(actionId) ?? crypto.randomUUID()
          actionCommandIds.current.set(actionId, commandId)
          await sendToThread(
            threadId,
            {
              type: "action.respond",
              actionId: actionId as never,
              response: response as AgentActionResponse,
            },
            snapshot.state.revision,
            commandId,
          )
          actionCommandIds.current.delete(actionId)
        }}
        onConfigurationChange={async (optionId, value) => {
          if (!threadId || !snapshot) return
          await sendToThread(
            threadId,
            { type: "configuration.set", optionId, value },
            snapshot.state.revision,
          )
        }}
      />
      </div>
    </div>
  )
}

const EMPTY_SELECTION = {
  snapshot: null,
  lastSequence: 0,
  gapDetected: false,
  recovering: false,
} as const

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

async function fileAsBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  let binary = ""
  const bytes = new Uint8Array(buffer)
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!)
  }
  return btoa(binary)
}
