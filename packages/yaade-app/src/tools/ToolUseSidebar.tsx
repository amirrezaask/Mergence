import { useState } from "react";
import { Bot, Search, Terminal as TerminalIcon, X } from "lucide-react";
import type { ToolKind, ToolUse, ToolUseId } from "@yaade/rpc";
import { cn } from "@yaade/ui";
import { Badge, Button, Input } from "@yaade/ui/primitives";
import { toolUseDisplayTitle, type RuntimeToolTitle } from "./tool-title.js";

const toolIcon: Record<ToolKind, typeof Bot> = {
  agent: Bot,
  terminal: TerminalIcon,
  search: Search,
};

function statusLabel(status: ToolUse["status"]): string {
  if (status === "succeeded") return "done";
  if (status === "disconnected") return "offline";
  return status;
}

function statusVariant(
  status: ToolUse["status"],
): "secondary" | "info" | "success" | "warning" | "destructive" | "outline" {
  if (status === "running") return "success";
  if (status === "starting" || status === "created") return "info";
  if (status === "waiting") return "warning";
  if (status === "failed" || status === "disconnected") return "destructive";
  if (status === "cancelled") return "outline";
  return "secondary";
}

export type ToolUseSidebarProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly useIds: readonly ToolUseId[];
  readonly usesById: ReadonlyMap<ToolUseId, ToolUse>;
  readonly activeToolUseId?: ToolUseId;
  readonly runtimeTitles: ReadonlyMap<ToolUseId, RuntimeToolTitle>;
  readonly onSelect: (use: ToolUse) => void;
  readonly onAddKind: (kind: ToolKind) => void;
  readonly onRename: (use: ToolUse, title: string) => void;
  readonly onReorder: (ids: readonly ToolUseId[]) => void;
};

export function ToolUseSidebar(props: ToolUseSidebarProps) {
  const [editingId, setEditingId] = useState<ToolUseId | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  const finishRename = (use: ToolUse) => {
    const next = draftTitle.trim();
    setEditingId(null);
    if (next && next !== use.title) props.onRename(use, next);
  };

  return (
    <>
      {props.open ? (
        <button
          type="button"
          aria-label="Close tool sidebar"
          className="absolute inset-0 z-10 bg-backdrop/70 backdrop-blur-sm md:hidden"
          onClick={() => props.onOpenChange(false)}
        />
      ) : null}
      <aside
        className={cn(
          "absolute inset-y-0 left-0 z-20 flex w-[280px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar shadow-lg transition-transform duration-[var(--yaade-motion-panel)] ease-[var(--yaade-ease-drawer)] md:relative md:z-auto md:shadow-none",
          props.open ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        )}
        data-yaade-tool-sidebar
      >
        <div className="flex h-10 shrink-0 items-center justify-end gap-1.5 border-b border-sidebar-border/80 px-2.5">
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
            variant="default"
            aria-label="New Agent"
            title="New Agent"
            onClick={() => props.onAddKind("agent")}
          >
            <Bot />
          </Button>
          <Button
            size="icon-sm"
            variant="secondary"
            aria-label="New Terminal"
            title="New Terminal"
            onClick={() => props.onAddKind("terminal")}
          >
            <TerminalIcon />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
          {props.useIds.map((id, index) => {
            const use = props.usesById.get(id);
            if (!use) return null;
            const Icon = toolIcon[use.kind];
            const active = id === props.activeToolUseId;
            const displayTitle = toolUseDisplayTitle(
              use,
              props.runtimeTitles.get(id),
            );
            return (
              <div
                key={id}
                role="button"
                tabIndex={active ? 0 : -1}
                aria-current={active ? "page" : undefined}
                data-active={active ? "true" : undefined}
                data-yaade-tool-use={id}
                draggable={editingId !== id}
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
                  if (editingId === id) return;
                  props.onSelect(use);
                  props.onOpenChange(false);
                }}
                onDoubleClick={() => {
                  setDraftTitle(use.title);
                  setEditingId(id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && editingId !== id)
                    props.onSelect(use);
                }}
                className="group relative flex min-h-17 items-center gap-2.5 overflow-hidden rounded-lg border border-transparent px-2.5 text-left outline-none transition-[color,background-color,border-color,transform] duration-[var(--yaade-motion-hot)] hover:bg-sidebar-accent/70 focus-visible:border-sidebar-ring focus-visible:ring-2 focus-visible:ring-sidebar-ring/40 data-[active=true]:border-sidebar-primary/45 data-[active=true]:bg-sidebar-primary/14"
              >
                <span className="absolute inset-y-2 left-0 w-0.5 -translate-x-full rounded-full bg-sidebar-primary transition-transform duration-[var(--yaade-motion-menu)] ease-[var(--yaade-ease-out)] group-data-[active=true]:translate-x-0" />
                <span className="grid size-8 shrink-0 place-items-center rounded-md border border-sidebar-border bg-background/50 text-muted-foreground transition-colors group-data-[active=true]:border-sidebar-primary/35 group-data-[active=true]:bg-sidebar-primary/16 group-data-[active=true]:text-sidebar-primary">
                  <Icon className="size-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  {editingId === id ? (
                    <Input
                      aria-label={`Rename ${use.title}`}
                      className="h-6 bg-background px-1.5"
                      autoFocus
                      value={draftTitle}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setDraftTitle(event.target.value)}
                      onBlur={() => finishRename(use)}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") finishRename(use);
                        if (event.key === "Escape") setEditingId(null);
                      }}
                    />
                  ) : (
                    <span
                      className="block truncate text-xs font-semibold text-sidebar-foreground"
                      data-yaade-tool-title
                    >
                      {displayTitle}
                    </span>
                  )}
                  <span className="mt-0.5 block truncate font-mono text-3xs text-muted-foreground">
                    {use.context.project.projectName} ·{" "}
                    {use.context.checkoutLabel}
                  </span>
                </span>
                <Badge
                  variant={statusVariant(use.status)}
                  className="shrink-0 px-1.5 py-0 text-3xs"
                >
                  {statusLabel(use.status)}
                </Badge>
              </div>
            );
          })}
        </div>
      </aside>
    </>
  );
}
