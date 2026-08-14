import { useEffect, useRef, useState } from "react";
import {
  Bot,
  FileCode2,
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
import { AgentProviderIcon, SidebarShell, cn } from "@yaade/ui";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverAnchor,
  PopoverContent,
  Separator,
  Spinner,
} from "@yaade/ui/primitives";
import {
  ToolContextControls,
  type AgentProvider,
  type ProviderOption,
} from "./ToolContextControls.js";
import {
  toolUseContextCaption,
  toolUseWorkTitle,
  type RuntimeToolTitle,
} from "./tool-title.js";
import { ShortcutTooltip } from "./ShortcutTooltip.js";
import { toolSessionShortcutFor } from "./tool-session-keymap.js";

function toolStatusClass(status: ToolUse["status"]): string {
  switch (status) {
    case "running":
    case "waiting":
      return "bg-success";
    case "starting":
    case "created":
      return "bg-info";
    case "failed":
    case "cancelled":
    case "disconnected":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/45";
  }
}

const toolIcon: Record<ToolKind, typeof Bot> = {
  agent: Bot,
  editor: FileCode2,
  terminal: TerminalIcon,
  search: Search,
  git: GitBranch,
};

const providerLabels: Record<AgentProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  grok: "Grok",
  pi: "Pi",
};

export type ToolUseNavigationLayout =
  | "tabs"
  | "two-sidebars"
  | "single-sidebar";

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
  readonly onAddAgent: (provider: AgentProvider) => void;
  readonly onAddKind: (kind: ToolKind) => void;
  readonly onClose: (use: ToolUse) => void;
  readonly onRename: (use: ToolUse, title: string) => void;
  readonly onReorder: (ids: readonly ToolUseId[]) => void;
  readonly layout?: ToolUseNavigationLayout;
  readonly collapsed?: boolean;
};

export function ToolUseTabStrip(props: ToolUseTabStripProps) {
  const dragId = useRef<ToolUseId | null>(null);
  const [editingId, setEditingId] = useState<ToolUseId | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [contextPopoverId, setContextPopoverId] = useState<ToolUseId | null>(
    null,
  );
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [providers, setProviders] = useState<readonly ProviderOption[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const layout = props.layout ?? "tabs";
  const isTwoSidebar = layout === "two-sidebars";
  const isSingleSidebar = layout === "single-sidebar";
  const isSidebar = isTwoSidebar || isSingleSidebar;

  useEffect(() => {
    if (!agentMenuOpen) return;
    let cancelled = false;
    setLoadingProviders(true);
    void window.yaade?.agents
      ?.listProviders?.()
      .then((next) => {
        if (!cancelled) setProviders(next ?? []);
      })
      .catch(() => {
        if (!cancelled) setProviders([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingProviders(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentMenuOpen]);

  const finishRename = (use: ToolUse) => {
    const next = draftTitle.trim();
    setEditingId(null);
    if (next && next !== use.title) props.onRename(use, next);
  };

  const renderToolUse = (id: ToolUseId, index: number) => {
    const use = props.usesById.get(id);
    if (!use) return null;
    const Icon = toolIcon[use.kind];
    const active = id === props.activeToolUseId;
    const workTitle = toolUseWorkTitle(use, props.runtimeTitles.get(id));
    const contextCaption = toolUseContextCaption(use);
    const jump = index < 9 ? String(index + 1) : undefined;

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
            data-yaade-tool-index={jump}
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
              if (!active) {
                props.onSelect(use);
                setContextPopoverId(null);
                return;
              }
              setContextPopoverId(id);
            }}
            className={cn(
              "group relative flex shrink-0 items-center outline-none transition-[color,background-color,border-color] duration-[var(--yaade-motion-hot)]",
              isSidebar
                ? "min-h-14 w-full min-w-0 gap-2 rounded-md border border-transparent px-2 py-1.5 focus-within:ring-2 focus-within:ring-sidebar-ring/50 hover:bg-sidebar-accent/70 data-[active=true]:border-sidebar-border data-[active=true]:bg-sidebar-accent max-md:h-full max-md:min-h-0 max-md:w-44"
                : "h-full min-w-36 max-w-64 gap-1 rounded-md border border-transparent px-1.5 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 data-[active=true]:border-border data-[active=true]:bg-background",
            )}
          >
            <span
              className={cn(
                "absolute origin-center rounded-full bg-primary transition-transform duration-[var(--yaade-motion-menu)] ease-[var(--yaade-ease-out)]",
                isSidebar
                  ? "inset-y-2 left-0 w-0.5 scale-y-0 group-data-[active=true]:scale-y-100"
                  : "inset-y-1.5 left-0 w-0.5 scale-y-0 group-data-[active=true]:scale-y-100",
                isSidebar && "bg-sidebar-primary",
              )}
              aria-hidden
            />
            {jump && !isSidebar ? (
              <span
                className="w-3 shrink-0 text-center font-mono text-3xs tabular-nums text-muted-foreground group-data-[active=true]:text-primary"
                aria-hidden
              >
                {jump}
              </span>
            ) : null}
            <span
              className={cn(
                "relative grid size-5 shrink-0 place-items-center text-muted-foreground group-data-[active=true]:text-foreground",
                isSidebar &&
                  "size-6 text-sidebar-foreground/65 group-data-[active=true]:text-sidebar-accent-foreground",
              )}
            >
              <Icon
                className={cn("size-3.5", isSidebar && "size-4")}
                aria-hidden
              />
              <span
                className={cn(
                  "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2",
                  isSidebar ? "ring-sidebar" : "ring-card",
                  toolStatusClass(use.status),
                )}
                aria-hidden
              />
            </span>
            {editingId === id ? (
              <Input
                aria-label={`Rename ${use.title}`}
                className={cn(
                  "h-7 min-w-0 flex-1 border-primary/50 bg-background px-1.5",
                  isSidebar && "border-sidebar-primary/50 bg-sidebar",
                )}
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
                className="min-w-0 flex-1 truncate text-left outline-none"
                onDoubleClick={() => {
                  setDraftTitle(use.title);
                  setEditingId(id);
                }}
              >
                <span
                  className={cn(
                    "block truncate text-xs font-medium text-muted-foreground group-data-[active=true]:text-foreground",
                    isSidebar &&
                      "text-sidebar-foreground/70 group-data-[active=true]:text-sidebar-accent-foreground",
                  )}
                  data-yaade-tool-title
                >
                  {workTitle}
                </span>
                <span
                  className={cn(
                    "block truncate font-mono text-3xs text-muted-foreground",
                    isSidebar && "text-sidebar-foreground/55",
                  )}
                  data-yaade-tool-context
                >
                  {contextCaption}
                </span>
              </button>
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Close ${workTitle}`}
              className={cn(
                "ml-0.5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-data-[active=true]:opacity-70",
                isSidebar && "max-md:opacity-70",
              )}
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
          side={isSingleSidebar ? "right" : isTwoSidebar ? "left" : "top"}
          align="start"
          sideOffset={8}
          className="w-80 max-w-[calc(100vw-1rem)] p-0"
          data-yaade-tool-context-popover
        >
          <div className="border-b border-border px-3 py-2">
            <p className="text-sm font-medium">Project and worktree</p>
            <p className="truncate text-2xs text-muted-foreground">
              This tool only. Other tools keep their own checkout.
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
  };

  const newToolActions = (
    <div
      className={cn(
        "flex h-full shrink-0 items-center gap-0.5 px-1",
        isTwoSidebar && "w-full justify-end px-0",
        isSingleSidebar && "ml-auto px-0",
      )}
      role="toolbar"
      aria-label="New tool"
    >
      <DropdownMenu open={agentMenuOpen} onOpenChange={setAgentMenuOpen}>
        <ShortcutTooltip
          label="New Agent"
          shortcut={toolSessionShortcutFor("tool.newAgent")}
          side={isSingleSidebar ? "bottom" : isTwoSidebar ? "left" : "top"}
        >
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-xs"
              variant="default"
              aria-label="New Agent"
              aria-haspopup="menu"
              data-yaade-new-tool="agent"
            >
              <Bot />
            </Button>
          </DropdownMenuTrigger>
        </ShortcutTooltip>
        <DropdownMenuContent
          align="end"
          side={isSingleSidebar ? "bottom" : isTwoSidebar ? "left" : "top"}
          className="w-56"
          data-yaade-agent-provider-menu
        >
          <DropdownMenuLabel>Choose an agent provider</DropdownMenuLabel>
          {loadingProviders ? (
            <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" aria-hidden />
              Checking available providers…
            </div>
          ) : providers.length > 0 ? (
            providers.map((option) => (
              <DropdownMenuItem
                key={option.provider}
                disabled={!option.available}
                data-yaade-agent-provider={option.provider}
                onSelect={() => props.onAddAgent(option.provider)}
              >
                <AgentProviderIcon agent={option.provider} />
                <span className="min-w-0 flex-1 truncate">
                  {providerLabels[option.provider]}
                </span>
                {!option.available ? (
                  <span className="text-2xs text-muted-foreground">
                    unavailable
                  </span>
                ) : null}
              </DropdownMenuItem>
            ))
          ) : (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              No providers found.
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ShortcutTooltip
        label="New Terminal"
        shortcut={toolSessionShortcutFor("tool.newTerminal")}
        side={isSingleSidebar ? "bottom" : isTwoSidebar ? "left" : "top"}
      >
        <Button
          size="icon-xs"
          variant="secondary"
          aria-label="New Terminal"
          data-yaade-new-tool="terminal"
          onClick={() => props.onAddKind("terminal")}
        >
          <TerminalIcon />
        </Button>
      </ShortcutTooltip>
      <ShortcutTooltip
        label="New Search"
        shortcut={toolSessionShortcutFor("tool.newSearch")}
        side={isSingleSidebar ? "bottom" : isTwoSidebar ? "left" : "top"}
      >
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="New Search"
          data-yaade-new-tool="search"
          onClick={() => props.onAddKind("search")}
        >
          <Search />
        </Button>
      </ShortcutTooltip>
      <ShortcutTooltip
        label="New Editor"
        shortcut={toolSessionShortcutFor("tool.newEditor")}
        side={isSingleSidebar ? "bottom" : isTwoSidebar ? "left" : "top"}
      >
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="New Editor"
          data-yaade-new-tool="editor"
          onClick={() => props.onAddKind("editor")}
        >
          <FileCode2 />
        </Button>
      </ShortcutTooltip>
      <ShortcutTooltip
        label="New Git History"
        shortcut={toolSessionShortcutFor("tool.newGit")}
        side={isSingleSidebar ? "bottom" : isTwoSidebar ? "left" : "top"}
      >
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="New Git History"
          data-yaade-new-tool="git"
          onClick={() => props.onAddKind("git")}
        >
          <GitBranch />
        </Button>
      </ShortcutTooltip>
    </div>
  );

  const toolItems = props.useIds.map(renderToolUse);

  if (isTwoSidebar) {
    return (
      <SidebarShell
        aria-label="Tool uses"
        contentAs="nav"
        contentProps={{
          "aria-label": "Tool uses",
          "aria-orientation": "vertical",
          role: "tablist",
        }}
        contentClassName="flex flex-col gap-1 p-2 max-md:flex-row max-md:gap-1 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:p-1"
        footerClassName="border-sidebar-border p-2 max-md:h-full max-md:w-auto max-md:border-t-0 max-md:border-l max-md:p-1"
        className={cn(
          "w-72 border-r-0 border-l border-sidebar-border bg-sidebar text-sidebar-foreground",
          !props.collapsed &&
            "max-md:h-12 max-md:w-full max-md:flex-row max-md:border-l-0 max-md:border-t",
          props.collapsed && "hidden",
        )}
        dataAttributes={{
          "data-yaade-tool-sidebar": "",
          "data-yaade-sidebar-state": props.collapsed ? "collapsed" : "expanded",
          // Keep the navigation hook stable for existing integrations.
          "data-yaade-tool-tabs": "",
        }}
        footer={newToolActions}
      >
        {toolItems}
      </SidebarShell>
    );
  }

  if (isSingleSidebar) {
    return (
      <section
        className={cn(
          "flex min-h-0 flex-[3_1_0%] flex-col bg-sidebar text-sidebar-foreground",
          props.collapsed && "hidden",
          "max-md:h-12 max-md:flex-none max-md:flex-row",
        )}
        aria-label="Tool uses"
        data-yaade-tool-sidebar=""
        data-yaade-sidebar-state={props.collapsed ? "collapsed" : "expanded"}
        data-yaade-tool-tabs=""
      >
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-sidebar-border px-3 max-md:h-full max-md:w-auto max-md:border-r max-md:border-b-0 max-md:px-2">
          <span className="text-3xs font-bold uppercase tracking-[0.1em] text-sidebar-foreground/60">
            Tool uses
          </span>
          {newToolActions}
        </div>
        <nav
          className="min-h-0 flex-1 overflow-auto p-2 max-md:flex max-md:gap-1 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:p-1"
          aria-label="Tool uses"
          aria-orientation="vertical"
          role="tablist"
        >
          {toolItems}
        </nav>
      </section>
    );
  }

  return (
    <footer
      className="flex h-12 shrink-0 items-center border-t border-border bg-card"
      data-yaade-tool-tabs
    >
      <nav
        className="flex h-full min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto px-1 py-1"
        aria-label="Tool uses"
        role="tablist"
      >
        {toolItems}
      </nav>
      <Separator orientation="vertical" className="h-7" />
      {newToolActions}
    </footer>
  );
}
