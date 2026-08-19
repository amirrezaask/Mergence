/** Canonical identities shared by CLI, terminal-instance, and RPC adapters. */
export const CLI_PROVIDERS = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "grok",
  "pi",
] as const

export type CliProvider = (typeof CLI_PROVIDERS)[number]

export type CliProviderDescriptor = {
  readonly id: CliProvider
  readonly binary: string
  readonly label: string
}

export const CLI_PROVIDER_CATALOG: Readonly<Record<CliProvider, CliProviderDescriptor>> = {
  claude: { id: "claude", binary: "claude", label: "Claude" },
  codex: { id: "codex", binary: "codex", label: "Codex" },
  cursor: { id: "cursor", binary: "cursor-agent", label: "Cursor" },
  opencode: { id: "opencode", binary: "opencode", label: "OpenCode" },
  grok: { id: "grok", binary: "grok", label: "Grok" },
  pi: { id: "pi", binary: "pi", label: "Pi" },
}

const CLI_PROVIDER_SET: ReadonlySet<string> = new Set(CLI_PROVIDERS)

export function isCliProvider(value: string | null | undefined): value is CliProvider {
  return value != null && CLI_PROVIDER_SET.has(value)
}

export function cliProviderDescriptor(provider: CliProvider): CliProviderDescriptor {
  return CLI_PROVIDER_CATALOG[provider]
}
