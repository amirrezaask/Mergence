import { Schema } from "effect"
import {
  SessionId,
  ToolUseId,
  type AppSession,
  type SessionId as SessionIdType,
  type ToolUseId as ToolUseIdType,
} from "@yaade/rpc"

export type ToolSessionRoute = {
  sessionId?: SessionIdType
  toolUseId?: ToolUseIdType
  legacyPath?: string
  legacyProjectSessionId?: string
}

function optionalSessionId(value: string | null): SessionIdType | undefined {
  if (!value) return undefined
  try {
    return Schema.decodeUnknownSync(SessionId)(value)
  } catch {
    return undefined
  }
}

function optionalToolUseId(value: string | null): ToolUseIdType | undefined {
  if (!value) return undefined
  try {
    return Schema.decodeUnknownSync(ToolUseId)(value)
  } catch {
    return undefined
  }
}

export function parseToolSessionRoute(input: string | URL): ToolSessionRoute {
  const url = typeof input === "string" ? new URL(input, "http://yaade.local") : input
  const sessionId = optionalSessionId(url.searchParams.get("s"))
  const toolUseId = optionalToolUseId(url.searchParams.get("u"))
  const legacyPath = url.pathname !== "/" ? url.pathname : undefined
  const legacyProjectSessionId =
    !toolUseId && url.pathname === "/" && url.searchParams.get("s") && !sessionId
      ? url.searchParams.get("s") ?? undefined
      : undefined
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    ...(legacyPath ? { legacyPath } : {}),
    ...(legacyProjectSessionId ? { legacyProjectSessionId } : {}),
  }
}

export function toolSessionUrl(sessionId: SessionIdType, toolUseId?: ToolUseIdType): string {
  const params = new URLSearchParams({ s: sessionId })
  if (toolUseId) params.set("u", toolUseId)
  return `/?${params.toString()}`
}

export function chooseSession(
  requested: SessionIdType | undefined,
  sessions: readonly AppSession[],
): AppSession | undefined {
  const visible = sessions.filter(session => !session.archivedAt)
  return (
    visible.find(session => session.id === requested) ??
    [...visible].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  )
}

export function chooseToolUse(
  requested: ToolUseIdType | undefined,
  session: AppSession | undefined,
  toolUseIds: readonly ToolUseIdType[],
): ToolUseIdType | undefined {
  if (!session) return undefined
  if (requested && toolUseIds.includes(requested)) return requested
  if (session.activeToolUseId && toolUseIds.includes(session.activeToolUseId)) {
    return session.activeToolUseId
  }
  return toolUseIds[0]
}
