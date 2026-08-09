import type { AgentEventKind, AgentProvider, AgentToolCategory } from "./events.js"
import type { AgentDriverCapabilities } from "./driver.js"

export type AgentSessionStatus =
  | "starting"
  | "working"
  | "running_tool"
  | "waiting_for_permission"
  | "waiting_for_user"
  | "idle"
  | "completed"
  | "failed"
  | "terminated"
  | "disconnected"

export interface AgentSessionSnapshot {
  id: string
  nativeSessionId: string

  provider: AgentProvider
  providerVersion?: string

  projectId?: string
  cwd?: string

  status: AgentSessionStatus

  startedAt: string
  lastActivityAt: string
  endedAt?: string

  process: {
    id: string
    pid?: number
    running: boolean
    exitCode?: number
    /** True when exit was expected (user stop / mark-done / session.ended). */
    expectedExit?: boolean
  }

  currentTurn?: {
    id: string
    startedAt: string
    durationMs: number
  }

  currentTool?: {
    id: string
    name: string
    category: AgentToolCategory
    startedAt: string
    durationMs: number
  }

  counts: {
    turns: number
    completedTurns: number
    failedTurns: number

    tools: number
    runningTools: number
    failedTools: number

    touchedFiles: number
    compactions: number

    subagents?: number
    activeSubagents?: number
  }

  runtime: {
    processRuntimeMs: number
    activeRuntimeMs: number
  }

  files: Array<{
    path: string
    lastOperation?: "read" | "create" | "modify" | "delete"
    lastTouchedAt: string
  }>

  unread: {
    count: number
    latestEventAt?: string
    latestEventKind?: AgentEventKind
  }

  attention?: {
    kind:
      | "permission_required"
      | "turn_completed"
      | "turn_failed"
      | "session_failed"
      | "session_terminated"
    eventId: string
    createdAt: string
  }

  capabilities: AgentDriverCapabilities

  /** Internal reducer bookkeeping — not for UI. */
  _internal?: AgentSnapshotInternal
}

export type AgentSnapshotInternal = {
  seenEventIds: string[]
  runningToolIds: string[]
  activeTurnId?: string
  turnIndex: number
  /** Closed active-time intervals [startMs, endMs]. */
  activeIntervals: Array<[number, number]>
  /** Open active interval start (ms) while a turn is running. */
  openActiveStartMs?: number
  processStartMs?: number
  processEndMs?: number
}
