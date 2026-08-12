import type { SessionProvider } from "./session-card-model.js"

/** Agent CLI drivers launched in a PTY for ADE sessions. */
export type AgentCliDriver = {
  id: SessionProvider
  label: string
  description: string
  /** CLI binary (and optional args). */
  command: string
}

export const AGENT_CLI_DRIVERS: readonly AgentCliDriver[] = [
  {
    id: "codex",
    label: "Codex",
    description: "OpenAI Codex CLI",
    command: "codex",
  },
  {
    id: "claude",
    label: "Claude",
    description: "Anthropic Claude Code CLI",
    command: "claude",
  },
  {
    id: "opencode",
    label: "OpenCode",
    description: "OpenCode CLI",
    command: "opencode",
  },
  {
    id: "cursor",
    label: "Cursor",
    description: "Cursor Agent CLI",
    command: "cursor-agent",
  },
  {
    id: "grok",
    label: "Grok",
    description: "xAI Grok CLI",
    command: "grok",
  },
  {
    id: "pi",
    label: "Pi",
    description: "Pi coding agent CLI",
    command: "pi",
  },
] as const

export function agentCliDriverById(
  id: string,
): AgentCliDriver | undefined {
  return AGENT_CLI_DRIVERS.find(driver => driver.id === id)
}
