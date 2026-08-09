import type { DropAction, Edge, PanelId, PanelView } from "@yaade/shared"
import { canonicalizeFileUri } from "@yaade/shared"
import {
  YaadePanelTree,
  activatePanelTab,
  buildTabsView,
  findPanelWithTab,
  findTabIdForFile,
  isEditorTabId,
  isGitTabId,
  isTerminalTabId,
  panelTabIds,
  popPanelTab,
  pushPanelTab,
} from "@yaade/workspace"
import { closePanelIfEmpty, getAllLeafPanels } from "../panel-routing.js"
import { muxToolKind, type MuxToolKind } from "./tool-pane.js"

export type MuxLeafKind = "terminal" | "git" | "editor" | "tool"

type MuxLeafBase = {
  panelId: PanelId
  /** Persistent mux leaf tab id (legacy field name kept for call-site churn). */
  ptyTabId: string
}

export type MuxLeaf =
  | (MuxLeafBase & { kind: Exclude<MuxLeafKind, "tool"> })
  | (MuxLeafBase & { kind: "tool"; toolKind: MuxToolKind })

/** One content tab per leaf panel. */
export function paneView(tabId: string): PanelView {
  return buildTabsView(tabId, [tabId])
}

export function muxLeafKind(tabId: string): MuxLeafKind | null {
  if (isTerminalTabId(tabId)) return "terminal"
  if (isGitTabId(tabId)) return "git"
  if (isEditorTabId(tabId)) return "editor"
  if (muxToolKind(tabId)) return "tool"
  return null
}

export function activeMuxTabInPanel(
  tree: YaadePanelTree,
  panelId: PanelId | null,
): string | null {
  if (!panelId) return null
  const view = tree.getView(panelId)
  if (!view || view.kind !== "tabs") return null
  const id = view.activeTabId
  return muxLeafKind(id) != null ? id : null
}

export function activePtyInPanel(
  tree: YaadePanelTree,
  panelId: PanelId | null,
): string | null {
  const id = activeMuxTabInPanel(tree, panelId)
  return id && isTerminalTabId(id) ? id : null
}

export function listPaneLeaves(tree: YaadePanelTree): MuxLeaf[] {
  const out: MuxLeaf[] = []
  for (const panelId of getAllLeafPanels(tree)) {
    const tabId = activeMuxTabInPanel(tree, panelId)
    if (!tabId) continue
    const kind = muxLeafKind(tabId)
    if (!kind) continue
    const toolKind = muxToolKind(tabId)
    if (kind === "tool") {
      if (!toolKind) continue
      out.push({ panelId, ptyTabId: tabId, kind, toolKind })
      continue
    }
    out.push({ panelId, ptyTabId: tabId, kind })
  }
  return out
}

export function listTerminalLeaves(tree: YaadePanelTree): MuxLeaf[] {
  return listPaneLeaves(tree).filter(l => l.kind === "terminal")
}

export function placeMuxLeafInTree(
  tree: YaadePanelTree,
  tabId: string,
  focused: PanelId | null,
  splitEdge: Edge = "right",
): PanelId {
  const existing = findPanelWithTab(tree, tabId)
  if (existing) {
    tree.setView(existing, paneView(tabId))
    return existing
  }

  const leaves = getAllLeafPanels(tree)
  const anchor =
    (focused && leaves.some(p => p.id === focused.id) ? focused : null) ??
    leaves[0] ??
    (tree.root.kind === "leaf" ? tree.root.panelId : tree.allocPanelId())

  const occupied = activeMuxTabInPanel(tree, anchor) != null
  const target = occupied ? tree.splitAtEdge(anchor, splitEdge) : anchor
  tree.setView(target, paneView(tabId))
  return target
}

/** @deprecated Name retained for terminal/git/editor call sites during migration. */
export const placePtyInTree = placeMuxLeafInTree

/**
 * Open a file buffer in an editor group: activate existing tab, push into the
 * focused editor pane, or create a new editor group (split when the anchor is
 * occupied by a terminal/git/other editor group).
 */
export function placeOrPushEditorTab(
  tree: YaadePanelTree,
  fileUri: string,
  focused: PanelId | null,
  splitEdge: Edge = "right",
  options?: { forceNewGroup?: boolean },
): PanelId {
  const uri = fileUri.startsWith("file://")
    ? canonicalizeFileUri(fileUri)
    : fileUri
  if (!options?.forceNewGroup) {
    const existingPanel = tree.findEditorPanelForFile(uri)
    if (existingPanel) {
      const view = tree.getView(existingPanel)
      if (view?.kind === "tabs") {
        const existingId = findTabIdForFile(view, uri)
        if (existingId && existingId !== uri) {
          // Normalize a URI-variant tab id to the canonical form.
          const tabIds = panelTabIds(view).map(id =>
            id === existingId ? uri : id,
          )
          tree.setView(existingPanel, buildTabsView(uri, tabIds))
        } else {
          tree.setView(
            existingPanel,
            activatePanelTab(view, existingId ?? uri),
          )
        }
      }
      return existingPanel
    }
  }

  const leaves = getAllLeafPanels(tree)
  const anchor =
    (focused && leaves.some(p => p.id === focused.id) ? focused : null) ??
    leaves[0] ??
    (tree.root.kind === "leaf" ? tree.root.panelId : tree.allocPanelId())

  if (!options?.forceNewGroup) {
    const active = activeMuxTabInPanel(tree, anchor)
    if (active && muxLeafKind(active) === "editor") {
      const view = tree.getView(anchor)
      tree.setView(anchor, pushPanelTab(view, uri))
      return anchor
    }
  }

  const occupied = activeMuxTabInPanel(tree, anchor) != null
  const target = occupied ? tree.splitAtEdge(anchor, splitEdge) : anchor
  tree.setView(target, paneView(uri))
  return target
}

/** Close every editor buffer tab in a panel (whole editor group). */
export function clearEditorTabsFromPanel(
  tree: YaadePanelTree,
  panelId: PanelId,
): void {
  const view = tree.getView(panelId)
  if (!view || view.kind !== "tabs") return
  let next: PanelView = view
  for (const tabId of [...panelTabIds(view)]) {
    if (!isEditorTabId(tabId)) continue
    if (next.kind !== "tabs") break
    next = popPanelTab(next, tabId)
  }
  tree.setView(panelId, next)
  closePanelIfEmpty(tree, panelId)
}

export function removePtyFromTree(
  tree: YaadePanelTree,
  panelId: PanelId,
  tabId: string,
): void {
  const view = tree.getView(panelId)
  if (!view || view.kind !== "tabs") return
  if (!panelTabIds(view).includes(tabId)) return
  tree.setView(panelId, popPanelTab(view, tabId))
  closePanelIfEmpty(tree, panelId)
}

export function emptyMuxTree(): YaadePanelTree {
  const { tree } = YaadePanelTree.editorOnlyLayout()
  return tree
}

/**
 * Display-only tree of terminal leaves for the Terminals project surface.
 * Panel ids differ from the source tree — map events back via tab id.
 */
export function buildTerminalOnlyDisplayTree(
  source: YaadePanelTree,
  include: (tabId: string) => boolean = () => true,
): YaadePanelTree {
  const tree = source.clone()
  const visiblePanels = new Set(
    listTerminalLeaves(source)
      .filter(leaf => include(leaf.ptyTabId))
      .map(leaf => leaf.panelId.id),
  )
  for (const panelId of getAllLeafPanels(source)) {
    if (!visiblePanels.has(panelId.id)) tree.closePanel(panelId)
  }
  return tree
}

/** Collect unique editor buffer tab ids across all editor groups. */
export function listEditorBufferTabIds(tree: YaadePanelTree): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const leaf of listPaneLeaves(tree)) {
    if (leaf.kind !== "editor") continue
    const view = tree.getView(leaf.panelId)
    if (!view || view.kind !== "tabs") continue
    for (const tabId of panelTabIds(view)) {
      if (!isEditorTabId(tabId) || seen.has(tabId)) continue
      seen.add(tabId)
      out.push(tabId)
    }
  }
  return out
}

/**
 * Place a PTY that is not in this window's tree (e.g. docking another window).
 * Edge → split; center → swap with target (displaced pane stays as a sibling split).
 */
export function placePtyFromOutside(
  tree: YaadePanelTree,
  tabId: string,
  target: PanelId,
  action: DropAction,
): PanelId {
  const existing = findPanelWithTab(tree, tabId)
  if (existing) {
    tree.setView(existing, paneView(tabId))
    return existing
  }

  if (action.kind === "split") {
    const created = tree.splitAtEdge(target, action.edge)
    tree.setView(created, paneView(tabId))
    return created
  }

  const targetTab = activeMuxTabInPanel(tree, target)
  tree.setView(target, paneView(tabId))
  if (targetTab && targetTab !== tabId) {
    const created = tree.splitAtEdge(target, "right")
    tree.setView(created, paneView(targetTab))
  }
  return target
}

/** Merge every leaf from a source window into `tree` at `target` / `action`. */
export function dockSourceLeavesIntoTree(
  tree: YaadePanelTree,
  leaves: { ptyTabId: string }[],
  target: PanelId,
  action: DropAction,
): PanelId {
  let focus = target
  for (let i = 0; i < leaves.length; i++) {
    const ptyTabId = leaves[i]!.ptyTabId
    if (i === 0) {
      focus = placePtyFromOutside(tree, ptyTabId, target, action)
    } else {
      focus = placePtyFromOutside(tree, ptyTabId, focus, {
        kind: "split",
        edge: "right",
      })
    }
  }
  return focus
}
