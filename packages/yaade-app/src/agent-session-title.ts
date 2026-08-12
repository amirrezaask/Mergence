/**
 * Session sidebar titles for CLI agents.
 *
 * Agents seed `agentTitle` with the driver label ("Cursor"). Real titles come
 * from the first user prompt (hook) or a non-generic OSC / notification title.
 */

const GENERIC_AGENT_TITLES = new Set([
  "agent",
  "claude",
  "codex",
  "cursor",
  "cursor agent",
  "grok",
  "opencode",
  "pi",
  "terminal",
])

export function isGenericAgentSessionTitle(
  title: string | undefined | null,
  agentId?: string | null,
): boolean {
  const trimmed = title?.trim()
  if (!trimmed) return true
  const lower = trimmed.toLowerCase()
  if (GENERIC_AGENT_TITLES.has(lower)) return true
  if (agentId && lower === agentId.trim().toLowerCase()) return true
  return false
}

/** Collapse whitespace and truncate for sidebar / modal chrome. */
export function titleFromUserPrompt(prompt: string, maxLen = 72): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim()
  if (!oneLine) return ""
  if (oneLine.length <= maxLen) return oneLine
  return `${oneLine.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`
}

export function shouldApplyAgentSessionTitle(
  nextTitle: string | undefined | null,
  currentTitle: string | undefined | null,
  agentId?: string | null,
): boolean {
  if (isGenericAgentSessionTitle(nextTitle, agentId)) return false
  if (!isGenericAgentSessionTitle(currentTitle, agentId)) return false
  return true
}
