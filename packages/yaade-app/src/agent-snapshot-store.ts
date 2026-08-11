import type {
  AgentEvent,
  AgentSessionSnapshot,
} from "@yaade/agents"

type SnapshotListener = (sessionId: string) => void

const snapshots = new Map<string, Omit<AgentSessionSnapshot, "_internal">>()
const eventsBySession = new Map<string, AgentEvent[]>()
const listeners = new Set<SnapshotListener>()
let telemetryVersion = 0
const versionListeners = new Set<() => void>()
let notifyRaf = 0

function notify(sessionId: string): void {
  for (const l of listeners) l(sessionId)
  // Coalesce event+snapshot pairs (host emits both per ingest) into one React tick.
  if (notifyRaf) return
  const schedule =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 0) as unknown as number
  notifyRaf = schedule(() => {
    notifyRaf = 0
    telemetryVersion += 1
    for (const l of versionListeners) l()
  }) as unknown as number
}

export function subscribeAgentSnapshots(listener: SnapshotListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Coarse version for React — bumps on any snapshot/event write. */
export function subscribeAgentTelemetryVersion(
  onStoreChange: () => void,
): () => void {
  versionListeners.add(onStoreChange)
  return () => versionListeners.delete(onStoreChange)
}

export function getAgentTelemetryVersion(): number {
  return telemetryVersion
}

export function getAgentSnapshot(
  sessionId: string,
): Omit<AgentSessionSnapshot, "_internal"> | null {
  return snapshots.get(sessionId) ?? null
}

export function getAgentEvents(sessionId: string): AgentEvent[] {
  return eventsBySession.get(sessionId) ?? []
}

export function listTrackedAgentSessionIds(): string[] {
  return [...new Set([...snapshots.keys(), ...eventsBySession.keys()])]
}

export function setAgentSnapshot(
  sessionId: string,
  snapshot: Omit<AgentSessionSnapshot, "_internal">,
): void {
  snapshots.set(sessionId, snapshot)
  notify(sessionId)
}

export function appendAgentEvent(sessionId: string, event: AgentEvent): void {
  const list = eventsBySession.get(sessionId) ?? []
  if (list.some((e) => e.id === event.id)) return
  list.push(event)
  if (list.length > 500) list.splice(0, list.length - 500)
  eventsBySession.set(sessionId, list)
  notify(sessionId)
}

export function replaceAgentEvents(sessionId: string, events: AgentEvent[]): void {
  const deduped = new Map(events.map(event => [event.id, event]))
  eventsBySession.set(sessionId, [...deduped.values()].slice(-500))
  notify(sessionId)
}

export function clearAgentSessionTelemetry(sessionId: string): void {
  snapshots.delete(sessionId)
  eventsBySession.delete(sessionId)
  notify(sessionId)
}

export type AgentStreamPayload =
  | {
      type: "agents.snapshot"
      sessionId: string
      snapshot: Omit<AgentSessionSnapshot, "_internal">
      nativeSessionId?: string
    }
  | {
      type: "agents.event"
      sessionId: string
      event: AgentEvent
    }

export function applyAgentStreamPayload(payload: AgentStreamPayload): void {
  if (payload.type === "agents.snapshot" && payload.snapshot) {
    setAgentSnapshot(payload.sessionId, payload.snapshot)
    return
  }
  if (payload.type === "agents.event" && payload.event) {
    appendAgentEvent(payload.sessionId, payload.event)
  }
}

export function applyAgentStreamUnknown(payload: {
  type: string
  sessionId: string
  snapshot?: Omit<AgentSessionSnapshot, "_internal">
  nativeSessionId?: string
  event?: AgentEvent
}): void {
  if (payload.type === "agents.snapshot" && payload.snapshot) {
    applyAgentStreamPayload({
      type: "agents.snapshot",
      sessionId: payload.sessionId,
      snapshot: payload.snapshot,
      nativeSessionId: payload.nativeSessionId,
    })
    return
  }
  if (payload.type === "agents.event" && payload.event) {
    applyAgentStreamPayload({
      type: "agents.event",
      sessionId: payload.sessionId,
      event: payload.event,
    })
  }
}
