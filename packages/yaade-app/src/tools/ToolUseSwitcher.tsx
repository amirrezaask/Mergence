import { Bot, FileCode2, GitBranch, Search, Terminal } from "lucide-react";
import type { AppSession, ToolKind, ToolUse, ToolUseId } from "@yaade/rpc";
import { PaletteShell, type PaletteShellItem } from "@yaade/ui";
import { toolUseDisplayTitle, type RuntimeToolTitle } from "./tool-title.js";

const toolIcons: Record<ToolKind, typeof Bot> = {
  agent: Bot,
  editor: FileCode2,
  terminal: Terminal,
  search: Search,
  git: GitBranch,
};

type ToolUseSwitcherEntry = {
  readonly use: ToolUse;
  readonly session: AppSession;
  readonly title: string;
};

export function ToolUseSwitcher(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly sessionsById: ReadonlyMap<AppSession["id"], AppSession>;
  readonly usesById: ReadonlyMap<ToolUseId, ToolUse>;
  readonly activeToolUseId?: ToolUseId;
  readonly runtimeTitles: ReadonlyMap<ToolUseId, RuntimeToolTitle>;
  readonly onSelect: (use: ToolUse) => void;
}) {
  const items: PaletteShellItem<ToolUseSwitcherEntry>[] = [];
  for (const use of props.usesById.values()) {
    if (use.archivedAt) continue;
    const session = props.sessionsById.get(use.sessionId);
    if (!session || session.archivedAt) continue;
    const title = toolUseDisplayTitle(use, props.runtimeTitles.get(use.id));
    items.push({
      key: use.id,
      value: `${title} ${session.title} ${use.context.project.projectName} ${use.kind}`,
      data: { use, session, title },
    });
  }

  return (
    <PaletteShell
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Switch tool"
      description="Jump to a current tool across all sessions."
      placeholder="Search tools, sessions, or projects…"
      size="picker"
      items={items}
      rowLayout="detail"
      requireQueryForSelection={false}
      emptyLabel="No current tools."
      onSelect={(entry) => {
        props.onSelect(entry.use);
        props.onOpenChange(false);
      }}
      renderItem={(entry) => {
        const Icon = toolIcons[entry.use.kind];
        return (
          <span
            className="flex min-w-0 flex-1 items-center gap-2.5"
            data-yaade-tool-switcher-use={entry.use.id}
          >
            <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
              <Icon className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">
                {entry.title}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {entry.session.title} · {entry.use.context.project.projectName}
              </span>
            </span>
            <span className="shrink-0 font-mono text-3xs text-muted-foreground">
              {entry.use.id === props.activeToolUseId ? "current" : entry.use.kind}
            </span>
          </span>
        );
      }}
    />
  );
}
