import {
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { AnimatePresence } from "motion/react";
import { div as MotionDiv } from "motion/react-m";
import {
  ArrowRight,
  GitBranch,
  PanelLeftClose,
  PanelRightClose,
  Plus,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import type {
  CheckoutTarget,
  ProjectTarget,
  SessionId,
  ToolKind,
  ToolUse,
  ToolUseId,
} from "@yaade/rpc";
import { ExistingWorktreeCheckout, MainCheckout } from "@yaade/rpc";
import {
  AgentProviderIcon,
  SidebarShell,
  cn,
  yaadeMotion,
} from "@yaade/ui/session";
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
} from "@yaade/ui/primitives";
import {
  ToolContextControls,
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

const toolIcon = {
  terminal: TerminalIcon,
  git: GitBranch,
} satisfies Record<ToolKind, typeof TerminalIcon>;

function checkoutTargetForUse(use: ToolUse): CheckoutTarget {
  if (use.context.checkoutKey === "main") {
    return MainCheckout.make({ kind: "main" });
  }
  if (use.context.branch) {
    return ExistingWorktreeCheckout.make({
      kind: "existing-worktree",
      path: use.context.checkoutPath,
      branch: use.context.branch,
    });
  }
  return ExistingWorktreeCheckout.make({
    kind: "existing-worktree",
    path: use.context.checkoutPath,
  });
}

function handleToolTabKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (
    !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(
      event.key,
    )
  ) {
    return;
  }
  const tabs = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
  ];
  if (tabs.length === 0) return;
  const activeElement = document.activeElement;
  const current = Math.max(
    0,
    activeElement instanceof HTMLElement ? tabs.indexOf(activeElement) : -1,
  );
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (current +
            (event.key === "ArrowRight" || event.key === "ArrowDown"
              ? 1
              : -1) +
            tabs.length) %
          tabs.length;
  event.preventDefault();
  tabs[next]?.focus();
  tabs[next]?.click();
}

function toolKindLabel(kind: ToolKind): string {
  return kind === "terminal" ? "Terminal" : "Git";
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
  readonly agentProvidersByToolUseId: ReadonlyMap<string, string>;
  readonly projects: readonly ProjectTarget[];
  readonly onAddProject: (rootPath: string) => Promise<ProjectTarget | undefined>;
  readonly onSelect: (use: ToolUse) => void;
  readonly onContextChange: (
    use: ToolUse,
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>;
  readonly onAddKind: (kind: ToolKind) => void;
  readonly onAddWithContext: (
    kind: ToolKind,
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => void;
  readonly onClose: (use: ToolUse) => void;
  readonly onRename: (use: ToolUse, title: string) => void;
  readonly onReorder: (ids: readonly ToolUseId[]) => void;
  readonly onToggleSidebar?: () => void;
  readonly sectionLabel?: string;
  readonly emptyLabel?: string;
  readonly sessionTitlesById?: ReadonlyMap<SessionId, string>;
  readonly dockable?: boolean;
  readonly dockableUseIds?: ReadonlySet<ToolUseId>;
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
  const [quickMenuOpen, setQuickMenuOpen] = useState(false);
  const layout = props.layout ?? "tabs";
  const compactTabs = layout === "tabs";
  const isTwoSidebar = layout === "two-sidebars";
  const isSingleSidebar = layout === "single-sidebar";
  const isSidebar = isTwoSidebar || isSingleSidebar;

  useEffect(() => {
    if (!props.collapsed) return;
    setContextPopoverId(null);
    setLaunchPopoverKind(null);
    setLaunchContext(null);
  }, [props.collapsed]);

  const finishRename = (use: ToolUse) => {
    const next = draftTitle.trim();
    setEditingId(null);
    if (next && next !== use.title) props.onRename(use, next);
  };

  const openLaunchPopover = (kind: ToolKind) => {
    setContextPopoverId(null);
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
    const terminalProvider =
      use.kind === "terminal"
        ? props.agentProvidersByToolUseId.get(id) ?? "terminal"
        : undefined;
    const active = id === props.activeToolUseId;
    const openInWorkspace = props.openToolUseIds?.has(id) ?? active;
    const dockable =
      Boolean(props.dockable) &&
      (!props.dockableUseIds || props.dockableUseIds.has(id));
    const workTitle = toolUseWorkTitle(use, props.runtimeTitles.get(id));
    const contextCaption = toolUseContextCaption(use);
    const sessionTitle = props.sessionTitlesById?.get(use.sessionId);
    const secondaryCaption = sessionTitle
      ? `${sessionTitle} · ${contextCaption}`
      : contextCaption;
    const jump = index < 9 ? String(index + 1) : undefined;

    return (
      <MotionDiv
        key={id}
        layout
        initial={{ opacity: 0, scale: 0.97, y: 4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: -4 }}
        transition={{
          layout: yaadeMotion.layoutTransition,
          default: yaadeMotion.layoutTransition,
        }}
        className={cn(
          "min-w-0 shrink-0",
          isSidebar ? "w-full max-md:w-44" : "h-full",
        )}
      >
      <Popover
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
            data-yaade-tool-pane-tab=""
            data-yaade-tool-index={jump}
            draggable={!dockable && !props.dockable && editingId !== id}
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
              props.onSelect(use);
              setContextPopoverId(null);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setContextPopoverId(id);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              if (editingId === id) return;
              event.preventDefault();
              setLaunchPopoverKind(null);
              setLaunchContext(null);
              props.onSelect(use);
              setContextPopoverId(null);
            }}
            className={cn(
              "group relative flex shrink-0 cursor-pointer items-center outline-none transition-[color,background-color,border-color] duration-[var(--yaade-motion-hot)]",
              isSidebar
                ? "min-h-14 w-full min-w-0 gap-2 rounded-md border border-transparent px-2 py-1.5 hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 data-[active=true]:border-sidebar-border data-[active=true]:bg-sidebar-accent max-md:h-full max-md:min-h-0 max-md:w-44"
                : cn(
                    "h-full min-w-28 max-w-56 gap-1 rounded-none border border-transparent px-1.5 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 data-[active=true]:border-border/80 data-[active=true]:bg-secondary/70 data-[active=true]:shadow-sm",
                    compactTabs && "min-w-28",
                  ),
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
            {jump && !isSidebar && !compactTabs ? (
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
              {terminalProvider ? (
                <AgentProviderIcon
                  agent={terminalProvider}
                  className={cn("size-3.5", isSidebar && "size-5")}
                />
              ) : (
                <Icon
                  className={cn("size-3.5", isSidebar && "size-5")}
                  aria-hidden
                />
              )}
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
                role="tab"
                draggable={dockable && editingId !== id}
                className="min-w-0 flex-1 truncate text-left outline-none"
                onDragStart={() => {
                  if (dockable) dragId.current = id;
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
                {!compactTabs ? (
                  <span
                    className={cn(
                      "block truncate font-mono text-3xs text-muted-foreground",
                      isSidebar && "text-sidebar-foreground/55",
                    )}
                    data-yaade-tool-context
                  >
                    {secondaryCaption}
                  </span>
                ) : null}
              </button>
            )}
            {dockable ? (
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
            onAddProject={props.onAddProject}
            active={active}
            presentation="popover"
            onChange={(project, checkout) =>
              props.onContextChange(use, project, checkout)
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
      </MotionDiv>
    );
  };

  const launchSide = compactTabs
    ? "bottom"
    : isSingleSidebar
      ? "bottom"
      : isTwoSidebar
        ? "left"
        : "top";
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
            onAddProject={props.onAddProject}
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

  const contextLaunchKinds: readonly ToolKind[] = ["terminal", "git"];

  const newToolActions = (
    <div
      className={cn(
        "flex h-full shrink-0 items-center gap-0.5 px-1",
        isTwoSidebar && "w-full justify-end px-0",
        isSingleSidebar && "flex-1 px-0",
      )}
      role="toolbar"
      aria-label={props.sectionLabel ? `${props.sectionLabel} actions` : "New tool"}
    >
      {contextLaunchKinds.map((kind) => {
        const Icon = toolIcon[kind];
        const label = `New ${toolKindLabel(kind)}`;
        const shortcut = toolSessionShortcutFor(
          kind === "terminal" ? "tool.newTerminal" : "tool.newGit",
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
      {isSidebar && props.onToggleSidebar ? (
        <>
          <Separator orientation="vertical" className="mx-0.5 h-6" />
          <ShortcutTooltip
            label="Hide sidebars"
            shortcut={toolSessionShortcutFor("sidebar.toggle")}
            side={launchSide}
          >
            <Button
              size="icon-lg"
              variant="ghost"
              className="[&_svg]:size-5"
              aria-label="Hide sidebars"
              data-yaade-sidebar-toolbar-toggle
              onClick={props.onToggleSidebar}
            >
              {isTwoSidebar ? <PanelRightClose /> : <PanelLeftClose />}
            </Button>
          </ShortcutTooltip>
        </>
      ) : null}
    </div>
  );

  const toolItems = props.useIds.map(renderToolUse);
  const animatedToolItems = (
    <AnimatePresence initial={false} mode="popLayout">
      {toolItems}
    </AnimatePresence>
  );
  const compactNewToolMenu = (
    <DropdownMenu
      open={quickMenuOpen}
      onOpenChange={setQuickMenuOpen}
    >
      <ShortcutTooltip
        label="New tool"
        shortcut={toolSessionShortcutFor("tool.newTerminal")}
        side="bottom"
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="New tool"
            data-yaade-new-tool-menu=""
            className="size-8 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
          >
            <Plus />
          </Button>
        </DropdownMenuTrigger>
      </ShortcutTooltip>
      <DropdownMenuContent
        align="end"
        side="bottom"
        className="w-52"
        data-yaade-new-tool-menu-content=""
      >
        <DropdownMenuLabel>New tool</DropdownMenuLabel>
        {contextLaunchKinds.map(kind => {
          const Icon = toolIcon[kind]
          return (
            <DropdownMenuItem
              key={kind}
              data-yaade-new-tool-kind={kind}
              onSelect={() => {
                setQuickMenuOpen(false)
                props.onAddKind(kind)
              }}
            >
              <Icon />
              <span>{toolKindLabel(kind)}</span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  if (compactTabs) {
    return (
      <div
        className="flex h-full min-w-0 flex-1 items-center"
        data-yaade-tool-tabs
        data-yaade-tool-tabs-layout="header"
      >
        <nav
          className="flex h-full min-w-0 flex-1 items-center gap-0 overflow-x-auto px-0"
          aria-label="Tool uses"
          role="tablist"
          onKeyDown={handleToolTabKeyDown}
        >
          {animatedToolItems}
        </nav>
        <Separator orientation="vertical" className="mx-1 h-6 shrink-0" />
        <div className="flex h-full shrink-0 items-center px-1">
          {compactNewToolMenu}
        </div>
      </div>
    )
  }

  if (isTwoSidebar) {
    return (
      <MotionDiv
        initial={false}
        animate={{ opacity: props.collapsed ? 0 : 1, x: props.collapsed ? 12 : 0 }}
        transition={yaadeMotion.sidebarTransition}
        className={cn(
          "h-full min-w-0 overflow-hidden",
          props.collapsed && "pointer-events-none max-md:hidden",
        )}
        aria-hidden={props.collapsed || undefined}
        inert={props.collapsed || undefined}
      >
      <SidebarShell
        aria-label={props.sectionLabel ?? "Tool uses"}
        contentAs="nav"
        contentProps={{
          "aria-label": props.sectionLabel ?? "Tool uses",
          "aria-orientation": props.sidebarOrientation ?? "vertical",
          role: "tablist",
          onKeyDown: handleToolTabKeyDown,
        }}
        contentClassName="flex flex-col gap-1 p-2 max-md:flex-row max-md:gap-1 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:p-1"
        footerClassName="border-sidebar-border p-2 max-md:h-full max-md:w-auto max-md:border-t-0 max-md:border-l max-md:p-1"
        className={cn(
          "w-full border-r-0 border-l border-sidebar-border bg-sidebar text-sidebar-foreground",
          !props.collapsed &&
            "max-md:h-12 max-md:w-full max-md:flex-row max-md:border-l-0 max-md:border-t",
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
        {toolItems.length > 0 ? (
          animatedToolItems
        ) : (
          <p className="px-2 py-3 text-xs text-sidebar-foreground/50">
            {props.emptyLabel ?? "No tools yet"}
          </p>
        )}
      </SidebarShell>
      </MotionDiv>
    );
  }

  if (isSingleSidebar) {
    return (
      <section
        className={cn(
          "flex min-h-0 w-full flex-[3_1_0%] flex-col border-t border-sidebar-border bg-sidebar text-sidebar-foreground",
          props.collapsed && "hidden",
          "max-md:h-12 max-md:flex-none max-md:flex-row",
        )}
        aria-label={props.sectionLabel ?? "Tool uses"}
        data-yaade-tool-sidebar=""
        data-yaade-sidebar-state={props.collapsed ? "collapsed" : "expanded"}
        data-yaade-tool-tabs=""
      >
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-sidebar-border px-3 max-md:h-full max-md:w-auto max-md:border-r max-md:border-b-0 max-md:px-2">
          <span className="shrink-0 text-3xs font-bold uppercase tracking-[0.1em] text-sidebar-foreground/60">
            {props.sectionLabel ?? "Tools"}
          </span>
          <div className="ml-auto flex min-w-0 items-center">
            {newToolActions}
          </div>
        </div>
        <nav
          className="min-h-0 flex-1 overflow-auto p-2 max-md:flex max-md:gap-1 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:p-1"
          aria-label={props.sectionLabel ?? "Tool uses"}
          aria-orientation={props.sidebarOrientation ?? "vertical"}
          role="tablist"
          onKeyDown={handleToolTabKeyDown}
        >
          {toolItems.length > 0 ? (
            animatedToolItems
          ) : (
            <p className="px-2 py-3 text-xs text-sidebar-foreground/50">
              {props.emptyLabel ?? "No tools yet"}
            </p>
          )}
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
        className="flex h-full min-w-0 flex-1 items-stretch gap-0 overflow-x-auto px-0 py-0.5"
        aria-label="Tool uses"
        role="tablist"
        onKeyDown={handleToolTabKeyDown}
      >
        {animatedToolItems}
      </nav>
      <Separator orientation="vertical" className="h-7" />
      {newToolActions}
    </footer>
  );
}
