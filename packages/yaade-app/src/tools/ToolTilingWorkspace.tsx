import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Terminal as TerminalIcon } from "lucide-react";
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
  PanelDockInDnd,
  SessionHeaderChromeProvider,
  type PanelSlotMeta,
} from "@yaade/ui/session";
import {
  Button,
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@yaade/ui/primitives";
import { ToolContextControls } from "./ToolContextControls.js";
import { toolUsePaneTitle, type RuntimeToolTitle } from "./tool-title.js";
import {
  toolSessionDirectShortcutFor,
  toolSessionShortcutFor,
} from "./tool-session-keymap.js";
import type { ToolPaneView, ToolWorkspace } from "./tool-tiling.js";
import { toolIdsInWorkspace, toolPaneCount } from "./tool-tiling.js";

export type ToolTilingWorkspaceProps = {
  readonly workspace: ToolWorkspace;
  readonly usesById: ReadonlyMap<ToolUseId, ToolUse>;
  readonly runtimeTitles: ReadonlyMap<ToolUseId, RuntimeToolTitle>;
  readonly agentProvidersByToolUseId: ReadonlyMap<string, string>;
  readonly projects: readonly ProjectTarget[];
  readonly onAddProject: (rootPath: string) => Promise<ProjectTarget | undefined>;
  readonly onContextChange: (
    use: ToolUse,
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>;
  readonly onPanelEvent: (event: PanelEvent) => void;
  readonly onFocusPanel: (panelId: PanelId, use?: ToolUse) => void;
  readonly onAddSplitTool: (
    panelId: PanelId,
    edge: "right" | "bottom",
    kind: ToolKind,
  ) => void;
  readonly onSplit: (panelId: PanelId, edge: "right" | "bottom") => void;
  readonly onZoom: (panelId: PanelId) => void;
  readonly onCloseView: (panelId: PanelId) => void;
  readonly onChromeOverlayChange?: (open: boolean) => void;
  readonly renderTool: (use: ToolUse, focused: boolean) => ReactNode;
};

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
];

function PaneNewToolMenu(props: {
  readonly panelId: PanelId;
  readonly edge: "right" | "bottom";
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly trigger: ReactNode;
  readonly onAddTool: (
    panelId: PanelId,
    edge: "right" | "bottom",
    kind: ToolKind,
  ) => void;
}) {
  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverAnchor asChild>{props.trigger}</PopoverAnchor>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-48 p-1.5"
        data-yaade-pane-tool-menu=""
      >
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
                props.onOpenChange(false);
                props.onAddTool(props.panelId, props.edge, item.kind);
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

export default function ToolTilingWorkspace({
  workspace,
  usesById,
  runtimeTitles,
  agentProvidersByToolUseId,
  projects,
  onAddProject,
  onContextChange,
  onPanelEvent,
  onFocusPanel,
  onAddSplitTool,
  onSplit,
  onZoom,
  onCloseView,
  onChromeOverlayChange,
  renderTool,
}: ToolTilingWorkspaceProps) {
  const openToolIds = toolIdsInWorkspace(workspace);
  const paneCount = toolPaneCount(workspace);
  const canZoom = paneCount > 1;
  const zoomedPanelId = workspace.zoomedPanelId;
  const [contextTarget, setContextTarget] = useState<{
    readonly panelId: number;
    readonly toolUseId: ToolUseId;
  } | null>(null);
  const [splitToolTarget, setSplitToolTarget] = useState<{
    readonly panelId: number;
    readonly edge: "right" | "bottom";
  } | null>(null);
  useEffect(() => {
    onChromeOverlayChange?.(
      contextTarget != null || splitToolTarget != null,
    );
  }, [contextTarget, onChromeOverlayChange, splitToolTarget]);
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
          ? usesById.get(view.toolUseId)
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
                  runtimeTitles.get(activeUse.id),
                )
              : "Empty pane"
          }
          focused={meta.focused}
          paneId={activeUse?.id ?? `empty-${panelId.id}`}
          panelId={panelId}
          zoomed={zoomedPanelId?.id === panelId.id}
          canZoom={canZoom}
          processName={activeUse?.kind}
          terminalProvider={
            activeUse?.kind === "terminal"
              ? agentProvidersByToolUseId.get(activeUse.id) ?? "terminal"
              : undefined
          }
          contextRef={headerContextRef(panelId.id)}
          onSplitButton={(direction, event) => {
            setContextTarget(null);
            const edge = direction === "right" ? "right" : "bottom";
            if (event.metaKey || event.ctrlKey) {
              event.preventDefault();
              setSplitToolTarget({ panelId: panelId.id, edge });
              return;
            }
            setSplitToolTarget(null);
            onAddSplitTool(panelId, edge, "terminal");
          }}
          wrapSplitButton={(direction, button) => {
            const edge = direction === "right" ? "right" : "bottom";
            const open =
              splitToolTarget?.panelId === panelId.id &&
              splitToolTarget.edge === edge;
            return (
              <PaneNewToolMenu
                panelId={panelId}
                edge={edge}
                open={open}
                onOpenChange={nextOpen => {
                  setSplitToolTarget(current =>
                    nextOpen
                      ? { panelId: panelId.id, edge }
                      : current?.panelId === panelId.id &&
                          current.edge === edge
                        ? null
                        : current,
                  );
                }}
                trigger={button}
                onAddTool={onAddSplitTool}
              />
            );
          }}
          onSplitRight={() => onSplit(panelId, "right")}
          onSplitDown={() => onSplit(panelId, "bottom")}
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
          onZoom={() => onZoom(panelId)}
          shortcutFor={command => {
            if (command === "mux.zoomPane") {
              return toolSessionShortcutFor("pane.zoom");
            }
            if (command === "mux.splitRight") {
              return toolSessionDirectShortcutFor("pane.splitRight");
            }
            if (command === "mux.splitDown") {
              return toolSessionDirectShortcutFor("pane.splitDown");
            }
            return undefined;
          }}
          onClose={() => onCloseView(panelId)}
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
              projects={projects}
              onAddProject={onAddProject}
              active={meta.focused}
              presentation="popover"
              onChange={(project, checkout) =>
                onContextChange(activeUse, project, checkout)
              }
            />
          </PopoverContent>
        </Popover>
      );
    },
    [
      agentProvidersByToolUseId,
      canZoom,
      contextTarget,
      headerContextRef,
      onAddSplitTool,
      onCloseView,
      onContextChange,
      onSplit,
      onZoom,
      onAddProject,
      projects,
      runtimeTitles,
      splitToolTarget,
      usesById,
      zoomedPanelId,
    ],
  );

  const renderContent = useCallback(
    (view: ToolPaneView, panelId: PanelId, meta: PanelSlotMeta) => {
      if (view.kind === "empty") {
        return (
          <div
            className="h-full min-h-0"
            data-yaade-empty-tool-pending=""
          />
        );
      }
      const use = usesById.get(view.toolUseId);
      if (!use) {
        return (
          <div
            className="h-full min-h-0"
            data-yaade-empty-tool-pending=""
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
            {renderTool(use, meta.focused)}
          </div>
        </SessionHeaderChromeProvider>
      );
    },
    [headerTargets, renderTool, usesById],
  );

  const zoomedView = zoomedPanelId
    ? workspace.tree.getView(zoomedPanelId)
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
            onClose: () => onCloseView(zoomedPanelId),
          })}
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
            {renderContent(zoomedView, zoomedPanelId, {
              focused: true,
              onClose: () => onCloseView(zoomedPanelId),
            })}
          </div>
        </div>
      ) : (
        <PanelDockInDnd
          tree={workspace.tree}
          focusedPanelId={workspace.focusedPanelId}
          onFocusPanel={(panelId) => {
            const view = workspace.tree.getView(panelId);
            const use =
              view?.kind === "tool"
                ? usesById.get(view.toolUseId)
                : undefined;
            onFocusPanel(panelId, use);
          }}
          onEvent={onPanelEvent}
          leafClassName="rounded-none border-0 bg-background"
          renderHeader={renderHeader}
          renderContent={renderContent}
        />
      )}
    </div>
  );
}
