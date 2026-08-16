import { useCallback, type ReactNode } from "react";
import {
  GitBranch,
  PanelTopOpen,
  Search,
  Terminal as TerminalIcon,
} from "lucide-react";
import type { PanelEvent } from "@yaade/panels";
import type { ToolKind, ToolUse, ToolUseId } from "@yaade/rpc";
import type { PanelId } from "@yaade/shared";
import {
  MuxPaneChrome,
  PanelDock,
  type PanelSlotMeta,
  type TabDndHandlers,
} from "@yaade/ui";
import { Button } from "@yaade/ui/primitives";
import { toolUsePaneTitle, type RuntimeToolTitle } from "./tool-title.js";
import { toolSessionShortcutFor } from "./tool-session-keymap.js";
import type { ToolPaneView, ToolWorkspace } from "./tool-tiling.js";
import { toolIdsInWorkspace, toolPaneCount } from "./tool-tiling.js";

export type ToolTilingWorkspaceProps = {
  readonly workspace: ToolWorkspace;
  readonly usesById: ReadonlyMap<ToolUseId, ToolUse>;
  readonly runtimeTitles: ReadonlyMap<ToolUseId, RuntimeToolTitle>;
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

const paneToolKinds: readonly {
  kind: Exclude<ToolKind, "agent">;
  label: string;
  icon: typeof TerminalIcon;
}[] = [
  {
    kind: "terminal",
    label: "Terminal",
    icon: TerminalIcon,
  },
  { kind: "git", label: "Git", icon: GitBranch },
  {
    kind: "search",
    label: "Search",
    icon: Search,
  },
];

export default function ToolTilingWorkspace(props: ToolTilingWorkspaceProps) {
  const openToolIds = toolIdsInWorkspace(props.workspace);
  const paneCount = toolPaneCount(props.workspace);
  const canZoom = paneCount > 1;
  const zoomedPanelId = props.workspace.zoomedPanelId;

  const renderHeader = useCallback(
    (view: ToolPaneView, panelId: PanelId, meta: PanelSlotMeta) => {
      const activeUse =
        view.kind === "tool"
          ? props.usesById.get(view.toolUseId)
          : undefined;
      return (
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
          onSplitRight={() => props.onSplit(panelId, "right")}
          onSplitDown={() => props.onSplit(panelId, "bottom")}
          onZoom={() => props.onZoom(panelId)}
          shortcutFor={command =>
            command === "mux.zoomPane"
              ? toolSessionShortcutFor("pane.zoom")
              : undefined
          }
          onClose={() => props.onCloseView(panelId)}
        />
      );
    },
    [canZoom, paneCount, props, zoomedPanelId],
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
      const use = props.usesById.get(view.toolUseId);
      if (!use) {
        return (
          <EmptyTile
            onAddKind={(kind) => props.onAddTool(_panelId, kind)}
          />
        );
      }
      return (
        <div
          className="flex h-full min-h-0 min-w-0 flex-col"
          data-yaade-tool-tile={use.id}
          data-focused={meta.focused ? "" : undefined}
        >
          {props.renderTool(use, meta.focused)}
        </div>
      );
    },
    [openToolIds.length, props],
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
