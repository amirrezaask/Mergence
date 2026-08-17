import type { ToolUse } from "@yaade/rpc";

export type RuntimeToolTitle = {
  readonly title: string;
  readonly source: "prompt" | "terminal";
};

export function compactToolTitle(value: string, maxLength = 72): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

export function toolUseWorkTitle(
  use: ToolUse,
  runtimeTitle?: RuntimeToolTitle,
): string {
  return (
    runtimeTitle?.title ||
    compactToolTitle(use.title) ||
    (use.kind === "git" ? "Git History" : "Terminal")
  );
}

/** Project and worktree — always shown, never baked into the work title. */
export function toolUseContextCaption(use: ToolUse): string {
  const project = compactToolTitle(use.context.project.projectName);
  const checkout = compactToolTitle(use.context.checkoutLabel);
  if (project && checkout) return `${project} · ${checkout}`;
  return project || checkout;
}

export function toolUseDisplayTitle(
  use: ToolUse,
  runtimeTitle?: RuntimeToolTitle,
): string {
  const title = toolUseWorkTitle(use, runtimeTitle);
  const projectName = compactToolTitle(use.context.project.projectName);
  return projectName ? compactToolTitle(`${projectName}: ${title}`) : title;
}

function isWorkingDirectoryTitle(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value.startsWith("/");
}

/** Pane chrome omits terminal working-directory titles while keeping process names. */
export function toolUsePaneTitle(
  use: ToolUse,
  runtimeTitle?: RuntimeToolTitle,
): string {
  const title = toolUseWorkTitle(use, runtimeTitle);
  if (runtimeTitle?.source !== "terminal") return title;
  return title
    .split(" · ")
    .filter((part) => !isWorkingDirectoryTitle(part))
    .join(" · ");
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
    use.kind === "terminal" &&
    (normalized === "terminal" || normalized === stored)
  ) {
    return current;
  }
  return { title: next, source };
}
