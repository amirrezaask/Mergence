/** Normalize legacy / alias agent ids to canonical CLI provider ids. */
export function normalizeAgentId(agentId: string | null | undefined): string {
  if (agentId === "claudeAgent") return "claude"
  if (agentId === "cursorAcp" || agentId === "cursor-acp") return "cursor"
  return agentId ?? "codex"
}

/** CLI driver id for an agent (`codex:cli`, `claude:cli`, …). */
export function agentCliDriverId(agentId: string | null | undefined): string {
  return `${normalizeAgentId(agentId)}:cli`
}

/** @deprecated Prefer `agentCliDriverId` — kept for call-site compatibility. */
export function agentDriverIdForMode(
  agentId: string,
  _mode: "cli" | "native" = "cli",
): string {
  return agentCliDriverId(agentId)
}
