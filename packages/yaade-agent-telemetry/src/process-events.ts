/** Build process lifecycle AgentEvents from the PTY supervisor (not hooks). */
import type { AgentEvent, AgentProvider } from "./types/events.js"
import { makeAgentEventId } from "./ids.js"

export function makeProcessStartedEvent(input: {
  provider: AgentProvider
  sessionId: string
  processId: string
  nativeSessionId?: string
  nativeProcessId?: number
  projectId?: string
  cwd?: string
  at?: string
}): AgentEvent {
  const at = input.at ?? new Date().toISOString()
  const nativeSessionId = input.nativeSessionId ?? ""
  return {
    schemaVersion: 1,
    id: makeAgentEventId({
      provider: input.provider,
      nativeSessionId: nativeSessionId || input.sessionId,
      kind: "process.started",
      nativeEventName: "process.started",
      salt: input.processId,
    }),
    kind: "process.started",
    provider: input.provider,
    occurredAt: at,
    receivedAt: at,
    processId: input.processId,
    nativeProcessId: input.nativeProcessId,
    sessionId: input.sessionId,
    nativeSessionId,
    projectId: input.projectId,
    cwd: input.cwd,
    source: { nativeEventName: "process.started" },
  }
}

export function makeProcessExitedEvent(input: {
  provider: AgentProvider
  sessionId: string
  processId: string
  nativeSessionId?: string
  exitCode?: number
  expectedExit?: boolean
  projectId?: string
  cwd?: string
  at?: string
}): AgentEvent {
  const at = input.at ?? new Date().toISOString()
  const nativeSessionId = input.nativeSessionId ?? ""
  return {
    schemaVersion: 1,
    id: makeAgentEventId({
      provider: input.provider,
      nativeSessionId: nativeSessionId || input.sessionId,
      kind: "process.exited",
      nativeEventName: "process.exited",
      salt: `${input.processId}:${input.exitCode ?? "null"}`,
    }),
    kind: "process.exited",
    provider: input.provider,
    occurredAt: at,
    receivedAt: at,
    processId: input.processId,
    sessionId: input.sessionId,
    nativeSessionId,
    projectId: input.projectId,
    cwd: input.cwd,
    metadata: {
      exitCode: input.exitCode ?? null,
      expectedExit: input.expectedExit === true,
    },
    source: { nativeEventName: "process.exited" },
  }
}
