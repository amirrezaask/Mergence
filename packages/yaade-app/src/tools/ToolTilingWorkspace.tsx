import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  GitBranch,
  PanelTopOpen,
  Plus,
  Terminal as TerminalIcon,
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
  KeyBindingKbd,
  MuxPaneChrome,
  PanelDock,
  SessionHeaderChromeProvider,
  type PanelSlotMeta,
  type TabDndHandlers,
} from "@yaade/ui";
import {
  Button,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@yaade/ui/primitives";
import { ToolContextControls } from "./ToolContextControls.js";
import { toolUsePaneTitle, type RuntimeToolTitle } from "./tool-title.js";
import { toolSessionShortcutFor } from "./tool-session-keymap.js";
import type { ToolPaneView, ToolWorkspace } from "./tool-tiling.js";
import { toolIdsInWorkspace, toolPaneCount } from "./tool-tiling.js";

export type ToolTilingWorkspaceProps = {
  readonly workspace: ToolWorkspace;
  readonly usesById: ReadonlyMap<ToolUseId, ToolUse>;
  readonly runtimeTitles: ReadonlyMap<ToolUseId, RuntimeToolTitle>;
  readonly projects: readonly ProjectTarget[];
  readonly onContextChange: (
    use: ToolUse,
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>;
  readonly tabDnd: TabDndHandlers;
  readonly empty: ReactNode;
  readonly onPanelEvent: (event: PanelEvent) => void;
  readonly onFocusPanel: (panelId: PanelId, use?: ToolUse) => void;
  readonly onAddTool: (panelId: PanelId, kind: ToolKind) => void;
  readonly onSplit: (panelId: PanelId, edge: "right" | "bottom") => void;
  readonly onZoom: (panelId: PanelId) => void;
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

type PaneTool = {
  kind: ToolKind;
  label: string;
  icon: typeof TerminalIcon;
  command: string;
};

const paneToolKinds: readonly PaneTool[] = [
  {
    kind: "terminal",
    label: "Terminal",
    icon: TerminalIcon,
    command: "tool.newTerminal",
  },
  {
    kind: "git",
    label: "Git",
    icon: GitBranch,
    command: "tool.newGit",
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
        {paneToolKinds.map(item => {
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

export default function ToolTilingWorkspace(props: ToolTilingWorkspaceProps) {
  const openToolIds = toolIdsInWorkspace(props.workspace);
  const paneCount = toolPaneCount(props.workspace);
  const canZoom = paneCount > 1;
  const zoomedPanelId = props.workspace.zoomedPanelId;
  const [contextTarget, setContextTarget] = useState<{
    readonly panelId: number;
    readonly toolUseId: ToolUseId;
  } | null>(null);
  // Mode-specific chrome is owned by the tool renderer but lives in its pane header.
  const [headerTargets, setHeaderTargets] = useState<ReadonlyMap<number, HTMLElement>>(
    () => new Map(),
  );
  const headerTargetRefs = useRef(
    new Map<number, (element: HTMLElement | null) => void>(),
  );
  const headerContextRef = useCallback((panelId: number) => {
    const existing = headerTargetRefs.current.get(panelId);
    if (existing) return existing;
    const ref = (element: HTMLElement | null) => {
      setHeaderTargets(current => {
        if (current.get(panelId) === element) return current;
        const next = new Map(current);
        if (element) next.set(panelId, element);
        else next.delete(panelId);
        return next;
      });
    };
    headerTargetRefs.current.set(panelId, ref);
    return ref;
  }, []);

  const renderHeader = useCallback(
    (view: ToolPaneView, panelId: PanelId, meta: PanelSlotMeta) => {
      const activeUse =
        view.kind === "tool"
          ? props.usesById.get(view.toolUseId)
          : undefined;
      const contextOpen =
        activeUse != null &&
        contextTarget?.panelId === panelId.id &&
        contextTarget.toolUseId === activeUse.id;
      const chrome = (
        <MuxPaneChrome
          title={
            activeUse
              ? toolUsePaneTitle(
                  activeUse,
                  props.runtimeTitles.get(activeUse.id),
                )
              : "Empty pane"
          }
          focused={meta.focused}
          paneId={activeUse?.id ?? `empty-${panelId.id}`}
          panelId={panelId}
          zoomed={zoomedPanelId?.id === panelId.id}
          canZoom={canZoom}
          processName={activeUse?.kind}
          splitControlsOnly
          contextRef={headerContextRef(panelId.id)}
          trailing={
            <PaneNewToolMenu
              panelId={panelId}
              onAddTool={props.onAddTool}
            />
          }
          onSplitRight={() => props.onSplit(panelId, "right")}
          onSplitDown={() => props.onSplit(panelId, "bottom")}
          onOpenContext={
            activeUse
              ? () =>
                  setContextTarget({
                    panelId: panelId.id,
                    toolUseId: activeUse.id,
                  })
              : undefined
          }
          contextOpen={contextOpen}
          onZoom={() => props.onZoom(panelId)}
          shortcutFor={command =>
            command === "mux.zoomPane"
              ? toolSessionShortcutFor("pane.zoom")
              : undefined
          }
          onClose={() => props.onCloseView(panelId)}
        />
      );
      if (!activeUse) return chrome;

      return (
        <Popover
          open={contextOpen}
          onOpenChange={open => {
            setContextTarget(current =>
              open
                ? { panelId: panelId.id, toolUseId: activeUse.id }
                : current?.panelId === panelId.id &&
                    current.toolUseId === activeUse.id
                  ? null
                  : current,
            );
          }}
        >
          <PopoverAnchor asChild>
            <div className="shrink-0">{chrome}</div>
          </PopoverAnchor>
          <PopoverContent
            side="bottom"
            align="start"
            sideOffset={8}
            className="w-80 max-w-[calc(100vw-1rem)] p-0"
            data-yaade-tool-context-popover
            data-yaade-pane-tool-context-popover
          >
            <div className="border-b border-border px-3 py-2">
              <p className="text-sm font-medium">Project and worktree</p>
              <p className="truncate text-2xs text-muted-foreground">
                This tool only. Other tools keep their own checkout.
              </p>
            </div>
            <ToolContextControls
              use={activeUse}
              projects={props.projects}
              active={meta.focused}
              presentation="popover"
              onChange={(project, checkout) =>
                props.onContextChange(activeUse, project, checkout)
              }
            />
          </PopoverContent>
        </Popover>
      );
    },
    [canZoom, contextTarget, headerContextRef, paneCount, props, zoomedPanelId],
  );

  const renderContent = useCallback(
    (view: ToolPaneView, panelId: PanelId, meta: PanelSlotMeta) => {
      if (view.kind === "empty") {
        return openToolIds.length === 0 ? (
          props.empty
        ) : (
          <EmptyTile
            onAddKind={(kind) => props.onAddTool(panelId, kind)}
          />
        );
      }
      const use = props.usesById.get(view.toolUseId);
      if (!use) {
        return (
          <EmptyTile
            onAddKind={(kind) => props.onAddTool(panelId, kind)}
          />
        );
      }
      return (
        <SessionHeaderChromeProvider
          target={headerTargets.get(panelId.id) ?? null}
        >
          <div
            className="flex h-full min-h-0 min-w-0 flex-col"
            data-yaade-tool-tile={use.id}
            data-focused={meta.focused ? "" : undefined}
          >
            {props.renderTool(use, meta.focused)}
          </div>
        </SessionHeaderChromeProvider>
      );
    },
    [headerTargets, openToolIds.length, props],
  );

  const zoomedView = zoomedPanelId
    ? props.workspace.tree.getView(zoomedPanelId)
    : null;

  return (
    <div
      className="h-full min-h-0 w-full"
      data-yaade-tool-workspace=""
      data-yaade-viewport-count={openToolIds.length}
      data-yaade-pane-count={paneCount}
      data-yaade-pane-zoomed={zoomedPanelId?.id}
    >
      {zoomedPanelId && zoomedView ? (
        <div
          className="relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-background"
          data-yaade-panel-leaf={zoomedPanelId.id}
          data-yaade-session-window=""
          data-focused=""
          data-yaade-pane-zoomed-leaf=""
        >
          {renderHeader(zoomedView, zoomedPanelId, {
            focused: true,
            onClose: () => props.onCloseView(zoomedPanelId),
          })}
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
            {renderContent(zoomedView, zoomedPanelId, {
              focused: true,
              onClose: () => props.onCloseView(zoomedPanelId),
            })}
          </div>
        </div>
      ) : (
        <PanelDock
          tree={props.workspace.tree}
          focusedPanelId={props.workspace.focusedPanelId}
          onFocusPanel={(panelId) => {
            const view = props.workspace.tree.getView(panelId);
            const use =
              view?.kind === "tool"
                ? props.usesById.get(view.toolUseId)
                : undefined;
            props.onFocusPanel(panelId, use);
          }}
          onEvent={props.onPanelEvent}
          tabDnd={props.tabDnd}
          wrapTabDnd={false}
          leafClassName="rounded-none border-0 bg-background"
          renderHeader={renderHeader}
          renderContent={renderContent}
        />
      )}
    </div>
  );
}
