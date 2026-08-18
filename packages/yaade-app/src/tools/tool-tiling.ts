import { Schema } from "effect";
import {
  PanelTree,
  type PanelNode,
  type PanelTreeOptions,
  type PanelTreeSnapshot,
} from "@yaade/panels";
import { panelId, type DropAction, type PanelId } from "@yaade/shared";
import { ToolUseId } from "@yaade/rpc";

/** Maximum number of simultaneously rendered ToolUse panes in one Window. */
export const MAX_TOOL_TILES = 6;

/** A Window leaf is either available or owns exactly one ToolUse. */
export type ToolPaneView =
  | { readonly kind: "empty" }
  | { readonly kind: "tool"; readonly toolUseId: ToolUseId };

export type ToolWorkspace = {
  readonly tree: PanelTree<ToolPaneView>;
  readonly focusedPanelId: PanelId;
  /** Temporary presentation state; zoom never changes the persisted split tree. */
  readonly zoomedPanelId: PanelId | null;
};

const TOOL_PANE_OPTIONS: PanelTreeOptions<ToolPaneView> = {
  emptyView: () => ({ kind: "empty" }),
  isEmpty: view => view.kind === "empty",
};

function firstPanel(tree: PanelTree<ToolPaneView>): PanelId {
  if (tree.root.kind === "leaf") return tree.root.panelId;
  let first: PanelId | undefined;
  tree.visitLeaves(leaf => {
    first ??= leaf.panelId;
  });
  return first ?? tree.allocPanelId();
}

function panelExists(tree: PanelTree<ToolPaneView>, panelId: PanelId): boolean {
  return tree.getLeaf(panelId) != null;
}

export function toolPaneCount(workspace: ToolWorkspace): number {
  let count = 0;
  workspace.tree.visitLeaves(() => {
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
    view => view.kind === "tool" && view.toolUseId === toolUseId,
  );
}

function removeToolPanel(
  tree: PanelTree<ToolPaneView>,
  panelId: PanelId,
): void {
  if (tree.getLeaf(panelId) == null) return;
  let count = 0;
  tree.visitLeaves(() => {
    count += 1;
  });
  if (count === 1) tree.setView(panelId, { kind: "empty" });
  else tree.closePanel(panelId);
}

export function createToolWorkspace(): ToolWorkspace {
  const tree = new PanelTree(TOOL_PANE_OPTIONS);
  return {
    tree,
    focusedPanelId: firstPanel(tree),
    zoomedPanelId: null,
  };
}

/**
 * Focus an existing ToolUse, fill an empty pane, or split the focused pane.
 * It never replaces an occupied pane and never groups multiple tools in a leaf.
 */
export function openToolView(
  workspace: ToolWorkspace,
  toolUseId: ToolUseId,
): ToolWorkspace {
  const existing = findToolPanel(workspace.tree, toolUseId);
  if (existing) return focusToolPanel(workspace, existing);

  const tree = workspace.tree.clone();
  const target = resolvedFocus(tree, workspace.focusedPanelId);
  const targetView = tree.getView(target);
  if (!targetView || targetView.kind === "empty") {
    tree.setView(target, { kind: "tool", toolUseId });
    return { tree, focusedPanelId: target, zoomedPanelId: null };
  }
  if (toolPaneCount(workspace) >= MAX_TOOL_TILES) return workspace;

  const created = tree.splitAtEdge(target, "right");
  tree.setView(created, { kind: "tool", toolUseId });
  return { tree, focusedPanelId: created, zoomedPanelId: null };
}

/** Open a ToolUse in a known empty pane, falling back to normal placement. */
export function openToolViewInPanel(
  workspace: ToolWorkspace,
  panelId: PanelId,
  toolUseId: ToolUseId,
): ToolWorkspace {
  const existing = findToolPanel(workspace.tree, toolUseId);
  if (existing) return focusToolPanel(workspace, existing);
  if (!panelExists(workspace.tree, panelId)) {
    return openToolView(workspace, toolUseId);
  }

  const targetView = workspace.tree.getView(panelId);
  if (targetView?.kind !== "empty") {
    return openToolView(workspace, toolUseId);
  }

  const tree = workspace.tree.clone();
  tree.setView(panelId, { kind: "tool", toolUseId });
  return { tree, focusedPanelId: panelId, zoomedPanelId: null };
}

export function focusToolPanel(
  workspace: ToolWorkspace,
  panelId: PanelId,
): ToolWorkspace {
  if (!panelExists(workspace.tree, panelId)) return workspace;
  if (
    workspace.focusedPanelId.id === panelId.id &&
    workspace.zoomedPanelId == null
  ) {
    return workspace;
  }
  return {
    ...workspace,
    focusedPanelId: panelId,
    zoomedPanelId: null,
  };
}

/** Compatibility alias while callers migrate from pane-local tabs. */
export function activateToolTab(
  workspace: ToolWorkspace,
  panelId: PanelId,
  toolUseId: ToolUseId,
): ToolWorkspace {
  const view = workspace.tree.getView(panelId);
  if (view?.kind !== "tool" || view.toolUseId !== toolUseId) return workspace;
  return focusToolPanel(workspace, panelId);
}

/** A one-tool pane has no local tab order. */
export function reorderToolTabs(
  workspace: ToolWorkspace,
  _panelId: PanelId,
  _toolUseId: ToolUseId,
  _toIndex: number,
): ToolWorkspace {
  return workspace;
}

export function splitToolPanel(
  workspace: ToolWorkspace,
  panelId: PanelId,
  edge: "right" | "bottom",
): ToolWorkspace {
  if (!panelExists(workspace.tree, panelId)) return workspace;
  if (toolPaneCount(workspace) >= MAX_TOOL_TILES) return workspace;
  const tree = workspace.tree.clone();
  const created = tree.splitAtEdge(panelId, edge);
  return { tree, focusedPanelId: created, zoomedPanelId: null };
}

/** Toggle a temporary full-workspace view for one pane. */
export function toggleToolPanelZoom(
  workspace: ToolWorkspace,
  panelId: PanelId,
): ToolWorkspace {
  if (!panelExists(workspace.tree, panelId) || toolPaneCount(workspace) < 2) {
    return workspace;
  }
  return {
    ...workspace,
    focusedPanelId: panelId,
    zoomedPanelId:
      workspace.zoomedPanelId?.id === panelId.id ? null : panelId,
  };
}

/** Close a pane without archiving its ToolUse. */
export function closeToolPanel(
  workspace: ToolWorkspace,
  panelId: PanelId,
): ToolWorkspace {
  if (!panelExists(workspace.tree, panelId)) return workspace;
  const tree = workspace.tree.clone();
  removeToolPanel(tree, panelId);
  return {
    tree,
    focusedPanelId: resolvedFocus(tree, workspace.focusedPanelId),
    zoomedPanelId:
      workspace.zoomedPanelId?.id === panelId.id
        ? null
        : workspace.zoomedPanelId,
  };
}

/** Close the pane containing a ToolUse without archiving the host ToolUse. */
export function closeToolTab(
  workspace: ToolWorkspace,
  panelId: PanelId,
  toolUseId: ToolUseId,
): ToolWorkspace {
  const view = workspace.tree.getView(panelId);
  if (view?.kind !== "tool" || view.toolUseId !== toolUseId) return workspace;
  return closeToolPanel(workspace, panelId);
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

/** Move one ToolUse pane or split it beside another pane. */
export function dockToolView(
  workspace: ToolWorkspace,
  toolUseId: ToolUseId,
  target: PanelId,
  action: DropAction,
): ToolWorkspace {
  if (!panelExists(workspace.tree, target)) return workspace;
  const source = findToolPanel(workspace.tree, toolUseId);
  const split = action.kind === "split" && action.edge !== "center";
  if (source?.id === target.id) return focusToolPanel(workspace, target);

  const tree = workspace.tree.clone();
  const targetView = tree.getView(target);

  if (split) {
    if (!source && toolPaneCount(workspace) >= MAX_TOOL_TILES) return workspace;
    if (source) removeToolPanel(tree, source);
    if (!panelExists(tree, target)) return workspace;
    const created = tree.splitAtEdge(target, action.edge);
    tree.setView(created, { kind: "tool", toolUseId });
    return { tree, focusedPanelId: created, zoomedPanelId: null };
  }

  if (source) {
    const sourceView = tree.getView(source);
    if (targetView?.kind === "tool" && sourceView?.kind === "tool") {
      // Center-drop swaps the two panes so neither ToolUse becomes hidden.
      tree.setView(source, targetView);
      tree.setView(target, sourceView);
    } else {
      tree.setView(target, { kind: "tool", toolUseId });
      removeToolPanel(tree, source);
    }
    return { tree, focusedPanelId: target, zoomedPanelId: null };
  }

  if (targetView?.kind === "empty") {
    tree.setView(target, { kind: "tool", toolUseId });
    return { tree, focusedPanelId: target, zoomedPanelId: null };
  }

  if (toolPaneCount(workspace) >= MAX_TOOL_TILES) return workspace;
  const created = tree.splitAtEdge(target, "right");
  tree.setView(created, { kind: "tool", toolUseId });
  return { tree, focusedPanelId: created, zoomedPanelId: null };
}

export function removeMissingToolViews(
  workspace: ToolWorkspace,
  liveToolUseIds: ReadonlySet<ToolUseId>,
): ToolWorkspace {
  const missing: Array<{ panelId: PanelId; toolUseId: ToolUseId }> = [];
  workspace.tree.visitLeaves(leaf => {
    if (
      leaf.view.kind === "tool" &&
      !liveToolUseIds.has(leaf.view.toolUseId)
    ) {
      missing.push({ panelId: leaf.panelId, toolUseId: leaf.view.toolUseId });
    }
  });
  let next = workspace;
  for (const item of missing) {
    next = closeToolTab(next, item.panelId, item.toolUseId);
  }
  return next;
}

export function toolIdsInWorkspace(
  workspace: ToolWorkspace,
): readonly ToolUseId[] {
  const ids: ToolUseId[] = [];
  workspace.tree.visitLeaves(leaf => {
    if (leaf.view.kind === "tool") ids.push(leaf.view.toolUseId);
  });
  return ids;
}

type PersistedToolWorkspace = {
  readonly version: 1;
  readonly tree: PanelTreeSnapshot<ToolPaneView>;
  readonly focusedPanelId: number;
  readonly zoomedPanelId: number | null;
};

type PersistedPaneView =
  | { readonly kind: "empty" }
  | { readonly kind: "tool"; readonly toolUseId: ToolUseId };

type PersistedPanelNode =
  | {
      readonly kind: "leaf";
      readonly panelId: { readonly id: number };
      readonly view: PersistedPaneView;
    }
  | {
      readonly kind: "row" | "column";
      readonly split: {
        readonly children: readonly PersistedPanelNode[];
        readonly ratios: readonly number[];
      };
    };

type PersistedPanelNodeEncoded =
  | {
      readonly kind: "leaf";
      readonly panelId: { readonly id: number };
      readonly view:
        | { readonly kind: "empty" }
        | { readonly kind: "tool"; readonly toolUseId: string };
    }
  | {
      readonly kind: "row" | "column";
      readonly split: {
        readonly children: readonly PersistedPanelNodeEncoded[];
        readonly ratios: readonly number[];
      };
    };

const PositiveInteger = Schema.Number.pipe(
  Schema.filter(value => Number.isSafeInteger(value) && value > 0),
);
const PositiveRatio = Schema.Number.pipe(
  Schema.filter(value => Number.isFinite(value) && value > 0),
);
const PersistedPaneViewSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("empty") }),
  Schema.Struct({ kind: Schema.Literal("tool"), toolUseId: ToolUseId }),
);
const PersistedPanelNodeSchema: Schema.Schema<
  PersistedPanelNode,
  PersistedPanelNodeEncoded
> = Schema.suspend(
  () =>
    Schema.Union(
      Schema.Struct({
        kind: Schema.Literal("leaf"),
        panelId: Schema.Struct({ id: PositiveInteger }),
        view: PersistedPaneViewSchema,
      }),
      Schema.Struct({
        kind: Schema.Literal("row", "column"),
        split: Schema.Struct({
          children: Schema.Array(PersistedPanelNodeSchema).pipe(
            Schema.minItems(2),
          ),
          ratios: Schema.Array(PositiveRatio).pipe(Schema.minItems(2)),
        }),
      }),
    ),
);
const PersistedToolWorkspaceSchema = Schema.Struct({
  version: Schema.Literal(1),
  tree: Schema.Struct({
    root: PersistedPanelNodeSchema,
    nextPanelId: PositiveInteger,
  }),
  focusedPanelId: PositiveInteger,
  zoomedPanelId: Schema.Union(PositiveInteger, Schema.Null),
});

function runtimePanelNode(
  node: PersistedPanelNode,
): PanelNode<ToolPaneView> | null {
  if (node.kind === "leaf") {
    return {
      kind: "leaf",
      panelId: panelId(node.panelId.id),
      view: node.view,
    };
  }
  if (node.split.children.length !== node.split.ratios.length) return null;
  const ratioSum = node.split.ratios.reduce((sum, ratio) => sum + ratio, 0);
  if (!Number.isFinite(ratioSum) || ratioSum <= 0) return null;
  const children: PanelNode<ToolPaneView>[] = [];
  for (const child of node.split.children) {
    const parsed = runtimePanelNode(child);
    if (!parsed) return null;
    children.push(parsed);
  }
  return {
    kind: node.kind,
    split: {
      children,
      ratios: node.split.ratios.map(ratio => ratio / ratioSum),
    },
  };
}

function parseToolWorkspace(layoutJson: string | undefined): ToolWorkspace | null {
  if (!layoutJson) return null;
  try {
    const decoded = Schema.decodeUnknownSync(PersistedToolWorkspaceSchema)(
      JSON.parse(layoutJson),
    );
    const root = runtimePanelNode(decoded.tree.root);
    if (!root) return null;
    const tree = PanelTree.fromJSON(TOOL_PANE_OPTIONS, {
      root,
      nextPanelId: decoded.tree.nextPanelId,
    });
    const focusedPanelId = panelId(decoded.focusedPanelId);
    if (!panelExists(tree, focusedPanelId)) return null;
    const zoomedPanelId = decoded.zoomedPanelId === null
      ? null
      : panelId(decoded.zoomedPanelId);
    return {
      tree,
      focusedPanelId,
      zoomedPanelId:
        zoomedPanelId && panelExists(tree, zoomedPanelId)
          ? zoomedPanelId
          : null,
    };
  } catch {
    return null;
  }
}

/** Decode a persisted Window, discard stale ToolUses, and place new tools. */
function capRestoredToolPanes(workspace: ToolWorkspace): ToolWorkspace {
  let next = workspace;
  while (toolPaneCount(next) > MAX_TOOL_TILES) {
    const leaves: PanelId[] = [];
    next.tree.visitLeaves(leaf => leaves.push(leaf.panelId));
    const empty = leaves.find(panel => next.tree.getView(panel)?.kind === "empty");
    const panel = empty ?? leaves.at(-1);
    if (!panel) break;
    next = closeToolPanel(next, panel);
  }
  return next;
}

export function restoreToolWorkspace(
  layoutJson: string | undefined,
  liveToolUseIds: readonly ToolUseId[],
): ToolWorkspace {
  const live = new Set(liveToolUseIds);
  let workspace = parseToolWorkspace(layoutJson) ?? createToolWorkspace();
  workspace = capRestoredToolPanes(removeMissingToolViews(workspace, live));
  const open = new Set(toolIdsInWorkspace(workspace));
  for (const toolUseId of liveToolUseIds) {
    if (open.has(toolUseId)) continue;
    const next = openToolView(workspace, toolUseId);
    if (next === workspace) break;
    workspace = next;
    open.add(toolUseId);
  }
  return workspace;
}

export function serializeToolWorkspace(workspace: ToolWorkspace): string {
  const persisted: PersistedToolWorkspace = {
    version: 1,
    tree: workspace.tree.toJSON(),
    focusedPanelId: workspace.focusedPanelId.id,
    zoomedPanelId: workspace.zoomedPanelId?.id ?? null,
  };
  return JSON.stringify(persisted);
}
