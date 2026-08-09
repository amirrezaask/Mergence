import type { AgentEvent } from "../types/events.js"
import type {
  AgentSessionSnapshot,
  AgentSnapshotInternal,
  AgentSessionStatus,
} from "../types/snapshot.js"
import type { AgentDriverCapabilities } from "../types/driver.js"

const DEFAULT_CAPABILITIES: AgentDriverCapabilities = {
  sessionLifecycle: false,
  promptLifecycle: false,
  turnLifecycle: "unsupported",
  toolLifecycle: false,
  permissions: false,
  subagents: false,
  compaction: false,
  fileEvents: "unsupported",
}

const MAX_SEEN_IDS = 2_000

function parseMs(iso: string | undefined): number {
  if (!iso) return Date.now()
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : Date.now()
}

function emptyInternal(): AgentSnapshotInternal {
  return {
    seenEventIds: [],
    runningToolIds: [],
    turnIndex: 0,
    activeIntervals: [],
  }
}

function cloneInternal(i: AgentSnapshotInternal): AgentSnapshotInternal {
  return {
    seenEventIds: [...i.seenEventIds],
    runningToolIds: [...i.runningToolIds],
    activeTurnId: i.activeTurnId,
    turnIndex: i.turnIndex,
    activeIntervals: i.activeIntervals.map(([a, b]) => [a, b]),
    openActiveStartMs: i.openActiveStartMs,
    processStartMs: i.processStartMs,
    processEndMs: i.processEndMs,
  }
}

function sumActiveMs(internal: AgentSnapshotInternal, nowMs: number): number {
  let total = 0
  for (const [start, end] of internal.activeIntervals) {
    total += Math.max(0, end - start)
  }
  if (internal.openActiveStartMs != null) {
    total += Math.max(0, nowMs - internal.openActiveStartMs)
  }
  return total
}

function processRuntimeMs(internal: AgentSnapshotInternal, nowMs: number): number {
  if (internal.processStartMs == null) return 0
  const end = internal.processEndMs ?? nowMs
  return Math.max(0, end - internal.processStartMs)
}

function openActive(internal: AgentSnapshotInternal, atMs: number): void {
  if (internal.openActiveStartMs == null) {
    internal.openActiveStartMs = atMs
  }
}

function closeActive(internal: AgentSnapshotInternal, atMs: number): void {
  if (internal.openActiveStartMs != null) {
    internal.activeIntervals.push([internal.openActiveStartMs, atMs])
    internal.openActiveStartMs = undefined
  }
}

function markSeen(internal: AgentSnapshotInternal, id: string): boolean {
  if (internal.seenEventIds.includes(id)) return false
  internal.seenEventIds.push(id)
  if (internal.seenEventIds.length > MAX_SEEN_IDS) {
    internal.seenEventIds = internal.seenEventIds.slice(-MAX_SEEN_IDS)
  }
  return true
}

function addRunningTool(internal: AgentSnapshotInternal, toolId: string): void {
  if (!internal.runningToolIds.includes(toolId)) {
    internal.runningToolIds.push(toolId)
  }
}

function removeRunningTool(internal: AgentSnapshotInternal, toolId: string): void {
  internal.runningToolIds = internal.runningToolIds.filter((id) => id !== toolId)
}

function statusAfterTools(
  runningCount: number,
  fallback: AgentSessionStatus,
): AgentSessionStatus {
  return runningCount > 0 ? "running_tool" : fallback
}

function upsertFile(
  files: AgentSessionSnapshot["files"],
  path: string,
  operation: AgentSessionSnapshot["files"][number]["lastOperation"],
  at: string,
): AgentSessionSnapshot["files"] {
  const next = files.filter((f) => f.path !== path)
  next.unshift({ path, lastOperation: operation, lastTouchedAt: at })
  return next.slice(0, 200)
}

function bumpUnread(
  snap: AgentSessionSnapshot,
  event: AgentEvent,
  attentionKind: NonNullable<AgentSessionSnapshot["attention"]>["kind"],
): void {
  snap.unread = {
    count: snap.unread.count + 1,
    latestEventAt: event.occurredAt,
    latestEventKind: event.kind,
  }
  snap.attention = {
    kind: attentionKind,
    eventId: event.id,
    createdAt: event.occurredAt,
  }
}

/** Clear unread when the user views the session (call from app). */
export function clearAgentSessionUnread(
  previous: AgentSessionSnapshot,
): AgentSessionSnapshot {
  return {
    ...previous,
    unread: { count: 0 },
    attention:
      previous.attention?.kind === "permission_required"
        ? previous.attention
        : undefined,
    _internal: previous._internal
      ? cloneInternal(previous._internal)
      : undefined,
  }
}

export function reduceAgentEvent(
  previous: AgentSessionSnapshot | undefined,
  event: AgentEvent,
  options?: { capabilities?: AgentDriverCapabilities },
): AgentSessionSnapshot {
  const nowMs = parseMs(event.receivedAt || event.occurredAt)
  const atMs = parseMs(event.occurredAt)

  if (!previous) {
    const caps = options?.capabilities ?? DEFAULT_CAPABILITIES
    const internal = emptyInternal()
    previous = {
      id: event.sessionId,
      nativeSessionId: event.nativeSessionId || "",
      provider: event.provider,
      providerVersion: event.source.providerVersion,
      projectId: event.projectId,
      cwd: event.cwd,
      status: "starting",
      startedAt: event.occurredAt,
      lastActivityAt: event.occurredAt,
      process: {
        id: event.processId,
        pid: event.nativeProcessId,
        running: false,
      },
      counts: {
        turns: 0,
        completedTurns: 0,
        failedTurns: 0,
        tools: 0,
        runningTools: 0,
        failedTools: 0,
        touchedFiles: 0,
        compactions: 0,
      },
      runtime: { processRuntimeMs: 0, activeRuntimeMs: 0 },
      files: [],
      unread: { count: 0 },
      capabilities: caps,
      _internal: internal,
    }
  }

  const internal = cloneInternal(previous._internal ?? emptyInternal())
  if (!markSeen(internal, event.id)) {
    // Duplicate — return previous unchanged (keep internal reference).
    return {
      ...previous,
      _internal: previous._internal ?? internal,
      runtime: {
        processRuntimeMs: processRuntimeMs(internal, nowMs),
        activeRuntimeMs: sumActiveMs(internal, nowMs),
      },
    }
  }

  const snap: AgentSessionSnapshot = {
    ...previous,
    nativeSessionId: event.nativeSessionId || previous.nativeSessionId,
    projectId: event.projectId ?? previous.projectId,
    cwd: event.cwd ?? previous.cwd,
    providerVersion:
      event.source.providerVersion ?? previous.providerVersion,
    lastActivityAt: event.occurredAt,
    counts: { ...previous.counts },
    files: [...previous.files],
    unread: { ...previous.unread },
    process: { ...previous.process },
    currentTurn: previous.currentTurn
      ? { ...previous.currentTurn }
      : undefined,
    currentTool: previous.currentTool
      ? { ...previous.currentTool }
      : undefined,
    attention: previous.attention ? { ...previous.attention } : undefined,
    capabilities: options?.capabilities ?? previous.capabilities,
  }

  switch (event.kind) {
    case "process.started": {
      snap.status = "starting"
      snap.process = {
        id: event.processId,
        pid: event.nativeProcessId ?? snap.process.pid,
        running: true,
        expectedExit: false,
      }
      internal.processStartMs = atMs
      internal.processEndMs = undefined
      break
    }
    case "session.started":
    case "session.resumed": {
      snap.status = "starting"
      if (event.nativeSessionId) snap.nativeSessionId = event.nativeSessionId
      break
    }
    case "prompt.submitted": {
      snap.status = "working"
      openActive(internal, atMs)
      break
    }
    case "turn.started": {
      const turnId = event.turn?.id ?? `turn:${internal.turnIndex + 1}`
      internal.turnIndex += 1
      internal.activeTurnId = turnId
      snap.counts.turns += 1
      snap.currentTurn = {
        id: turnId,
        startedAt: event.occurredAt,
        durationMs: 0,
      }
      snap.status = "working"
      openActive(internal, atMs)
      break
    }
    case "tool.started": {
      const toolId = event.tool?.id
      if (toolId) {
        addRunningTool(internal, toolId)
        snap.counts.tools += 1
        snap.counts.runningTools = internal.runningToolIds.length
        snap.currentTool = {
          id: toolId,
          name: event.tool?.name ?? "tool",
          category: event.tool?.category ?? "other",
          startedAt: event.tool?.startedAt ?? event.occurredAt,
          durationMs: 0,
        }
      }
      snap.status = "running_tool"
      openActive(internal, atMs)
      break
    }
    case "tool.completed": {
      const toolId = event.tool?.id
      if (toolId) removeRunningTool(internal, toolId)
      snap.counts.runningTools = internal.runningToolIds.length
      if (snap.currentTool?.id === toolId) {
        snap.currentTool =
          internal.runningToolIds.length > 0
            ? snap.currentTool
            : undefined
      }
      snap.status = statusAfterTools(internal.runningToolIds.length, "working")
      break
    }
    case "tool.failed": {
      const toolId = event.tool?.id
      if (toolId) removeRunningTool(internal, toolId)
      snap.counts.runningTools = internal.runningToolIds.length
      snap.counts.failedTools += 1
      if (snap.currentTool?.id === toolId) {
        snap.currentTool =
          internal.runningToolIds.length > 0 ? snap.currentTool : undefined
      }
      snap.status = statusAfterTools(internal.runningToolIds.length, "working")
      break
    }
    case "permission.requested": {
      snap.status = "waiting_for_permission"
      bumpUnread(snap, event, "permission_required")
      break
    }
    case "permission.resolved": {
      if (snap.attention?.kind === "permission_required") {
        snap.attention = undefined
      }
      snap.status = statusAfterTools(
        internal.runningToolIds.length,
        "working",
      )
      break
    }
    case "turn.completed": {
      snap.counts.completedTurns += 1
      closeActive(internal, atMs)
      internal.activeTurnId = undefined
      snap.currentTurn = undefined
      snap.currentTool = undefined
      snap.status = "waiting_for_user"
      bumpUnread(snap, event, "turn_completed")
      break
    }
    case "turn.failed": {
      snap.counts.failedTurns += 1
      closeActive(internal, atMs)
      internal.activeTurnId = undefined
      snap.currentTurn = undefined
      snap.currentTool = undefined
      snap.status = "failed"
      bumpUnread(snap, event, "turn_failed")
      break
    }
    case "session.ended": {
      closeActive(internal, atMs)
      snap.status = "completed"
      snap.endedAt = event.occurredAt
      snap.process.expectedExit = true
      break
    }
    case "session.failed": {
      closeActive(internal, atMs)
      snap.status = "failed"
      snap.endedAt = event.occurredAt
      bumpUnread(snap, event, "session_failed")
      break
    }
    case "process.exited": {
      const expected =
        event.metadata?.expectedExit === true ||
        snap.process.expectedExit === true ||
        snap.status === "completed"
      const exitCode =
        typeof event.metadata?.exitCode === "number"
          ? event.metadata.exitCode
          : undefined
      snap.process = {
        ...snap.process,
        id: event.processId || snap.process.id,
        running: false,
        exitCode,
        expectedExit: expected,
      }
      internal.processEndMs = atMs
      closeActive(internal, atMs)
      if (!expected && exitCode !== 0) {
        snap.status = "terminated"
        snap.endedAt = event.occurredAt
        bumpUnread(snap, event, "session_terminated")
      } else if (snap.status !== "completed" && snap.status !== "failed") {
        snap.status = expected ? "completed" : "terminated"
        snap.endedAt = event.occurredAt
      }
      break
    }
    case "subagent.started": {
      snap.counts.subagents = (snap.counts.subagents ?? 0) + 1
      snap.counts.activeSubagents = (snap.counts.activeSubagents ?? 0) + 1
      break
    }
    case "subagent.completed":
    case "subagent.failed": {
      snap.counts.activeSubagents = Math.max(
        0,
        (snap.counts.activeSubagents ?? 1) - 1,
      )
      break
    }
    case "compaction.started":
      break
    case "compaction.completed": {
      snap.counts.compactions += 1
      break
    }
    case "file.touched": {
      if (event.file?.path) {
        snap.files = upsertFile(
          snap.files,
          event.file.path,
          event.file.operation,
          event.occurredAt,
        )
        snap.counts.touchedFiles = snap.files.length
      }
      break
    }
    case "notification.requested":
      break
    default:
      break
  }

  if (snap.currentTurn) {
    snap.currentTurn = {
      ...snap.currentTurn,
      durationMs: Math.max(0, nowMs - parseMs(snap.currentTurn.startedAt)),
    }
  }
  if (snap.currentTool) {
    snap.currentTool = {
      ...snap.currentTool,
      durationMs: Math.max(0, nowMs - parseMs(snap.currentTool.startedAt)),
    }
  }

  snap.runtime = {
    processRuntimeMs: processRuntimeMs(internal, nowMs),
    activeRuntimeMs: sumActiveMs(internal, nowMs),
  }
  snap._internal = internal
  return snap
}

/** Strip `_internal` before sending snapshots to the UI/API. */
export function publicAgentSnapshot(
  snap: AgentSessionSnapshot,
): Omit<AgentSessionSnapshot, "_internal"> {
  const { _internal: _, ...rest } = snap
  return rest
}
