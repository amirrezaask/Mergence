import {
  useCallback,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { AnimatePresence } from "motion/react";
import { div as MotionDiv, span as MotionSpan } from "motion/react-m";
import {
  FileCode2,
  GitBranch,
  PanelTopOpen,
  Plus,
  Search,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import type { PanelEvent } from "@yaade/panels";
import type {
  CheckoutTarget,
  ProjectTarget,
  ToolKind,
  ToolUse,
  ToolUseId,
} from "@yaade/rpc";
import type { PanelId } from "@yaade/shared";
import {
  DockTabBarDropTarget,
  DockTabHandle,
  KeyBindingKbd,
  MuxPaneChrome,
  PanelDock,
  type PanelSlotMeta,
  type TabDndHandlers,
} from "@yaade/ui";
import { cn, yaadeMotion } from "@yaade/ui";
import {
  Button,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@yaade/ui/primitives";
import type { RuntimeToolTitle } from "./tool-title.js";
import { toolUseWorkTitle } from "./tool-title.js";
import { toolSessionShortcutFor } from "./tool-session-keymap.js";
import {
  ToolContextControls,
  type AgentProvider,
} from "./ToolContextControls.js";
import type { ToolPaneView, ToolWorkspace } from "./tool-tiling.js";
import { toolIdsInWorkspace } from "./tool-tiling.js";

export type ToolTilingWorkspaceProps = {
  readonly workspace: ToolWorkspace;
  readonly usesById: ReadonlyMap<ToolUseId, ToolUse>;
  readonly runtimeTitles: ReadonlyMap<ToolUseId, RuntimeToolTitle>;
  readonly projects: readonly ProjectTarget[];
  readonly tabDnd: TabDndHandlers;
  readonly empty: ReactNode;
  readonly onPanelEvent: (event: PanelEvent) => void;
  readonly onFocusPanel: (panelId: PanelId, use?: ToolUse) => void;
  readonly onActivateTab: (
    panelId: PanelId,
    toolUseId: ToolUseId,
    use?: ToolUse,
  ) => void;
  readonly onCloseTab: (panelId: PanelId, toolUseId: ToolUseId) => void;
  readonly onAddTool: (panelId: PanelId, kind: ToolKind) => void;
  readonly onContextChange: (
    use: ToolUse,
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>;
  readonly onProviderChange: (
    use: ToolUse,
    provider: AgentProvider,
  ) => Promise<void>;
  readonly onSplit: (panelId: PanelId, edge: "right" | "bottom") => void;
  readonly onCloseView: (panelId: PanelId) => void;
  readonly renderTool: (use: ToolUse, focused: boolean) => ReactNode;
};

function EmptyTile(props: {
  readonly onAddKind: (kind: ToolKind) => void;
}) {
  return (
    <div
      className="flex h-full min-h-40 flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground"
      data-yaade-empty-tool-tile=""
    >
      <PanelTopOpen className="size-5" aria-hidden />
      <p className="text-xs font-medium text-foreground">Open a tool here</p>
      <p className="max-w-56 text-2xs leading-relaxed">
        Pick a tool for this pane, or drag one onto it.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {paneToolKinds.map((item) => {
          const Icon = item.icon;
          return (
            <Button
              key={item.kind}
              type="button"
              variant="outline"
              size="sm"
              data-yaade-empty-tile-tool={item.kind}
              onClick={() => props.onAddKind(item.kind)}
            >
              <Icon data-icon="inline-start" />
              {item.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

const paneToolKinds: readonly {
  kind: Exclude<ToolKind, "agent">;
  label: string;
  icon: typeof TerminalIcon;
  command: string;
}[] = [
  {
    kind: "terminal",
    label: "Terminal",
    icon: TerminalIcon,
    command: "tool.newTerminal",
  },
  { kind: "git", label: "Git", icon: GitBranch, command: "tool.newGit" },
  {
    kind: "editor",
    label: "Editor",
    icon: FileCode2,
    command: "tool.newEditor",
  },
  {
    kind: "search",
    label: "Search",
    icon: Search,
    command: "tool.newSearch",
  },
];

function PaneNewToolMenu(props: {
  readonly panelId: PanelId;
  readonly onAddTool: (panelId: PanelId, kind: ToolKind) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="New tool"
          title="New tool"
          data-yaade-pane-new-tool=""
        >
          <Plus />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-48 p-1.5"
        data-yaade-pane-tool-menu=""
      >
        <p className="px-2 py-1 text-3xs font-bold uppercase tracking-[0.1em] text-muted-foreground">
          New tool
        </p>
        {paneToolKinds.map((item) => {
          const Icon = item.icon;
          const shortcut = toolSessionShortcutFor(item.command);
          return (
            <Button
              key={item.kind}
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              data-yaade-pane-new-tool-kind={item.kind}
              onClick={() => {
                setOpen(false);
                props.onAddTool(props.panelId, item.kind);
              }}
            >
              <Icon data-icon="inline-start" />
              <span className="flex-1 text-left">{item.label}</span>
              {shortcut ? <KeyBindingKbd binding={shortcut} /> : null}
            </Button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

function statusClass(status: ToolUse["status"]): string {
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

function ToolPaneTab(props: {
  readonly panelId: PanelId;
  readonly use: ToolUse;
  readonly title: string;
  readonly active: boolean;
  readonly focused: boolean;
  readonly projects: readonly ProjectTarget[];
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onContextChange: (
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>;
  readonly onProviderChange: (provider: AgentProvider) => Promise<void>;
}) {
  const [contextOpen, setContextOpen] = useState(false);
  return (
    <Popover open={contextOpen} onOpenChange={setContextOpen}>
      <PopoverAnchor asChild>
        <div
          className={cn(
            "group/tool-pane-tab relative flex h-full max-w-44 min-w-20 shrink-0 cursor-pointer items-stretch rounded-sm border",
            props.active
              ? "border-border/60 bg-muted/70 text-foreground"
              : "border-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground",
          )}
          data-yaade-tool-pane-tab={props.use.id}
          data-active={props.active ? "" : undefined}
          onMouseDown={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              props.onClose();
              return;
            }
            if (event.button !== 0) return;
            if ((event.target as HTMLElement).closest("button[aria-label^='Close ']")) {
              return;
            }
            props.onActivate();
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            props.onActivate();
            setContextOpen(true);
          }}
        >
          {props.active && props.focused ? (
            <MotionSpan
              layoutId={`yaade-pane-tab-indicator-${props.panelId.id}`}
              data-yaade-pane-tab-indicator=""
              className="pointer-events-none absolute inset-x-1.5 top-0 h-px bg-primary"
              transition={yaadeMotion.layoutTransition}
              aria-hidden
            />
          ) : null}
          <DockTabHandle
            panelId={props.panelId}
            tabId={props.use.id}
            label={props.title}
            active={props.active}
            className="flex min-w-0 flex-1 cursor-grab items-center gap-1 px-1.5 text-left text-3xs font-medium outline-none touch-none active:cursor-grabbing focus-visible:underline focus-visible:underline-offset-2"
            onActivate={props.onActivate}
          >
            <span
              data-yaade-pane-tab-status=""
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                statusClass(props.use.status),
              )}
              aria-hidden
            />
            <span className="min-w-0 truncate">{props.title}</span>
          </DockTabHandle>
          <button
            type="button"
            aria-label={`Close ${props.title}`}
            className="mr-1 inline-flex size-4 shrink-0 self-center items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover/tool-pane-tab:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              props.onClose();
            }}
          >
            <X className="size-2.5" />
          </button>
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        className="w-80 max-w-[calc(100vw-1rem)] p-0"
        data-yaade-tool-context-popover=""
        data-yaade-pane-tab-context={props.use.id}
      >
        <div className="border-b border-border px-3 py-2">
          <p className="truncate text-sm font-medium">{props.title}</p>
          <p className="text-2xs text-muted-foreground">
            Project, worktree, and runtime settings for this tab.
          </p>
        </div>
        <ToolContextControls
          use={props.use}
          projects={props.projects}
          active={props.active}
          presentation="popover"
          onChange={props.onContextChange}
          onProviderChange={props.onProviderChange}
        />
      </PopoverContent>
    </Popover>
  );
}

function handleTabKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      'button[role="tab"]',
    ),
  ];
  if (tabs.length === 0) return;
  const activeElement = document.activeElement;
  const current = Math.max(
    0,
    activeElement instanceof HTMLButtonElement
      ? tabs.indexOf(activeElement)
      : -1,
  );
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
          tabs.length;
  event.preventDefault();
  tabs[next]?.focus();
  tabs[next]?.click();
}

function ToolPaneTabBar(props: {
  readonly panelId: PanelId;
  readonly view: Extract<ToolPaneView, { kind: "tabs" }>;
  readonly focused: boolean;
  readonly usesById: ReadonlyMap<ToolUseId, ToolUse>;
  readonly runtimeTitles: ReadonlyMap<ToolUseId, RuntimeToolTitle>;
  readonly projects: readonly ProjectTarget[];
  readonly onActivate: (toolUseId: ToolUseId, use?: ToolUse) => void;
  readonly onClose: (toolUseId: ToolUseId) => void;
  readonly onContextChange: (
    use: ToolUse,
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>;
  readonly onProviderChange: (
    use: ToolUse,
    provider: AgentProvider,
  ) => Promise<void>;
}) {
  return (
    <DockTabBarDropTarget
      panelId={props.panelId}
      className="flex h-full min-w-0 flex-1 items-stretch gap-px overflow-x-auto"
      activeClassName="bg-primary/5"
      ariaLabel="Pane tools"
      onKeyDown={handleTabKeyDown}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {props.view.toolUseIds.map((toolUseId) => {
          const use = props.usesById.get(toolUseId);
          if (!use) return null;
          return (
            <MotionDiv
              key={toolUseId}
              layout
              initial={{ opacity: 0, scale: 0.96, x: 8 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              exit={{ opacity: 0, scale: 0.96, x: -8 }}
              transition={{
                layout: yaadeMotion.layoutTransition,
                default: yaadeMotion.layoutTransition,
              }}
              className="flex h-full min-w-0 shrink-0"
            >
              <ToolPaneTab
                panelId={props.panelId}
                use={use}
                title={toolUseWorkTitle(
                  use,
                  props.runtimeTitles.get(toolUseId),
                )}
                active={props.view.activeToolUseId === toolUseId}
                focused={props.focused}
                projects={props.projects}
                onActivate={() => props.onActivate(toolUseId, use)}
                onClose={() => props.onClose(toolUseId)}
                onContextChange={(project, checkout) =>
                  props.onContextChange(use, project, checkout)
                }
                onProviderChange={(provider) =>
                  props.onProviderChange(use, provider)
                }
              />
            </MotionDiv>
          );
        })}
      </AnimatePresence>
    </DockTabBarDropTarget>
  );
}

export default function ToolTilingWorkspace(props: ToolTilingWorkspaceProps) {
  const openToolIds = toolIdsInWorkspace(props.workspace);
  let paneCount = 0;
  props.workspace.tree.visitLeaves(() => {
    paneCount += 1;
  });

  const renderHeader = useCallback(
    (view: ToolPaneView, panelId: PanelId, meta: PanelSlotMeta) => {
      const activeUse =
        view.kind === "tabs"
          ? props.usesById.get(view.activeToolUseId)
          : undefined;
      return (
        <MuxPaneChrome
          title={view.kind === "empty" ? "Empty pane" : ""}
          focused={meta.focused}
          paneId={activeUse?.id ?? `empty-${panelId.id}`}
          panelId={panelId}
          zoomed={false}
          canZoom={false}
          draggable={false}
          processName={activeUse?.kind}
          center={
            view.kind === "tabs" ? (
              <ToolPaneTabBar
                panelId={panelId}
                view={view}
                focused={meta.focused}
                usesById={props.usesById}
                runtimeTitles={props.runtimeTitles}
                projects={props.projects}
                onActivate={(toolUseId, use) =>
                  props.onActivateTab(panelId, toolUseId, use)
                }
                onClose={(toolUseId) => props.onCloseTab(panelId, toolUseId)}
                onContextChange={props.onContextChange}
                onProviderChange={props.onProviderChange}
              />
            ) : undefined
          }
          trailing={
            <PaneNewToolMenu panelId={panelId} onAddTool={props.onAddTool} />
          }
          onSplitRight={() => props.onSplit(panelId, "right")}
          onSplitDown={() => props.onSplit(panelId, "bottom")}
          onZoom={() => undefined}
          onClose={() => props.onCloseView(panelId)}
        />
      );
    },
    [props],
  );

  const renderContent = useCallback(
    (view: ToolPaneView, _panelId: PanelId, meta: PanelSlotMeta) => {
      if (view.kind === "empty") {
        return openToolIds.length === 0 ? (
          props.empty
        ) : (
          <EmptyTile
            onAddKind={(kind) => props.onAddTool(_panelId, kind)}
          />
        );
      }
      const use = props.usesById.get(view.activeToolUseId);
      if (!use) {
        return (
          <EmptyTile
            onAddKind={(kind) => props.onAddTool(_panelId, kind)}
          />
        );
      }
      return (
        <AnimatePresence initial={false} mode="popLayout">
          <MotionDiv
            key={use.id}
            initial={{ opacity: 0, scale: 0.985, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.99, y: -4 }}
            transition={{
              opacity: yaadeMotion.quickFade,
              default: yaadeMotion.layoutTransition,
            }}
            className="flex h-full min-h-0 min-w-0 flex-col"
            data-yaade-tool-tile={use.id}
            data-focused={meta.focused ? "" : undefined}
          >
            {props.renderTool(use, meta.focused)}
          </MotionDiv>
        </AnimatePresence>
      );
    },
    [openToolIds.length, props],
  );

  return (
    <div
      className="h-full min-h-0 w-full p-1.5"
      data-yaade-tool-workspace=""
      data-yaade-viewport-count={openToolIds.length}
      data-yaade-pane-count={paneCount}
    >
      <PanelDock
        tree={props.workspace.tree}
        focusedPanelId={props.workspace.focusedPanelId}
        onFocusPanel={(panelId) => {
          const view = props.workspace.tree.getView(panelId);
          const use =
            view?.kind === "tabs"
              ? props.usesById.get(view.activeToolUseId)
              : undefined;
          props.onFocusPanel(panelId, use);
        }}
        onEvent={props.onPanelEvent}
        tabDnd={props.tabDnd}
        wrapTabDnd={false}
        renderHeader={renderHeader}
        renderContent={renderContent}
      />
    </div>
  );
}
