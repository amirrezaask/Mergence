import { PanelTree, type PanelTreeOptions } from "@yaade/panels";
import type { DropAction, PanelId } from "@yaade/shared";
import type { ToolUseId } from "@yaade/rpc";

/** Maximum number of simultaneously rendered panes. Each pane may hold many tabs. */
export const MAX_TOOL_TILES = 6;

export type ToolPaneView =
  | { readonly kind: "empty" }
  | {
      readonly kind: "tabs";
      readonly activeToolUseId: ToolUseId;
      readonly toolUseIds: readonly ToolUseId[];
    };

export type ToolWorkspace = {
  readonly tree: PanelTree<ToolPaneView>;
  readonly focusedPanelId: PanelId;
  /** Temporary presentation state; zoom never changes the underlying layout. */
  readonly zoomedPanelId: PanelId | null;
};

const TOOL_PANE_OPTIONS: PanelTreeOptions<ToolPaneView> = {
  emptyView: () => ({ kind: "empty" }),
  isEmpty: (view) => view.kind === "empty",
};

function firstPanel(tree: PanelTree<ToolPaneView>): PanelId {
  if (tree.root.kind === "leaf") return tree.root.panelId;
  let first: PanelId | undefined;
  tree.visitLeaves((leaf) => {
    first ??= leaf.panelId;
  });
  return first ?? tree.allocPanelId();
}

function panelExists(tree: PanelTree<ToolPaneView>, panelId: PanelId): boolean {
  return tree.getLeaf(panelId) != null;
}

function panelCount(tree: PanelTree<ToolPaneView>): number {
  let count = 0;
  tree.visitLeaves(() => {
    count += 1;
  });
  return count;
}

function resolvedFocus(
  tree: PanelTree<ToolPaneView>,
  preferred: PanelId,
): PanelId {
  return panelExists(tree, preferred) ? preferred : firstPanel(tree);
}

function findToolPanel(
  tree: PanelTree<ToolPaneView>,
  toolUseId: ToolUseId,
): PanelId | null {
  return tree.findPanelWithView(
    (view) => view.kind === "tabs" && view.toolUseIds.includes(toolUseId),
  );
}

function tabsView(
  toolUseIds: readonly ToolUseId[],
  activeToolUseId: ToolUseId,
): ToolPaneView {
  return { kind: "tabs", toolUseIds: [...toolUseIds], activeToolUseId };
}

function insertIntoPanel(
  tree: PanelTree<ToolPaneView>,
  panelId: PanelId,
  toolUseId: ToolUseId,
  insertIndex?: number,
): void {
  const view = tree.getView(panelId);
  if (!view || view.kind === "empty") {
    tree.setView(panelId, tabsView([toolUseId], toolUseId));
    return;
  }
  const ids = view.toolUseIds.filter((id) => id !== toolUseId);
  const index =
    insertIndex == null
      ? ids.length
      : Math.max(0, Math.min(Math.trunc(insertIndex), ids.length));
  ids.splice(index, 0, toolUseId);
  tree.setView(panelId, tabsView(ids, toolUseId));
}

function removeFromPanel(
  tree: PanelTree<ToolPaneView>,
  panelId: PanelId,
  toolUseId: ToolUseId,
): void {
  const view = tree.getView(panelId);
  if (!view || view.kind !== "tabs") return;
  const removedIndex = view.toolUseIds.indexOf(toolUseId);
  if (removedIndex < 0) return;
  const ids = view.toolUseIds.filter((id) => id !== toolUseId);
  if (ids.length === 0) {
    if (panelCount(tree) === 1) tree.setView(panelId, { kind: "empty" });
    else tree.closePanel(panelId);
    return;
  }
  const activeToolUseId =
    view.activeToolUseId === toolUseId
      ? ids[Math.min(removedIndex, ids.length - 1)]!
      : view.activeToolUseId;
  tree.setView(panelId, tabsView(ids, activeToolUseId));
}

export function createToolWorkspace(): ToolWorkspace {
  const tree = new PanelTree(TOOL_PANE_OPTIONS);
  return {
    tree,
    focusedPanelId: firstPanel(tree),
    zoomedPanelId: null,
  };
}

/** Open a tool as a tab in the focused pane, or activate its existing tab. */
export function openToolView(
  workspace: ToolWorkspace,
  toolUseId: ToolUseId,
): ToolWorkspace {
  const existing = findToolPanel(workspace.tree, toolUseId);
  if (existing) {
    const view = workspace.tree.getView(existing);
    if (
      view?.kind === "tabs" &&
      view.activeToolUseId === toolUseId &&
      workspace.focusedPanelId.id === existing.id
    ) {
      return workspace;
    }
    const tree = workspace.tree.clone();
    if (view?.kind === "tabs") {
      tree.setView(existing, tabsView(view.toolUseIds, toolUseId));
    }
    return {
      tree,
      focusedPanelId: existing,
      zoomedPanelId:
        workspace.zoomedPanelId?.id === existing.id
          ? workspace.zoomedPanelId
          : null,
    };
  }

  const tree = workspace.tree.clone();
  const target = resolvedFocus(tree, workspace.focusedPanelId);
  insertIntoPanel(tree, target, toolUseId);
  return { tree, focusedPanelId: target, zoomedPanelId: null };
}

export function focusToolPanel(
  workspace: ToolWorkspace,
  panelId: PanelId,
): ToolWorkspace {
  if (!panelExists(workspace.tree, panelId)) return workspace;
  if (workspace.focusedPanelId.id === panelId.id) return workspace;
  return {
    ...workspace,
    focusedPanelId: panelId,
    zoomedPanelId: null,
  };
}

export function activateToolTab(
  workspace: ToolWorkspace,
  panelId: PanelId,
  toolUseId: ToolUseId,
): ToolWorkspace {
  const view = workspace.tree.getView(panelId);
  if (
    !view ||
    view.kind !== "tabs" ||
    !view.toolUseIds.includes(toolUseId)
  ) {
    return workspace;
  }
  if (
    view.activeToolUseId === toolUseId &&
    workspace.focusedPanelId.id === panelId.id
  ) {
    return workspace;
  }
  const tree = workspace.tree.clone();
  tree.setView(panelId, tabsView(view.toolUseIds, toolUseId));
  return {
    tree,
    focusedPanelId: panelId,
    zoomedPanelId:
      workspace.zoomedPanelId?.id === panelId.id
        ? workspace.zoomedPanelId
        : null,
  };
}

export function reorderToolTabs(
  workspace: ToolWorkspace,
  panelId: PanelId,
  toolUseId: ToolUseId,
  toIndex: number,
): ToolWorkspace {
  const view = workspace.tree.getView(panelId);
  if (!view || view.kind !== "tabs") return workspace;
  const fromIndex = view.toolUseIds.indexOf(toolUseId);
  if (fromIndex < 0) return workspace;
  const ids = [...view.toolUseIds];
  const [moved] = ids.splice(fromIndex, 1);
  if (!moved) return workspace;
  const target = Math.max(0, Math.min(Math.trunc(toIndex), ids.length));
  ids.splice(target, 0, moved);
  if (ids.every((id, index) => id === view.toolUseIds[index])) return workspace;
  const tree = workspace.tree.clone();
  tree.setView(panelId, tabsView(ids, view.activeToolUseId));
  return { ...workspace, tree };
}

export function splitToolPanel(
  workspace: ToolWorkspace,
  panelId: PanelId,
  edge: "right" | "bottom",
): ToolWorkspace {
  if (!panelExists(workspace.tree, panelId)) return workspace;
  if (panelCount(workspace.tree) >= MAX_TOOL_TILES) return workspace;
  const tree = workspace.tree.clone();
  const created = tree.splitAtEdge(panelId, edge);
  return { tree, focusedPanelId: created, zoomedPanelId: null };
}

/** Toggle a temporary full-workspace view for one pane. */
export function toggleToolPanelZoom(
  workspace: ToolWorkspace,
  panelId: PanelId,
): ToolWorkspace {
  if (!panelExists(workspace.tree, panelId) || panelCount(workspace.tree) < 2) {
    return workspace;
  }
  return {
    ...workspace,
    focusedPanelId: panelId,
    zoomedPanelId:
      workspace.zoomedPanelId?.id === panelId.id ? null : panelId,
  };
}

/** Close every tab in a pane without archiving any ToolUse. */
export function closeToolPanel(
  workspace: ToolWorkspace,
  panelId: PanelId,
): ToolWorkspace {
  if (!panelExists(workspace.tree, panelId)) return workspace;
  const tree = workspace.tree.clone();
  if (panelCount(tree) === 1) {
    tree.setView(panelId, { kind: "empty" });
    return { tree, focusedPanelId: panelId, zoomedPanelId: null };
  }
  tree.closePanel(panelId);
  return {
    tree,
    focusedPanelId: resolvedFocus(tree, workspace.focusedPanelId),
    zoomedPanelId:
      workspace.zoomedPanelId?.id === panelId.id
        ? null
        : workspace.zoomedPanelId,
  };
}

/** Close one tab without archiving its ToolUse or stopping its process. */
export function closeToolTab(
  workspace: ToolWorkspace,
  panelId: PanelId,
  toolUseId: ToolUseId,
): ToolWorkspace {
  const view = workspace.tree.getView(panelId);
  if (
    !view ||
    view.kind !== "tabs" ||
    !view.toolUseIds.includes(toolUseId)
  ) {
    return workspace;
  }
  const tree = workspace.tree.clone();
  removeFromPanel(tree, panelId, toolUseId);
  return {
    tree,
    focusedPanelId: resolvedFocus(tree, workspace.focusedPanelId),
    zoomedPanelId:
      workspace.zoomedPanelId && tree.getLeaf(workspace.zoomedPanelId)
        ? workspace.zoomedPanelId
        : null,
  };
}

export function resizeToolSplit(
  workspace: ToolWorkspace,
  path: number[],
  ratios: number[],
): ToolWorkspace {
  const tree = workspace.tree.clone();
  if (!tree.setSplitRatios(path, ratios)) return workspace;
  return { ...workspace, tree };
}

export function dockToolView(
  workspace: ToolWorkspace,
  toolUseId: ToolUseId,
  target: PanelId,
  action: DropAction,
): ToolWorkspace {
  if (!panelExists(workspace.tree, target)) return workspace;
  const source = findToolPanel(workspace.tree, toolUseId);
  const split = action.kind === "split" && action.edge !== "center";

  if (source?.id === target.id) {
    if (!split) {
      if (action.kind === "moveToPane" && action.insertIndex != null) {
        return reorderToolTabs(
          activateToolTab(workspace, target, toolUseId),
          target,
          toolUseId,
          action.insertIndex,
        );
      }
      return activateToolTab(workspace, target, toolUseId);
    }
    const sourceView = workspace.tree.getView(source);
    if (
      sourceView?.kind !== "tabs" ||
      sourceView.toolUseIds.length <= 1 ||
      panelCount(workspace.tree) >= MAX_TOOL_TILES
    ) {
      return workspace;
    }
    const tree = workspace.tree.clone();
    removeFromPanel(tree, source, toolUseId);
    const created = tree.splitAtEdge(target, action.edge);
    tree.setView(created, tabsView([toolUseId], toolUseId));
    return { tree, focusedPanelId: created, zoomedPanelId: null };
  }

  const tree = workspace.tree.clone();
  if (source) removeFromPanel(tree, source, toolUseId);
  if (!panelExists(tree, target)) return workspace;

  if (split && panelCount(tree) < MAX_TOOL_TILES) {
    const created = tree.splitAtEdge(target, action.edge);
    tree.setView(created, tabsView([toolUseId], toolUseId));
    return { tree, focusedPanelId: created, zoomedPanelId: null };
  }

  const insertIndex =
    action.kind === "moveToPane" ? action.insertIndex : undefined;
  insertIntoPanel(tree, target, toolUseId, insertIndex);
  return { tree, focusedPanelId: target, zoomedPanelId: null };
}

export function removeMissingToolViews(
  workspace: ToolWorkspace,
  liveToolUseIds: ReadonlySet<ToolUseId>,
): ToolWorkspace {
  const missing: ToolUseId[] = [];
  workspace.tree.visitLeaves((leaf) => {
    if (leaf.view.kind !== "tabs") return;
    for (const toolUseId of leaf.view.toolUseIds) {
      if (!liveToolUseIds.has(toolUseId)) missing.push(toolUseId);
    }
  });
  let next = workspace;
  for (const toolUseId of missing) {
    const panelId = findToolPanel(next.tree, toolUseId);
    if (panelId) next = closeToolTab(next, panelId, toolUseId);
  }
  return next;
}

export function toolIdsInWorkspace(
  workspace: ToolWorkspace,
): readonly ToolUseId[] {
  const ids: ToolUseId[] = [];
  workspace.tree.visitLeaves((leaf) => {
    if (leaf.view.kind === "tabs") ids.push(...leaf.view.toolUseIds);
  });
  return ids;
}
