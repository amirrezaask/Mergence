import type { DropAction, PanelId, PanelView } from "@yaade/shared"
import {
  YaadePanelTree,
  buildTabsView,
  EXPLORER_TAB_ID,
  PROBLEMS_TAB_ID,
  findPanelWithTab,
  isEditorTabId,
  isGitTabId,
  isTerminalTabId,
  panelTabIds,
  popPanelTab,
  type WorkspaceService,
} from "@yaade/workspace"
import { TERMINAL_TAB_TYPE_ID } from "./tabs/terminal-session.js"
import { resolveTargetPanel, closePanelIfEmpty, getAllLeafPanels } from "./panel-routing.js"
import { terminalSessionForTab } from "./tabs/terminal-session.js"
/** Terminal, Git, editor, or persistent tool leaf participating in tile DnD. */
function isMuxPaneTabId(tabId: string): boolean {
  return (
    isTerminalTabId(tabId) ||
    isGitTabId(tabId) ||
    isEditorTabId(tabId) ||
    tabId === EXPLORER_TAB_ID ||
    tabId === PROBLEMS_TAB_ID ||
    tabId.startsWith("yaade:tool:")
  )
}

/** Panel view filtered to terminal session tabs only (for session window chrome). */
export function terminalOnlyView(view: PanelView | null): PanelView {
  if (!view || view.kind !== "tabs") return { kind: "empty" }
  const tabIds = panelTabIds(view).filter(isTerminalTabId)
  if (tabIds.length === 0) return { kind: "empty" }
  const activeTabId = tabIds.includes(view.activeTabId)
    ? view.activeTabId
    : tabIds[0]!
  return { kind: "tabs", activeTabId, tabIds }
}

export function activeTerminalTabInPanel(
  tree: YaadePanelTree,
  panelId: PanelId | null,
): string | null {
  if (!panelId) return null
  const view = terminalOnlyView(tree.getView(panelId))
  if (view.kind !== "tabs") return null
  return view.activeTabId
}

/** Active terminal, Git, or persistent tool tab in a leaf. */
export function activeMuxPaneTabInPanel(
  tree: YaadePanelTree,
  panelId: PanelId | null,
): string | null {
  if (!panelId) return null
  const view = tree.getView(panelId)
  if (!view || view.kind !== "tabs") return null
  return isMuxPaneTabId(view.activeTabId) ? view.activeTabId : null
}

function sessionLabel(
  workspace: WorkspaceService,
  tabId: string,
): string {
  const session = terminalSessionForTab(tabId)
  return (
    session?.customLabel ??
    session?.agentTitle ??
    workspace.tabRegistry.get(tabId)?.label ??
    "Terminal"
  )
}

/**
 * Place a session in the tiled layout: focus if already open; otherwise open in
 * an empty focused pane, or split the focused pane (tiling WM — one session per pane).
 */
export function openSessionInLayout(
  workspace: WorkspaceService,
  tree: YaadePanelTree,
  tabId: string,
  focused: PanelId | null,
  splitEdge: "left" | "right" | "top" | "bottom" = "right",
): { panelId: PanelId; tabId: string; created: boolean } {
  const existing = findPanelWithTab(tree, tabId)
  if (existing) {
    workspace.focusTabInPanel(tree, existing, tabId)
    return { panelId: existing, tabId, created: false }
  }

  const label = sessionLabel(workspace, tabId)

  const anchor =
    resolveTargetPanel(tree, focused) ??
    getAllLeafPanels(tree)[0] ??
    (tree.root.kind === "leaf" ? tree.root.panelId : tree.allocPanelId())

  const occupied = terminalOnlyView(tree.getView(anchor)).kind === "tabs"
  const target = occupied ? tree.splitAtEdge(anchor, splitEdge) : anchor

  const opened = workspace.openOrFocusTab(tree, target, {
    id: tabId,
    kind: TERMINAL_TAB_TYPE_ID,
    label,
  })
  return { panelId: opened.panelId, tabId: opened.tabId, created: true }
}

/**
 * 2A: remove session tab from the tiled layout without disposing the session.
 */
export function hideSessionFromLayout(
  tree: YaadePanelTree,
  panelId: PanelId,
  tabId: string,
): void {
  const view = tree.getView(panelId)
  if (view?.kind !== "tabs") return
  if (!panelTabIds(view).includes(tabId)) return
  tree.setView(panelId, popPanelTab(view, tabId))
  closePanelIfEmpty(tree, panelId)
}

/**
 * Move/split a session pane under one-session-per-pane rules.
 * Center / moveToPane swaps with the target pane (or fills an empty leaf).
 * Edge drops split as usual.
 */
export function applySessionPaneDrop(
  tree: YaadePanelTree,
  source: PanelId,
  sourceTabId: string,
  target: PanelId,
  action: DropAction,
): { moved: boolean; createdPanel: PanelId | null; focusPanel: PanelId } {
  // Editor leaves are multi-tab groups. Moving their active tab must preserve
  // every background tab in both groups, unlike the one-session swap below.
  if (isEditorTabId(sourceTabId)) {
    const targetView = tree.getView(target)
    if (
      action.kind === "moveToPane" &&
      targetView?.kind === "tabs" &&
      !isEditorTabId(targetView.activeTabId)
    ) {
      // Editor and terminal/git/tool tabs cannot share one mux leaf. Edge
      // drops remain available to place the editor beside a non-editor pane.
      return { moved: false, createdPanel: null, focusPanel: source }
    }
    const result = tree.applyTabDrop(
      source,
      sourceTabId,
      target,
      action,
    )
    return {
      ...result,
      focusPanel: result.moved ? (result.createdPanel ?? target) : source,
    }
  }
  if (!isMuxPaneTabId(sourceTabId)) {
    return { moved: false, createdPanel: null, focusPanel: source }
  }
  const sourceView = tree.getView(source)
  if (!sourceView || sourceView.kind !== "tabs") {
    return { moved: false, createdPanel: null, focusPanel: source }
  }
  if (!panelTabIds(sourceView).includes(sourceTabId)) {
    return { moved: false, createdPanel: null, focusPanel: source }
  }

  if (action.kind === "split") {
    const remaining = popPanelTab(sourceView, sourceTabId)
    tree.setView(source, remaining)
    const created = tree.splitAtEdge(target, action.edge)
    tree.setView(created, buildTabsView(sourceTabId, [sourceTabId]))
    closePanelIfEmpty(tree, source)
    tree.pruneEmptyLeaves()
    return { moved: true, createdPanel: created, focusPanel: created }
  }

  if (action.kind !== "moveToPane") {
    return { moved: false, createdPanel: null, focusPanel: source }
  }
  if (source.id === target.id) {
    return { moved: false, createdPanel: null, focusPanel: source }
  }

  const targetSession = activeMuxPaneTabInPanel(tree, target)
  tree.setView(source, popPanelTab(sourceView, sourceTabId))

  if (targetSession && targetSession !== sourceTabId) {
    // Swap: target pane moves into the source leaf.
    tree.setView(target, buildTabsView(sourceTabId, [sourceTabId]))
    tree.setView(source, buildTabsView(targetSession, [targetSession]))
  } else {
    tree.setView(target, buildTabsView(sourceTabId, [sourceTabId]))
    closePanelIfEmpty(tree, source)
  }
  tree.pruneEmptyLeaves()
  return { moved: true, createdPanel: null, focusPanel: target }
}

/**
 * Place a session that is not yet in the layout (sidebar drag) into a pane.
 * Edge → split; center → replace the target pane's session (leaves layout only).
 */
export function placeSessionFromOutside(
  workspace: WorkspaceService,
  tree: YaadePanelTree,
  tabId: string,
  target: PanelId,
  action: DropAction,
): { panelId: PanelId; tabId: string } {
  const label = sessionLabel(workspace, tabId)
  let panelId = target

  if (action.kind === "split") {
    panelId = tree.splitAtEdge(target, action.edge)
  } else {
    // One session per pane: center drop replaces the tiled session.
    tree.setView(target, { kind: "empty" })
  }

  return workspace.openOrFocusTab(tree, panelId, {
    id: tabId,
    kind: TERMINAL_TAB_TYPE_ID,
    label,
  })
}
