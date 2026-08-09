import type { AgentEvent, AgentEventKind } from "../types/events.js"

/** Lifecycle / process noise — persist, but omit from agent activity UI. */
const HIDDEN_ACTIVITY_KINDS = new Set<AgentEventKind>([
  "process.started",
  "process.exited",
  "session.started",
  "session.resumed",
  "session.ended",
  "prompt.submitted",
  "turn.started",
  "compaction.started",
  "compaction.completed",
])

export function isAgentActivityUiEvent(event: AgentEvent): boolean {
  return !HIDDEN_ACTIVITY_KINDS.has(event.kind)
}

export function filterAgentActivityUiEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter(isAgentActivityUiEvent)
}
