import type { AgentProvider } from "./ToolContextControls.js";

const PROVIDER_PATTERNS: readonly {
  provider: AgentProvider;
  pattern: RegExp;
}[] = [
  { provider: "claude", pattern: /(?:^|[\s/\\_-])claude(?:[\s/\\_-]+code)?(?:$|[\s/\\_-])/i },
  { provider: "codex", pattern: /(?:^|[\s/\\_-])codex(?:$|[\s/\\_-])/i },
  { provider: "cursor", pattern: /(?:^|[\s/\\_-])cursor(?:[\s/\\_-]+agent)?(?:$|[\s/\\_-])/i },
  { provider: "opencode", pattern: /(?:^|[\s/\\_-])open[\s_-]?code(?:$|[\s/\\_-])/i },
  { provider: "grok", pattern: /(?:^|[\s/\\_-])grok(?:$|[\s/\\_-])/i },
  { provider: "pi", pattern: /(?:^|[\s/\\_-])pi(?:$|[\s/\\_-])/i },
];

/** Detect a supported agent CLI from one or more process/title identities. */
export function agentProviderFromTerminalIdentity(
  ...identities: readonly (string | null | undefined)[]
): AgentProvider | null {
  for (const identity of identities) {
    const value = identity?.trim();
    if (!value) continue;
    const padded = ` ${value} `;
    for (const candidate of PROVIDER_PATTERNS) {
      if (candidate.pattern.test(padded)) return candidate.provider;
    }
  }
  return null;
}

const SCRIPT_RUNTIMES = new Set([
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "ruby",
]);

/**
 * Prefer host foreground-process truth. Ghostty's title is a fallback only for
 * script runtimes, whose OS process name hides the CLI executable. This avoids
 * retaining a stale agent title after the shell regains foreground control.
 */
export function agentProviderFromTerminal(
  processName: string | null | undefined,
  ghosttyTitle: string | null | undefined,
): AgentProvider | null {
  const processProvider = agentProviderFromTerminalIdentity(processName);
  if (processProvider) return processProvider;
  const base =
    processName?.trim().toLowerCase().split(/[/\\]/).pop() ?? "";
  if (base && !SCRIPT_RUNTIMES.has(base)) return null;
  return agentProviderFromTerminalIdentity(ghosttyTitle);
}
