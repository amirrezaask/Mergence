import {
  Bot,
  PanelLeft,
  Search,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import type { ToolKind, ToolUse, ToolUseId } from "@yaade/rpc";
import { Badge, Button } from "@yaade/ui/primitives";

const toolIcon: Record<ToolKind, typeof Bot> = {
  agent: Bot,
  terminal: TerminalIcon,
  search: Search,
};

function statusLabel(status: ToolUse["status"]): string {
  return status === "succeeded" ? "done" : status;
}

export type ToolUseSidebarProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly useIds: readonly ToolUseId[];
  readonly usesById: ReadonlyMap<ToolUseId, ToolUse>;
  readonly activeToolUseId?: ToolUseId;
  readonly onSelect: (use: ToolUse) => void;
  readonly onAddKind: (kind: ToolKind) => void;
  readonly onRename: (use: ToolUse, title: string) => void;
  readonly onReorder: (ids: readonly ToolUseId[]) => void;
};

export function ToolUseSidebar(props: ToolUseSidebarProps) {
  return (
    <>
      {props.open ? (
        <button
          type="button"
          aria-label="Close tool sidebar"
          className="absolute inset-0 z-10 bg-background/60 md:hidden"
          onClick={() => props.onOpenChange(false)}
        />
      ) : null}
      <aside
        className={`absolute inset-y-0 left-0 z-20 flex w-[296px] shrink-0 flex-col border-r border-border bg-sidebar shadow-lg transition-transform md:relative md:z-auto md:shadow-none ${
          props.open ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <div className="flex items-center justify-end px-3 py-3">
          <div className="flex items-center gap-1">
            <Button
              className="md:hidden"
              size="icon-sm"
              variant="ghost"
              aria-label="Close tool sidebar"
              onClick={() => props.onOpenChange(false)}
            >
              <X />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="New Search"
              title="New Search"
              onClick={() => props.onAddKind("search")}
            >
              <Search />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="New Agent"
              title="New Agent"
              onClick={() => props.onAddKind("agent")}
            >
              <Bot />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="New Terminal"
              title="New Terminal"
              onClick={() => props.onAddKind("terminal")}
            >
              <TerminalIcon />
            </Button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2">
          {props.useIds.map((id, index) => {
            const use = props.usesById.get(id);
            if (!use) return null;
            const Icon = toolIcon[use.kind];
            return (
              <button
                key={id}
                type="button"
                draggable
                onDragStart={(event) =>
                  event.dataTransfer.setData("text/tool-use-id", id)
                }
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  const from = event.dataTransfer.getData(
                    "text/tool-use-id",
                  ) as ToolUseId;
                  if (!from || from === id) return;
                  const ids = [...props.useIds];
                  const fromIndex = ids.indexOf(from);
                  if (fromIndex < 0) return;
                  ids.splice(fromIndex, 1);
                  ids.splice(index, 0, from);
                  props.onReorder(ids);
                }}
                onClick={() => {
                  props.onSelect(use);
                  props.onOpenChange(false);
                }}
                onDoubleClick={() => {
                  const next = window
                    .prompt("Rename tool use", use.title)
                    ?.trim();
                  if (next) props.onRename(use, next);
                }}
                className={`flex min-h-16 items-center gap-3 rounded-md px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  id === props.activeToolUseId
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "hover:bg-sidebar-accent/60"
                }`}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {use.context.project.projectName}
                  </span>
                  <span className="mt-1 block truncate font-mono text-2xs text-muted-foreground">
                    {use.context.checkoutLabel}
                  </span>
                </span>
                <Badge variant="outline" className="shrink-0 text-2xs">
                  {statusLabel(use.status)}
                </Badge>
              </button>
            );
          })}
        </div>
      </aside>
    </>
  );
}

export function SidebarOpenButton(props: { onClick: () => void }) {
  return (
    <Button
      className="md:hidden"
      size="icon-sm"
      variant="ghost"
      aria-label="Open tool sidebar"
      onClick={props.onClick}
    >
      <PanelLeft />
    </Button>
  );
}
