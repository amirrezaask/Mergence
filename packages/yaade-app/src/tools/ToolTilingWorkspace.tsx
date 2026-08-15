import { useCallback, type ReactNode } from "react";
import { PanelTopOpen } from "lucide-react";
import type { PanelEvent } from "@yaade/panels";
import type { ToolUse, ToolUseId } from "@yaade/rpc";
import type { PanelId } from "@yaade/shared";
import {
  MuxPaneChrome,
  PanelDock,
  type PanelSlotMeta,
  type TabDndHandlers,
} from "@yaade/ui";
import type { RuntimeToolTitle } from "./tool-title.js";
import { toolUseWorkTitle } from "./tool-title.js";
import type { ToolPaneView, ToolWorkspace } from "./tool-tiling.js";
import { toolIdsInWorkspace } from "./tool-tiling.js";

export type ToolTilingWorkspaceProps = {
  readonly workspace: ToolWorkspace;
  readonly usesById: ReadonlyMap<ToolUseId, ToolUse>;
  readonly runtimeTitles: ReadonlyMap<ToolUseId, RuntimeToolTitle>;
  readonly tabDnd: TabDndHandlers;
  readonly empty: ReactNode;
  readonly onPanelEvent: (event: PanelEvent) => void;
  readonly onFocusPanel: (panelId: PanelId, use?: ToolUse) => void;
  readonly onSplit: (panelId: PanelId, edge: "right" | "bottom") => void;
  readonly onCloseView: (panelId: PanelId) => void;
  readonly renderTool: (use: ToolUse, focused: boolean) => ReactNode;
};

function EmptyTile() {
  return (
    <div
      className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground"
      data-yaade-empty-tool-tile=""
    >
      <PanelTopOpen className="size-5" aria-hidden />
      <p className="text-xs font-medium text-foreground">Open a tool here</p>
      <p className="max-w-56 text-2xs leading-relaxed">
        Select a tool from navigation or drag one onto this tile.
      </p>
    </div>
  );
}

export default function ToolTilingWorkspace(props: ToolTilingWorkspaceProps) {
  const openToolIds = toolIdsInWorkspace(props.workspace);
  const renderHeader = useCallback(
    (view: ToolPaneView, panelId: PanelId, meta: PanelSlotMeta) => {
      if (view.kind !== "tool") return null;
      const use = props.usesById.get(view.toolUseId);
      if (!use) return null;
      return (
        <MuxPaneChrome
          title={toolUseWorkTitle(use, props.runtimeTitles.get(use.id))}
          focused={meta.focused}
          paneId={use.id}
          panelId={panelId}
          zoomed={false}
          canZoom={false}
          processName={use.kind}
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
    (view: ToolPaneView, panelId: PanelId, meta: PanelSlotMeta) => {
      if (view.kind === "empty") {
        return openToolIds.length === 0 ? (
          props.empty
        ) : (
          <EmptyTile />
        );
      }
      const use = props.usesById.get(view.toolUseId);
      if (!use) return <EmptyTile />;
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

  return (
    <div
      className="h-full min-h-0 w-full gap-1.5 p-1.5 [&_[data-slot=resizable-panel-group]]:gap-1.5"
      data-yaade-tool-workspace=""
      data-yaade-viewport-count={openToolIds.length}
    >
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
        renderHeader={renderHeader}
        renderContent={renderContent}
      />
    </div>
  );
}
