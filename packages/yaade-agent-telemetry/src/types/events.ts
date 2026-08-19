/** Provider-independent ADE telemetry event kinds. */

import type { CliProvider } from "@yaade/shared"

export type AgentProvider = CliProvider

export type AgentEventKind =
  | "process.started"
  | "process.exited"
  | "session.started"
  | "session.resumed"
  | "session.ended"
  | "session.failed"
  | "prompt.submitted"
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "permission.requested"
  | "permission.resolved"
  | "subagent.started"
  | "subagent.completed"
  | "subagent.failed"
  | "compaction.started"
  | "compaction.completed"
  | "file.touched"
  | "notification.requested"

export type AgentToolCategory =
  | "file_read"
  | "file_write"
  | "shell"
  | "search"
  | "web"
  | "mcp"
  | "subagent"
  | "task"
  | "other"

export interface AgentEvent {
  schemaVersion: 1

  id: string
  kind: AgentEventKind
  provider: AgentProvider

  occurredAt: string
  receivedAt: string

  processId: string
  nativeProcessId?: number

  sessionId: string
  nativeSessionId: string

  projectId?: string
  cwd?: string

  turn?: {
    id: string
    nativeId?: string
  }

  tool?: {
    id: string
    nativeId?: string
    name: string
    category: AgentToolCategory
    status: "running" | "completed" | "failed" | "blocked"
    startedAt?: string
    completedAt?: string
    durationMs?: number
  }

  permission?: {
    id: string
    toolName?: string
    category?: string
    status: "requested" | "allowed" | "denied" | "cancelled"
  }

  subagent?: {
    id: string
    nativeId?: string
    parentId?: string
    type?: string
    status: "running" | "completed" | "failed"
  }

  file?: {
    path: string
    operation?: "read" | "create" | "modify" | "delete"
  }

  metadata?: Record<string, string | number | boolean | null>

  source: {
    nativeEventName: string
    providerVersion?: string
  }
}
