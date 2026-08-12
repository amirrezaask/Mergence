/** Presentation status for Mission Control session tiles. */
export type SessionCardStatus =
  | "running"
  | "testing"
  | "planning"
  | "queued"
  | "approval"
  | "idle"
  | "failed"
  | "archived"

export type SessionProvider =
  | "claude"
  | "cursor"
  | "codex"
  | "opencode"
  | "grok"
  | "pi"

export type SessionCardModel = {
  id: string
  projectId: string
  kind: "session"
  agentId?: SessionProvider
  /** Display name for the bound agent, or “Session” before one is selected. */
  agentLabel: string
  title: string
  description?: string
  status: SessionCardStatus
  requiresApproval?: boolean
  /** ADE unread badge count from AgentSessionSnapshot. */
  unreadCount?: number
  /** Compact stats: "8m active · 3 turns · 24 tools". */
  statsLine?: string
}

/** Runtime PTY statuses used by terminal sessions. */
export type TerminalRuntimeStatus = "starting" | "running" | "exited" | "failed"

export function mapRuntimeStatusToCardStatus(
  status: TerminalRuntimeStatus,
  archived?: boolean,
): SessionCardStatus {
  if (archived) return "archived"
  switch (status) {
    case "starting":
    case "running":
      return "running"
    case "failed":
      return "failed"
    case "exited":
      return "idle"
  }
}

export function detectSessionProvider(
  launchCommand?: string,
): SessionProvider | undefined {
  if (!launchCommand) return undefined
  const cmd = launchCommand.trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  if (cmd === "claude" || cmd.endsWith("/claude")) return "claude"
  if (cmd === "codex" || cmd.endsWith("/codex")) return "codex"
  if (cmd === "opencode" || cmd.endsWith("/opencode")) return "opencode"
  if (cmd === "cursor-agent" || cmd.endsWith("/cursor-agent") || cmd === "cursor") {
    return "cursor"
  }
  if (cmd === "grok" || cmd.endsWith("/grok")) return "grok"
  if (cmd === "pi" || cmd.endsWith("/pi")) return "pi"
  return undefined
}

export function providerDisplayLabel(
  kind: "agent" | "terminal",
  provider?: SessionProvider,
): string {
  if (kind === "terminal" && !provider) return "Terminal"
  switch (provider) {
    case "claude":
      return "Claude"
    case "cursor":
      return "Cursor"
    case "codex":
      return "Codex"
    case "opencode":
      return "OpenCode"
    case "grok":
      return "Grok"
    case "pi":
      return "Pi"
    default:
      return kind === "agent" ? "Agent" : "Terminal"
  }
}

export function sessionAgentLabel(agentId?: SessionProvider): string {
  return agentId ? providerDisplayLabel("agent", agentId) : "Session"
}

export function defaultSessionDescription(
  kind: "agent" | "terminal",
  status: SessionCardStatus,
): string {
  if (status === "failed") {
    return kind === "terminal" ? "Process unavailable." : "Session failed."
  }
  if (status === "archived") return "Archived — history kept."
  if (status === "approval") return "Changes require review before continuing."
  if (status === "queued") return "Waiting in queue."
  if (status === "planning") return "Planning next steps."
  if (status === "testing") return "Running checks."
  if (kind === "terminal") {
    return status === "running" ? "Shell active." : "Ready for commands."
  }
  return status === "running" ? "Session in progress." : "Agent standing by."
}

export function sessionStatusLabel(status: SessionCardStatus): string {
  switch (status) {
    case "running":
      return "Running"
    case "testing":
      return "Testing"
    case "planning":
      return "Planning"
    case "queued":
      return "Queued"
    case "approval":
      return "Approval"
    case "idle":
      return "Idle"
    case "failed":
      return "Failed"
    case "archived":
      return "Archived"
  }
}
