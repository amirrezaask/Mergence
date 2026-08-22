import { Terminal } from "lucide-react";
import type { AppSession, TerminalKind, MuxTerminal, MuxTerminalId } from "@yaade/rpc";
import { formatKeyBinding, PaletteShell, type PaletteShellItem } from "@yaade/ui/session";
import { muxTerminalWorkTitle, type RuntimeTerminalTitle } from "./terminal-title.js";
import { muxSessionShortcutFor } from "./mux-keymap.js";

const terminalIcons = {
  terminal: Terminal,
} satisfies Record<TerminalKind, typeof Terminal>;

type TerminalSwitcherEntry = {
  readonly terminal: MuxTerminal;
  readonly session: AppSession;
  readonly title: string;
};

export function TerminalSwitcher(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly sessionsById: ReadonlyMap<AppSession["id"], AppSession>;
  readonly terminalsById: ReadonlyMap<MuxTerminalId, MuxTerminal>;
  readonly activeMuxTerminalId?: MuxTerminalId;
  readonly runtimeTitles: ReadonlyMap<MuxTerminalId, RuntimeTerminalTitle>;
  readonly onSelect: (terminal: MuxTerminal) => void;
}) {
  const items: PaletteShellItem<TerminalSwitcherEntry>[] = [];
  for (const terminal of props.terminalsById.values()) {
    if (terminal.archivedAt) continue;
    const session = props.sessionsById.get(terminal.sessionId);
    if (!session || session.archivedAt) continue;
    const title = muxTerminalWorkTitle(terminal, props.runtimeTitles.get(terminal.id));
    items.push({
      key: terminal.id,
      value: `${title} ${session.title} ${terminal.kind}`,
      data: { terminal, session, title },
    });
  }

  return (
    <PaletteShell
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Switch terminal"
      description={`Jump to a current terminal across all sessions (${formatKeyBinding(muxSessionShortcutFor("terminal.switch") ?? "Mod-k u")}).`}
      placeholder="Search terminals or sessions…"
      size="picker"
      items={items}
      rowLayout="detail"
      requireQueryForSelection={false}
      emptyLabel="No current terminals."
      onSelect={(entry) => {
        props.onSelect(entry.terminal);
        props.onOpenChange(false);
      }}
      renderItem={(entry) => {
        const Icon = terminalIcons[entry.terminal.kind];
        return (
          <span
            className="flex min-w-0 flex-1 items-center gap-2.5"
            data-yaade-terminal-switcher-terminal={entry.terminal.id}
          >
            <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
              <Icon className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">
                {entry.title}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {entry.session.title}
              </span>
            </span>
            <span className="shrink-0 font-mono text-3xs text-muted-foreground">
              {entry.terminal.id === props.activeMuxTerminalId ? "current" : entry.terminal.kind}
            </span>
          </span>
        );
      }}
    />
  );
}
