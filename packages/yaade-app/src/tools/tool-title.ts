import type { ToolUse } from "@yaade/rpc";

export type RuntimeToolTitle = {
  readonly title: string;
  readonly source: "prompt" | "terminal";
};

const GENERIC_PROCESS_TITLES = new Set([
  "agent",
  "terminal",
  "shell",
  "claude",
  "claude agent",
  "codex",
  "codex agent",
  "cursor",
  "cursor agent",
  "opencode",
  "opencode agent",
  "grok",
  "grok agent",
  "pi",
  "pi agent",
]);

export function compactToolTitle(value: string, maxLength = 72): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

export function toolUseDisplayTitle(
  use: ToolUse,
  runtimeTitle?: RuntimeToolTitle,
): string {
  if (use.input.kind === "search") {
    return compactToolTitle(use.input.query) || "Search";
  }
  return (
    runtimeTitle?.title ||
    compactToolTitle(use.title) ||
    (use.kind === "agent" ? "Agent" : "Terminal")
  );
}

export function nextRuntimeToolTitle(
  use: ToolUse,
  current: RuntimeToolTitle | undefined,
  title: string,
  source: RuntimeToolTitle["source"],
): RuntimeToolTitle | undefined {
  const next = compactToolTitle(title);
  if (!next) return current;

  if (source === "prompt") {
    return current?.source === "terminal" ? current : { title: next, source };
  }

  const normalized = next.toLowerCase();
  const stored = compactToolTitle(use.title).toLowerCase();
  if (
    use.kind === "agent" &&
    (GENERIC_PROCESS_TITLES.has(normalized) || normalized === stored)
  ) {
    return current;
  }
  if (
    use.kind === "terminal" &&
    (normalized === "terminal" || normalized === stored)
  ) {
    return current;
  }
  return { title: next, source };
}
