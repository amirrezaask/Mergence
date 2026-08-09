import type {
  AgentEventEnvelope,
  AgentThreadSnapshot,
} from "@yaade/agent-protocol"
import type { AgentProvider, IngestNotificationRequest } from "@yaade/shared"
import type { ProjectDatabase } from "../persistence.js"
import type { NotificationService } from "../notifications/index.js"

function provider(value: string): AgentProvider | null {
  switch (value) {
    case "claude":
    case "cursor":
    case "codex":
    case "opencode":
    case "grok":
      return value
    default:
      return null
  }
}

/**
 * Project a committed interactive-runtime event into the shared attention
 * domain. This is deliberately called after the event-store transaction so a
 * notification can never point at agent state which vanished after a crash.
 */
export function projectAgentNotification(
  notifications: NotificationService,
  db: ProjectDatabase,
  envelope: AgentEventEnvelope,
  snapshot: AgentThreadSnapshot,
): void {
  const event = envelope.event
  const session = db.getProjectSession(String(snapshot.state.projectSessionId))
  const common = {
    source: "interactive-runtime" as const,
    projectId: session?.projectPath ?? null,
    sessionId: String(snapshot.state.projectSessionId),
    projectName: session?.projectPath.split("/").filter(Boolean).at(-1) ?? null,
    sessionTitle: session?.title ?? null,
    provider: provider(String(snapshot.state.providerId)),
    eventId: envelope.eventId,
    eventSequence: envelope.sequence,
    providerSessionId: snapshot.state.providerSessionId ?? null,
    metadata: {
      agentThreadId: String(snapshot.state.id),
      driverId: String(snapshot.state.driverId),
      connectionGeneration: envelope.connectionGeneration,
    },
  }

  let request: IngestNotificationRequest | null = null
  switch (event.type) {
    case "action.requested":
      request = {
        ...common,
        type: event.action.type === "permission"
          ? "permission-required"
          : "input-required",
        title: event.action.title,
        message: event.action.description ?? null,
        providerTurnId: String(event.action.id),
        requiresAction: true,
      }
      break
    case "action.resolved":
      request = {
        ...common,
        type: "provider-notification",
        title: "Agent input received",
        providerTurnId: String(event.actionId),
        resolveOf: {
          providerSessionId: snapshot.state.providerSessionId ?? null,
          providerTurnId: String(event.actionId),
        },
      }
      break
    case "turn.completed":
      request = {
        ...common,
        type: "turn-completed",
        title: "Agent finished",
        providerTurnId: String(event.turnId),
      }
      break
    case "turn.failed":
      request = {
        ...common,
        type: "failed",
        title: "Agent turn failed",
        message: event.message,
        providerTurnId: String(event.turnId),
      }
      break
    case "agent.error":
      request = {
        ...common,
        type: "failed",
        title: "Agent connection error",
        message: event.message,
      }
      break
    default:
      break
  }
  if (request) notifications.ingest(request)
}
