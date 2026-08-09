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
  requestConfirm,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
} from "@yaade/ui/primitives"
import {
  Bot,
  ChevronDown,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react"
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
  const [creatingDriverId, setCreatingDriverId] = useState<string | null>(null)
  const [threadAction, setThreadAction] = useState<"close" | "delete" | null>(
    null,
  )
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
      onThreadSelected?.(nextId)
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
        driverId: String(driver.id),
      })
      client.hydrate(snapshot)
      setThreads(current => [snapshot, ...current])
      selectThread(String(snapshot.state.id))
    } catch (cause) {
      const detail = message(cause, `Could not start ${driver.name}.`)
      setError(detail)
      showYaadeToast(detail, { variant: "destructive" })
    } finally {
      setCreatingDriverId(null)
    }
  }, [api, client, cwdPath, projectSessionId, selectThread])

  const closeThread = useCallback(async () => {
    if (!api || !client || !threadId) return
    setThreadAction("close")
    try {
      const snapshot = await api.closeThread(threadId)
      client.hydrate(snapshot)
      setThreads(current =>
        current.map(item =>
          String(item.state.id) === threadId ? snapshot : item,
        ),
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
      const remaining = threads.filter(
        item => String(item.state.id) !== threadId,
      )
      setThreads(remaining)
      const nextId = remaining[0] ? String(remaining[0].state.id) : null
      setThreadId(nextId)
      onThreadSelected?.(nextId)
    } catch (cause) {
      showYaadeToast(message(cause, "Could not delete the agent thread."), {
        variant: "destructive",
      })
    } finally {
      setThreadAction(null)
    }
  }, [api, onThreadSelected, threadId, threads])

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
      <div
        className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-secondary/20 px-3"
        data-yaade-native-agent-menu=""
      >
        <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="sr-only">Native agent thread</span>
        {threads.length > 0 ? (
          <select
            aria-label="Agent thread"
            className="min-w-0 max-w-64 flex-1 rounded-sm bg-background px-1.5 py-1 text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={threadId ?? ""}
            onChange={event => selectThread(event.target.value)}
          >
            {threads.map((item, index) => (
              <option key={item.state.id} value={item.state.id}>
                {item.state.providerId} · Thread {threads.length - index}
              </option>
            ))}
          </select>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <DriverMenu
            drivers={drivers}
            creatingDriverId={creatingDriverId}
            onCreate={driver => void createThread(driver)}
          />
          <ThreadMenu
            closed={snapshot.state.status === "closed"}
            busy={threadAction !== null}
            onClose={() => void closeThread()}
            onDelete={() => void deleteThread()}
          />
        </div>
      </div>
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
        <CardContent
          className="flex flex-col gap-2"
          data-yaade-list-panel="native-agent-drivers"
        >
          {props.error ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive"
            >
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
              data-yaade-list-item=""
              data-yaade-native-agent-driver={driver.id}
              disabled={props.creatingDriverId !== null || !discovery.available}
              title={discovery.reason}
              onClick={() => props.onCreate(discovery)}
            >
              <span className="min-w-0 text-left">
                <span className="block truncate">
                  {props.creatingDriverId === driver.id
                    ? "Starting…"
                    : driver.name}
                </span>
                {!discovery.available && discovery.reason ? (
                  <span className="block truncate text-3xs font-normal text-muted-foreground">
                    {discovery.reason}
                  </span>
                ) : null}
              </span>
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

function DriverMenu(props: {
  drivers: AgentDriverDiscovery[]
  creatingDriverId: string | null
  onCreate: (driver: AgentDriverDiscovery) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          disabled={props.creatingDriverId !== null}
          data-yaade-native-agent-new=""
        >
          <Plus data-icon="inline-start" />
          {props.creatingDriverId ? "Starting…" : "New thread"}
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-72"
        data-yaade-list-panel="native-agent-drivers"
        data-yaade-native-agent-driver-menu=""
      >
        <DropdownMenuLabel>Native agent drivers</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {props.drivers.length > 0 ? (
          props.drivers.map(discovery => {
            const driver = discovery.descriptor
            return (
              <DropdownMenuItem
                key={driver.id}
                disabled={!discovery.available}
                data-yaade-list-item=""
                data-yaade-native-agent-driver={driver.id}
                onSelect={() => props.onCreate(discovery)}
                className="shrink-0 items-start gap-2 py-2"
              >
                <Bot className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {driver.name}
                  </span>
                  <span className="block truncate text-3xs text-muted-foreground">
                    {discovery.available
                      ? `${driver.providerId} · ${driver.integration}`
                      : discovery.reason || "Unavailable on this host"}
                  </span>
                </span>
              </DropdownMenuItem>
            )
          })
        ) : (
          <DropdownMenuItem disabled>No drivers discovered</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ThreadMenu(props: {
  closed: boolean
  busy: boolean
  onClose: () => void
  onDelete: () => void
}) {
  return (
    <div className="flex items-center gap-0.5" aria-label="Agent thread actions">
      {!props.closed ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Close agent thread"
          title="Close thread"
          disabled={props.busy}
          data-yaade-native-agent-close=""
          onClick={props.onClose}
        >
          <X />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Delete agent thread"
        title="Delete thread"
        disabled={props.busy}
        data-yaade-native-agent-delete=""
        onClick={props.onDelete}
      >
        <Trash2 />
      </Button>
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
