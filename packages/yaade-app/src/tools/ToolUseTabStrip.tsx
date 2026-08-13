import { useRef, useState } from "react";
import {
  Bot,
  GitBranch,
  Search,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import type {
  CheckoutTarget,
  ProjectTarget,
  ToolKind,
  ToolUse,
  ToolUseId,
} from "@yaade/rpc";
import {
  Badge,
  Button,
  Input,
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@yaade/ui/primitives";
import {
  ToolContextControls,
  type AgentProvider,
} from "./ToolContextControls.js";
import { toolUseDisplayTitle, type RuntimeToolTitle } from "./tool-title.js";

const toolIcon: Record<ToolKind, typeof Bot> = {
  agent: Bot,
  terminal: TerminalIcon,
  search: Search,
  git: GitBranch,
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

export type ToolUseTabStripProps = {
  readonly useIds: readonly ToolUseId[];
  readonly usesById: ReadonlyMap<ToolUseId, ToolUse>;
  readonly activeToolUseId?: ToolUseId;
  readonly runtimeTitles: ReadonlyMap<ToolUseId, RuntimeToolTitle>;
  readonly projects: readonly ProjectTarget[];
  readonly onSelect: (use: ToolUse) => void;
  readonly onContextChange: (
    use: ToolUse,
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>;
  readonly onProviderChange: (
    use: ToolUse,
    provider: AgentProvider,
  ) => Promise<void>;
  readonly onAddKind: (kind: ToolKind) => void;
  readonly onClose: (use: ToolUse) => void;
  readonly onRename: (use: ToolUse, title: string) => void;
  readonly onReorder: (ids: readonly ToolUseId[]) => void;
};

export function ToolUseTabStrip(props: ToolUseTabStripProps) {
  const dragId = useRef<ToolUseId | null>(null);
  const [editingId, setEditingId] = useState<ToolUseId | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [contextPopoverId, setContextPopoverId] = useState<ToolUseId | null>(
    null,
  );

  const finishRename = (use: ToolUse) => {
    const next = draftTitle.trim();
    setEditingId(null);
    if (next && next !== use.title) props.onRename(use, next);
  };

  return (
    <header
      className="flex h-11 shrink-0 items-center border-b border-border bg-card/55 backdrop-blur-xl"
      data-yaade-tool-tabs
    >
      <nav
        className="flex h-full min-w-0 flex-1 items-end gap-1 overflow-x-auto px-2 pt-1.5"
        aria-label="Tool uses"
        role="tablist"
      >
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
            <Popover
              key={id}
              open={contextPopoverId === id}
              onOpenChange={(open) => setContextPopoverId(open ? id : null)}
            >
              <PopoverAnchor asChild>
                <div
                  role="tab"
                  tabIndex={active ? 0 : -1}
                  aria-selected={active}
                  aria-haspopup="dialog"
                  aria-expanded={contextPopoverId === id}
                  data-active={active ? "true" : undefined}
                  data-yaade-tool-use={id}
                  draggable={editingId !== id}
                  onDragStart={() => {
                    dragId.current = id;
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    const from = dragId.current;
                    dragId.current = null;
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
                    setContextPopoverId(id);
                  }}
                  className="group relative flex h-8 min-w-36 max-w-64 shrink-0 items-center rounded-t-lg border border-b-0 border-transparent px-1 transition-[color,background-color,border-color] duration-[var(--yaade-motion-hot)] data-[active=true]:border-border data-[active=true]:bg-background"
                >
                  <span
                    className="absolute inset-x-2 top-0 h-0.5 origin-center scale-x-0 rounded-full bg-primary transition-transform duration-[var(--yaade-motion-menu)] ease-[var(--yaade-ease-out)] group-data-[active=true]:scale-x-100"
                    aria-hidden
                  />
                  <span className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors group-data-[active=true]:text-primary">
                    <Icon className="size-3.5" aria-hidden />
                  </span>
                  {editingId === id ? (
                    <Input
                      aria-label={`Rename ${use.title}`}
                      className="h-6 min-w-0 flex-1 border-primary/50 bg-background px-1.5"
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
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate px-1 text-left text-xs font-medium text-muted-foreground outline-none transition-colors group-data-[active=true]:text-foreground"
                      onDoubleClick={() => {
                        setDraftTitle(use.title);
                        setEditingId(id);
                      }}
                    >
                      <span data-yaade-tool-title>{displayTitle}</span>
                    </button>
                  )}
                  <Badge
                    variant={statusVariant(use.status)}
                    className="shrink-0 px-1 py-0 text-4xs"
                  >
                    {statusLabel(use.status)}
                  </Badge>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Close ${displayTitle}`}
                    className="ml-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-data-[active=true]:opacity-70"
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onClose(use);
                    }}
                  >
                    <X />
                  </Button>
                </div>
              </PopoverAnchor>
              <PopoverContent
                side="top"
                align="start"
                sideOffset={8}
                className="w-80 max-w-[calc(100vw-1rem)] p-0"
                data-yaade-tool-context-popover
              >
                <div className="border-b border-border px-3 py-2">
                  <p className="text-sm font-medium">Tool context</p>
                  <p className="truncate text-2xs text-muted-foreground">
                    Choose where this tool runs
                  </p>
                </div>
                <ToolContextControls
                  use={use}
                  projects={props.projects}
                  active={active}
                  presentation="popover"
                  onChange={(project, checkout) =>
                    props.onContextChange(use, project, checkout)
                  }
                  onProviderChange={(provider) =>
                    props.onProviderChange(use, provider)
                  }
                />
              </PopoverContent>
            </Popover>
          );
        })}
      </nav>
      <div className="flex h-full shrink-0 items-center gap-0.5 border-l border-border/70 px-2">
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
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="New Git History"
          title="New Git History"
          onClick={() => props.onAddKind("git")}
        >
          <GitBranch />
        </Button>
      </div>
    </header>
  );
}
