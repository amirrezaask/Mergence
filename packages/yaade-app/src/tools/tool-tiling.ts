import { PanelTree, type PanelTreeOptions } from "@yaade/panels";
import type { DropAction, PanelId } from "@yaade/shared";
import type { ToolUseId } from "@yaade/rpc";

export const MAX_TOOL_TILES = 6;

export type ToolPaneView =
  | { readonly kind: "empty" }
  | { readonly kind: "tool"; readonly toolUseId: ToolUseId };

export type ToolWorkspace = {
  readonly tree: PanelTree<ToolPaneView>;
  readonly focusedPanelId: PanelId;
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

export function createToolWorkspace(): ToolWorkspace {
  const tree = new PanelTree(TOOL_PANE_OPTIONS);
  return { tree, focusedPanelId: firstPanel(tree) };
}

export function openToolView(
  workspace: ToolWorkspace,
  toolUseId: ToolUseId,
): ToolWorkspace {
  const existing = workspace.tree.findPanelWithView(
    (view) => view.kind === "tool" && view.toolUseId === toolUseId,
  );
  if (existing) return { ...workspace, focusedPanelId: existing };

  const tree = workspace.tree.clone();
  const preferred = resolvedFocus(tree, workspace.focusedPanelId);
  let target = preferred;
  const preferredView = tree.getView(preferred);

  if (preferredView?.kind !== "empty") {
    let emptyPanel: PanelId | undefined;
    tree.visitLeaves((leaf) => {
      if (!emptyPanel && leaf.view.kind === "empty") emptyPanel = leaf.panelId;
    });
    if (emptyPanel) {
      target = emptyPanel;
    } else if (panelCount(tree) < MAX_TOOL_TILES) {
      target = tree.splitAtEdge(preferred, "right");
    }
  }

  tree.setView(target, { kind: "tool", toolUseId });
  return { tree, focusedPanelId: target };
}

export function focusToolPanel(
  workspace: ToolWorkspace,
  panelId: PanelId,
): ToolWorkspace {
  if (!panelExists(workspace.tree, panelId)) return workspace;
  if (workspace.focusedPanelId.id === panelId.id) return workspace;
  return { ...workspace, focusedPanelId: panelId };
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
  return { tree, focusedPanelId: created };
}

export function closeToolPanel(
  workspace: ToolWorkspace,
  panelId: PanelId,
): ToolWorkspace {
  if (!panelExists(workspace.tree, panelId)) return workspace;
  const tree = workspace.tree.clone();
  if (panelCount(tree) === 1) {
    tree.setView(panelId, { kind: "empty" });
    return { tree, focusedPanelId: panelId };
  }
  tree.closePanel(panelId);
  return {
    tree,
    focusedPanelId: resolvedFocus(tree, workspace.focusedPanelId),
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

function placeToolAtTarget(
  tree: PanelTree<ToolPaneView>,
  toolUseId: ToolUseId,
  target: PanelId,
  action: DropAction,
): PanelId {
  if (action.kind === "split" && action.edge !== "center") {
    const created = tree.splitAtEdge(target, action.edge);
    tree.setView(created, { kind: "tool", toolUseId });
    return created;
  }
  tree.setView(target, { kind: "tool", toolUseId });
  return target;
}

export function dockToolView(
  workspace: ToolWorkspace,
  toolUseId: ToolUseId,
  target: PanelId,
  action: DropAction,
): ToolWorkspace {
  if (!panelExists(workspace.tree, target)) return workspace;
  const source = workspace.tree.findPanelWithView(
    (view) => view.kind === "tool" && view.toolUseId === toolUseId,
  );
  if (source?.id === target.id) return workspace;

  const tree = workspace.tree.clone();
  if (source) tree.closePanel(source);
  if (!panelExists(tree, target)) return workspace;

  const isSplit = action.kind === "split" && action.edge !== "center";
  if (!source && isSplit && panelCount(tree) >= MAX_TOOL_TILES) {
    tree.setView(target, { kind: "tool", toolUseId });
    return { tree, focusedPanelId: target };
  }

  const focusedPanelId = placeToolAtTarget(tree, toolUseId, target, action);
  return { tree, focusedPanelId };
}

export function removeMissingToolViews(
  workspace: ToolWorkspace,
  liveToolUseIds: ReadonlySet<ToolUseId>,
): ToolWorkspace {
  const missing: PanelId[] = [];
  workspace.tree.visitLeaves((leaf) => {
    if (leaf.view.kind === "tool" && !liveToolUseIds.has(leaf.view.toolUseId)) {
      missing.push(leaf.panelId);
    }
  });
  if (missing.length === 0) return workspace;

  let next = workspace;
  for (const panelId of missing) next = closeToolPanel(next, panelId);
  return next;
}

export function toolIdsInWorkspace(
  workspace: ToolWorkspace,
): readonly ToolUseId[] {
  const ids: ToolUseId[] = [];
  workspace.tree.visitLeaves((leaf) => {
    if (leaf.view.kind === "tool") ids.push(leaf.view.toolUseId);
  });
  return ids;
}
