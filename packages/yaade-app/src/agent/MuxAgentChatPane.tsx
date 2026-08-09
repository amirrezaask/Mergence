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
  showYaadeToast,
  type AgentComposerAttachment,
} from "@yaade/ui"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@yaade/ui/primitives"
import { Bot, RefreshCw } from "lucide-react"
import { Schema } from "effect"
import { AgentRuntimeClient } from "./runtime-client.js"

export type MuxAgentChatPaneProps = {
  projectSessionId: string
  cwdPath: string
  initialThreadId?: string | null
  onThreadSelected?: (threadId: string) => void
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
  const [creatingDriverId, setCreatingDriverId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const actionCommandIds = useRef(new Map<string, string>())

  const selected = useSyncExternalStore(
    client?.store.subscribe.bind(client.store) ?? (() => () => {}),
    () => (threadId && client ? client.store.getThread(threadId) : EMPTY_SELECTION),
  )

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
      const nextId =
        (threadId && nextThreads.some(item => String(item.state.id) === threadId)
          ? threadId
          : null) ??
        (initialThreadId &&
        nextThreads.some(item => String(item.state.id) === initialThreadId)
          ? initialThreadId
          : null) ??
        (nextThreads[0] ? String(nextThreads[0].state.id) : null)
      setThreadId(nextId)
      if (nextId) onThreadSelected?.(nextId)
      setError(null)
    } catch (cause) {
      setError(message(cause, "Could not load agent threads."))
    } finally {
      setLoading(false)
    }
  }, [api, client, initialThreadId, onThreadSelected, projectSessionId, threadId])

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

  const selectThread = useCallback((nextThreadId: string) => {
    setThreadId(nextThreadId)
    onThreadSelected?.(nextThreadId)
  }, [onThreadSelected])

  const createThread = useCallback(async (discovery: AgentDriverDiscovery) => {
    if (!api || !client) return
    const driver = discovery.descriptor
    setCreatingDriverId(String(driver.id))
    setError(null)
    try {
      const snapshot = await api.createThread({
        projectSessionId,
        cwdUri: pathToFileUri(cwdPath),
        providerId: String(driver.providerId),
      })
      client.hydrate(snapshot)
      setThreads(current => [snapshot, ...current])
      selectThread(String(snapshot.state.id))
    } catch (cause) {
      setError(message(cause, `Could not start ${driver.name}.`))
    } finally {
      setCreatingDriverId(null)
    }
  }, [api, client, cwdPath, projectSessionId, selectThread])

  const send = useCallback(async (
    command: AgentCommandEnvelope["command"],
    expectedRevision?: number,
    commandId: string = crypto.randomUUID(),
  ) => {
    if (!api || !threadId) return
    const envelope = Schema.decodeUnknownSync(AgentCommandEnvelope)({
      protocolVersion: 1,
      commandId,
      threadId,
      issuedAt: new Date().toISOString(),
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      command,
    })
    const result = await api.sendCommand(envelope)
    if (result.status === "rejected") {
      throw new Error(result.error.message)
    }
  }, [api, threadId])

  if (loading) {
    return (
      <div className="flex h-full flex-col gap-3 p-4" data-yaade-tool-pane="agentChat">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="min-h-0 flex-1" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  if (!selected.snapshot) {
    return (
      <AgentStart
        drivers={drivers}
        threads={threads}
        error={error}
        creatingDriverId={creatingDriverId}
        onCreate={driver => void createThread(driver)}
        onSelect={selectThread}
        onReload={() => void load()}
      />
    )
  }

  const snapshot = selected.snapshot
  const runningTurn = snapshot.state.turns.find(turn => turn.status === "running")
  const connection = selected.recovering
    ? AgentConnectionState.make({
        status: "reconnecting",
        generation: snapshot.state.connectionGeneration,
      })
    : selected.connection ?? AgentConnectionState.make({
        status: snapshot.state.status === "closed" ? "disconnected" : "connecting",
        generation: snapshot.state.connectionGeneration,
      })

  return (
    <div className="flex h-full min-h-0 flex-col" data-yaade-tool-pane="agentChat">
      {threads.length > 1 ? (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
          <span className="text-2xs text-muted-foreground">Thread</span>
          <select
            aria-label="Agent thread"
            className="min-w-0 flex-1 bg-transparent text-xs outline-none"
            value={threadId ?? ""}
            onChange={event => selectThread(event.target.value)}
          >
            {threads.map((item, index) => (
              <option key={item.state.id} value={item.state.id}>
                {item.state.providerId} · Thread {threads.length - index}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <AgentChatView
        snapshot={snapshot}
        connection={connection}
        onSend={(text, attachments) => {
          const input = [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...attachments.map(attachment => attachment.kind === "workspace-resource"
              ? { type: "workspace-resource" as const, uri: attachment.id }
              : {
                  type: "attachment" as const,
                  attachmentId: attachment.id,
                  purpose: attachment.mediaType.startsWith("image/") ? "image" as const : "context" as const,
                }),
          ]
          void send(
            { type: "turn.submit", input },
            snapshot.state.revision,
          ).catch(cause => showYaadeToast(message(cause, "Could not send message."), {
            variant: "destructive",
          }))
        }}
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
          if (!runningTurn) return
          void send({ type: "turn.interrupt", turnId: runningTurn.id }).catch(cause =>
            showYaadeToast(message(cause, "Could not interrupt the agent."), {
              variant: "destructive",
            }),
          )
        }}
        onRespondToAction={async (actionId, response) => {
          const commandId = actionCommandIds.current.get(actionId) ?? crypto.randomUUID()
          actionCommandIds.current.set(actionId, commandId)
          await send({
            type: "action.respond",
            actionId: actionId as never,
            response: response as AgentActionResponse,
          }, snapshot.state.revision, commandId)
          actionCommandIds.current.delete(actionId)
        }}
        onConfigurationChange={async (optionId, value) => {
          await send({ type: "configuration.set", optionId, value }, snapshot.state.revision)
        }}
      />
    </div>
  )
}

const EMPTY_SELECTION = {
  snapshot: null,
  lastSequence: 0,
  gapDetected: false,
  recovering: false,
} as const

function AgentStart(props: {
  drivers: AgentDriverDiscovery[]
  threads: AgentThreadSnapshot[]
  error: string | null
  creatingDriverId: string | null
  onCreate: (driver: AgentDriverDiscovery) => void
  onSelect: (threadId: string) => void
  onReload: () => void
}) {
  return (
    <div
      className="flex h-full min-h-0 items-center justify-center overflow-auto bg-background p-5"
      data-yaade-tool-pane="agentChat"
    >
      <Card className="w-full max-w-lg">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-muted-foreground" />
            <CardTitle>Start an agent thread</CardTitle>
          </div>
          <CardDescription>
            Choose an integration. The host keeps the conversation durable when this tab reloads.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {props.error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
              {props.error}
            </p>
          ) : null}
          {props.threads.map((thread, index) => (
            <Button
              key={thread.state.id}
              variant="outline"
              className="justify-between"
              onClick={() => props.onSelect(String(thread.state.id))}
            >
              Resume {thread.state.providerId}
              <Badge variant="secondary">Thread {props.threads.length - index}</Badge>
            </Button>
          ))}
          {props.drivers.map(discovery => {
            const driver = discovery.descriptor
            return (
            <Button
              key={driver.id}
              variant="outline"
              className="justify-between"
              disabled={props.creatingDriverId !== null || !discovery.available}
              title={discovery.reason}
              onClick={() => props.onCreate(discovery)}
            >
              {props.creatingDriverId === driver.id ? "Starting…" : driver.name}
              <Badge variant="secondary">{discovery.available ? driver.integration : "unavailable"}</Badge>
            </Button>
            )
          })}
          {props.drivers.length === 0 ? (
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              No agent integrations were discovered.
              <Button size="sm" variant="ghost" onClick={props.onReload}>
                <RefreshCw data-icon="inline-start" />
                Retry
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("Could not read attachment"))
    reader.onload = () => {
      const value = String(reader.result ?? "")
      const comma = value.indexOf(",")
      if (comma < 0) reject(new Error("Could not encode attachment"))
      else resolve(value.slice(comma + 1))
    }
    reader.readAsDataURL(file)
  })
}
