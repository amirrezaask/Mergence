import { Suspense, lazy, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
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
import { ExistingWorktreeCheckout, MainCheckout } from "@yaade/rpc";
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
  type ToolContextSelection,
} from "./ToolContextControls.js";
import {
  toolUseContextCaption,
  toolUseWorkTitle,
  type RuntimeToolTitle,
} from "./tool-title.js";
import { ShortcutTooltip } from "./ShortcutTooltip.js";
import { toolSessionShortcutFor } from "./tool-session-keymap.js";

const DockSourceHandle = lazy(() => import("./ToolDockSourceHandle.js"));

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

function checkoutTargetForUse(use: ToolUse): CheckoutTarget {
  if (use.context.checkoutKey === "main") {
    return MainCheckout.make({ kind: "main" });
  }
  return ExistingWorktreeCheckout.make({
    kind: "existing-worktree",
    path: use.context.checkoutPath,
    ...(use.context.branch ? { branch: use.context.branch } : {}),
  });
}

function toolKindLabel(kind: ToolKind): string {
  switch (kind) {
    case "agent":
      return "Agent";
    case "terminal":
      return "Terminal";
    case "search":
      return "Search";
    case "editor":
      return "Editor";
    case "git":
      return "Git";
  }
}

export type ToolUseNavigationLayout =
  | "tabs"
  | "two-sidebars"
  | "single-sidebar";

export type ToolUseTabStripProps = {
  readonly useIds: readonly ToolUseId[];
  readonly usesById: ReadonlyMap<ToolUseId, ToolUse>;
  readonly activeToolUseId?: ToolUseId;
  readonly openToolUseIds?: ReadonlySet<ToolUseId>;
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
  readonly onAddWithContext: (
    kind: ToolKind,
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => void;
  readonly onClose: (use: ToolUse) => void;
  readonly onRename: (use: ToolUse, title: string) => void;
  readonly onReorder: (ids: readonly ToolUseId[]) => void;
  readonly dockable?: boolean;
  readonly layout?: ToolUseNavigationLayout;
  readonly collapsed?: boolean;
  readonly sidebarOrientation?: "horizontal" | "vertical";
};

export function ToolUseTabStrip(props: ToolUseTabStripProps) {
  const dragId = useRef<ToolUseId | null>(null);
  const [editingId, setEditingId] = useState<ToolUseId | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [contextPopoverId, setContextPopoverId] = useState<ToolUseId | null>(
    null,
  );
  const [launchPopoverKind, setLaunchPopoverKind] = useState<ToolKind | null>(
    null,
  );
  const [launchContext, setLaunchContext] =
    useState<ToolContextSelection | null>(null);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [providers, setProviders] = useState<readonly ProviderOption[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const layout = props.layout ?? "tabs";
  const isTwoSidebar = layout === "two-sidebars";
  const isSingleSidebar = layout === "single-sidebar";
  const isSidebar = isTwoSidebar || isSingleSidebar;

  useEffect(() => {
    if (!props.collapsed) return;
    setContextPopoverId(null);
    setLaunchPopoverKind(null);
    setLaunchContext(null);
    setAgentMenuOpen(false);
  }, [props.collapsed]);

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

  const openLaunchPopover = (kind: ToolKind) => {
    setContextPopoverId(null);
    setAgentMenuOpen(false);
    const activeUse = props.activeToolUseId
      ? props.usesById.get(props.activeToolUseId)
      : undefined;
    const project = activeUse?.context.project ?? props.projects[0];
    setLaunchPopoverKind(kind);
    setLaunchContext(
      project
        ? {
            project,
            checkout: activeUse
              ? checkoutTargetForUse(activeUse)
              : MainCheckout.make({ kind: "main" }),
          }
        : null,
    );
  };

  useEffect(() => {
    if (!launchPopoverKind || launchContext || props.projects.length === 0)
      return;
    const firstProject = props.projects[0];
    if (!firstProject) return;
    setLaunchContext({
      project: firstProject,
      checkout: MainCheckout.make({ kind: "main" }),
    });
  }, [launchContext, launchPopoverKind, props.projects]);

  const renderToolUse = (id: ToolUseId, index: number) => {
    const use = props.usesById.get(id);
    if (!use) return null;
    const Icon = toolIcon[use.kind];
    const active = id === props.activeToolUseId;
    const openInWorkspace = props.openToolUseIds?.has(id) ?? active;
    const workTitle = toolUseWorkTitle(use, props.runtimeTitles.get(id));
    const contextCaption = toolUseContextCaption(use);
    const jump = index < 9 ? String(index + 1) : undefined;

    return (
      <Popover
        key={id}
        open={!props.collapsed && contextPopoverId === id}
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
            data-open-in-workspace={openInWorkspace ? "true" : undefined}
            data-yaade-tool-use={id}
            data-yaade-tool-index={jump}
            draggable={!props.dockable && editingId !== id}
            onDragStart={() => {
              if (!props.dockable) dragId.current = id;
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
              setLaunchPopoverKind(null);
              setLaunchContext(null);
              if (!active || !openInWorkspace) {
                props.onSelect(use);
                setContextPopoverId(null);
                return;
              }
              setContextPopoverId(id);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
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
                className={cn("size-3.5", isSidebar && "size-5")}
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
                draggable={props.dockable && editingId !== id}
                className="min-w-0 flex-1 truncate text-left outline-none"
                onDragStart={() => {
                  if (props.dockable) dragId.current = id;
                }}
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
            {props.dockable ? (
              <Suspense fallback={null}>
                <DockSourceHandle
                  tabId={id}
                  label={workTitle}
                  className={cn(isSidebar && "max-md:opacity-70")}
                />
              </Suspense>
            ) : null}
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
          <div className="border-t border-border p-3">
            <Button
              className="w-full"
              aria-label="Open tool use with selected context"
              onClick={() => {
                props.onSelect(use);
                setContextPopoverId(null);
              }}
              data-yaade-open-tool-use={id}
            >
              <ArrowRight data-icon="inline-start" />
              Open tool use
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    );
  };

  const launchSide = isSingleSidebar ? "bottom" : isTwoSidebar ? "left" : "top";
  const renderLaunchPopover = (kind: ToolKind) => {
    const label = toolKindLabel(kind);
    return (
      <PopoverContent
        side={launchSide}
        align="end"
        sideOffset={8}
        className="w-80 max-w-[calc(100vw-1rem)] p-0"
        data-yaade-tool-context-popover
        data-yaade-tool-launch-popover={kind}
      >
        <div className="border-b border-border px-3 py-2">
          <p className="text-sm font-medium">Open {label}</p>
          <p className="truncate text-2xs text-muted-foreground">
            Choose the project and worktree for this tool.
          </p>
        </div>
        {launchContext ? (
          <ToolContextControls
            key={`launch-context-${kind}`}
            initialContext={launchContext}
            projects={props.projects}
            presentation="popover"
            onChange={async (project, checkout) => {
              setLaunchContext({ project, checkout });
            }}
          />
        ) : (
          <p className="p-3 text-xs text-muted-foreground">
            No known projects yet.
          </p>
        )}
        <div className="border-t border-border p-3">
          <Button
            className="w-full"
            aria-label={`Open ${label} with selected context`}
            disabled={!launchContext}
            onClick={() => {
              if (!launchContext) return;
              const next = launchContext;
              setLaunchPopoverKind(null);
              setLaunchContext(null);
              props.onAddWithContext(kind, next.project, next.checkout);
            }}
            data-yaade-open-tool-with-context={kind}
          >
            <ArrowRight data-icon="inline-start" />
            Open {label}
          </Button>
        </div>
      </PopoverContent>
    );
  };

  const contextLaunchKinds: readonly ToolKind[] = [
    "terminal",
    "search",
    "editor",
    "git",
  ];

  const newToolActions = (
    <div
      className={cn(
        "flex h-full shrink-0 items-center gap-0.5 px-1",
        isTwoSidebar && "w-full justify-end px-0",
        isSingleSidebar && "flex-1 px-0",
      )}
      role="toolbar"
      aria-label="New tool"
    >
      {!isSingleSidebar ? (
        <Popover
          open={!props.collapsed && launchPopoverKind === "agent"}
          onOpenChange={(open) => {
            if (!open && launchPopoverKind === "agent") {
              setLaunchPopoverKind(null);
              setLaunchContext(null);
            }
          }}
        >
          <PopoverAnchor asChild>
            <span className="inline-flex">
              <DropdownMenu
                open={!props.collapsed && agentMenuOpen}
                onOpenChange={setAgentMenuOpen}
              >
                <ShortcutTooltip
                  label="New Agent"
                  shortcut={toolSessionShortcutFor("tool.newAgent")}
                  side={launchSide}
                >
                  <DropdownMenuTrigger asChild>
                    <Button
                      size={isSidebar ? "icon-lg" : "icon-xs"}
                      variant="ghost"
                      className={cn(
                        isSingleSidebar && "flex-1",
                        isSidebar && "[&_svg]:size-5",
                      )}
                      aria-label="New Agent"
                      aria-haspopup="menu"
                      data-yaade-new-tool="agent"
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        openLaunchPopover("agent");
                      }}
                    >
                      <Bot />
                    </Button>
                  </DropdownMenuTrigger>
                </ShortcutTooltip>
                <DropdownMenuContent
                  align="end"
                  side={launchSide}
                  className="w-56"
                  data-yaade-agent-provider-menu
                >
                  <DropdownMenuLabel>
                    Choose an agent provider
                  </DropdownMenuLabel>
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
            </span>
          </PopoverAnchor>
          {renderLaunchPopover("agent")}
        </Popover>
      ) : null}

      {contextLaunchKinds.map((kind) => {
        const Icon = toolIcon[kind];
        const label = `New ${toolKindLabel(kind)}`;
        const shortcut = toolSessionShortcutFor(
          kind === "terminal"
            ? "tool.newTerminal"
            : kind === "search"
              ? "tool.newSearch"
              : kind === "editor"
                ? "tool.newEditor"
                : "tool.newGit",
        );
        return (
          <Popover
            key={kind}
            open={!props.collapsed && launchPopoverKind === kind}
            onOpenChange={(open) => {
              if (!open && launchPopoverKind === kind) {
                setLaunchPopoverKind(null);
                setLaunchContext(null);
              }
            }}
          >
            <PopoverAnchor asChild>
              <span className={cn("inline-flex", isSingleSidebar && "flex-1")}>
                <ShortcutTooltip
                  label={label}
                  shortcut={shortcut}
                  side={launchSide}
                >
                  <Button
                    size={isSidebar ? "icon-lg" : "icon-xs"}
                    variant="ghost"
                    className={cn(
                      isSingleSidebar && "flex-1",
                      isSidebar && "[&_svg]:size-5",
                    )}
                    aria-label={label}
                    data-yaade-new-tool={kind}
                    onClick={() => {
                      setLaunchPopoverKind(null);
                      setLaunchContext(null);
                      props.onAddKind(kind);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openLaunchPopover(kind);
                    }}
                  >
                    <Icon />
                  </Button>
                </ShortcutTooltip>
              </span>
            </PopoverAnchor>
            {renderLaunchPopover(kind)}
          </Popover>
        );
      })}
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
          "aria-orientation": props.sidebarOrientation ?? "vertical",
          role: "tablist",
        }}
        contentClassName="flex flex-col gap-1 p-2 max-md:flex-row max-md:gap-1 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:p-1"
        footerClassName="border-sidebar-border p-2 max-md:h-full max-md:w-auto max-md:border-t-0 max-md:border-l max-md:p-1"
        className={cn(
          "w-full border-r-0 border-l border-sidebar-border bg-sidebar text-sidebar-foreground",
          !props.collapsed &&
            "max-md:h-12 max-md:w-full max-md:flex-row max-md:border-l-0 max-md:border-t",
          props.collapsed && "hidden",
        )}
        dataAttributes={{
          "data-yaade-tool-sidebar": "",
          "data-yaade-sidebar-state": props.collapsed
            ? "collapsed"
            : "expanded",
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
          "flex min-h-0 w-full flex-[3_1_0%] flex-col bg-sidebar text-sidebar-foreground",
          props.collapsed && "hidden",
          "max-md:h-12 max-md:flex-none max-md:flex-row",
        )}
        aria-label="Tool uses"
        data-yaade-tool-sidebar=""
        data-yaade-sidebar-state={props.collapsed ? "collapsed" : "expanded"}
        data-yaade-tool-tabs=""
      >
        <div className="flex h-9 shrink-0 items-center border-b border-sidebar-border px-3 max-md:h-full max-md:w-auto max-md:border-r max-md:border-b-0 max-md:px-2">
          {newToolActions}
        </div>
        <nav
          className="min-h-0 flex-1 overflow-auto p-2 max-md:flex max-md:gap-1 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:p-1"
          aria-label="Tool uses"
          aria-orientation={props.sidebarOrientation ?? "vertical"}
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
