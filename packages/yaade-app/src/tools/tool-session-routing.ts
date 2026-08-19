import { Schema } from "effect"
import {
  AppSession,
  SessionId,
  SessionTabId,
  ToolUseId,
  type SessionTab,
  type SessionId as SessionIdType,
  type ToolUseId as ToolUseIdType,
} from "@yaade/rpc"

export type ToolSessionRoute = {
  sessionId?: SessionIdType
  tabId?: SessionTabId
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

function optionalTabId(value: string | null): SessionTabId | undefined {
  if (!value) return undefined
  try {
    return Schema.decodeUnknownSync(SessionTabId)(value)
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
  const tabId = optionalTabId(url.searchParams.get("t"))
  const toolUseId = optionalToolUseId(url.searchParams.get("u"))
  const legacyPath = url.pathname !== "/" ? url.pathname : undefined
  const legacyProjectSessionId =
    !toolUseId && url.pathname === "/" && url.searchParams.get("s") && !sessionId
      ? url.searchParams.get("s") ?? undefined
      : undefined
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(tabId ? { tabId } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    ...(legacyPath ? { legacyPath } : {}),
    ...(legacyProjectSessionId ? { legacyProjectSessionId } : {}),
  }
}

function isSessionTabId(value: SessionTabId | ToolUseIdType): value is SessionTabId {
  return value.startsWith("tab-")
}

function isToolUseId(value: SessionTabId | ToolUseIdType): value is ToolUseIdType {
  return value.startsWith("use-")
}

/** Build a deep link using tmux's session/window/pane hierarchy. */
export function toolSessionUrl(
  sessionId: SessionIdType,
  tabOrToolUseId?: SessionTabId | ToolUseIdType,
  toolUseId?: ToolUseIdType,
): string {
  const params = new URLSearchParams({ s: sessionId })
  const tabId = tabOrToolUseId && isSessionTabId(tabOrToolUseId)
    ? tabOrToolUseId
    : undefined
  const paneId = toolUseId ?? (
    tabOrToolUseId && isToolUseId(tabOrToolUseId)
      ? tabOrToolUseId
      : undefined
  )
  if (tabId) params.set("t", tabId)
  if (paneId) params.set("u", paneId)
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

export function isLiveSessionTab(
  session: AppSession | undefined,
  tab: SessionTab | undefined,
): boolean {
  return Boolean(
    session &&
      !session.archivedAt &&
      tab &&
      !tab.archivedAt &&
      tab.sessionId === session.id,
  )
}

export function chooseTab(
  requested: SessionTabId | undefined,
  session: AppSession | undefined,
  tabs: readonly SessionTab[],
): SessionTab | undefined {
  if (!session) return undefined
  const visible = tabs
    .filter(tab => tab.sessionId === session.id && !tab.archivedAt)
    .sort((a, b) => a.position - b.position)
  return (
    visible.find(tab => tab.id === requested) ??
    visible.find(tab => tab.id === session.activeTabId) ??
    visible[0]
  )
}

export function chooseToolUse(
  requested: ToolUseIdType | undefined,
  tab: SessionTab | AppSession | undefined,
  toolUseIds: readonly ToolUseIdType[],
): ToolUseIdType | undefined {
  if (!tab) return undefined
  if (requested && toolUseIds.includes(requested)) return requested
  const activeToolUseId = tab.activeToolUseId
  if (activeToolUseId && toolUseIds.includes(activeToolUseId)) return activeToolUseId
  return toolUseIds[0]
}
