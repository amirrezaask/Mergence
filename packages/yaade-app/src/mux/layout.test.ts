import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildTabsView, panelTabIds, YaadePanelTree } from "@yaade/workspace"
import {
  buildTerminalOnlyDisplayTree,
  emptyMuxTree,
  listEditorBufferTabIds,
  listPaneLeaves,
  listTerminalLeaves,
  muxLeafKind,
  paneView,
  placeOrPushEditorTab,
  placePtyInTree,
} from "./layout.js"
import { placeToolPane } from "./place-pane.js"
import { MUX_TOOL_PANES, muxToolPane } from "./tool-pane.js"

describe("muxLeafKind — file editor tabs", () => {
  it("recognizes file uris as editor", () => {
    assert.equal(muxLeafKind("file:///tmp/a.ts"), "editor")
    assert.equal(muxLeafKind("untitled:1"), "editor")
    assert.equal(muxLeafKind("yaade:editor:pane-1"), "editor")
  })
})

describe("persistent mux tool panes", () => {
  it("recognizes every stable tool id without treating it as an editor", () => {
    for (const tool of MUX_TOOL_PANES) {
      assert.equal(muxLeafKind(tool.tabId), "tool", tool.kind)
    }
  })

  it("places Explorer as a singleton and focuses the existing leaf", () => {
    const tree = emptyMuxTree()
    const terminal = placePtyInTree(tree, "yaade:terminal:s1", null)
    const live = {
      id: "window-1",
      title: "Workspace",
      tree,
      focusedPaneId: terminal,
      zoomedPaneId: null,
    }
    const explorer = muxToolPane("explorer")
    const opened = placeToolPane(live, explorer)
    assert.notEqual(opened.focusedPaneId?.id, terminal.id)
    assert.equal(listPaneLeaves(opened.tree).length, 2)
    assert.deepEqual(
      listPaneLeaves(opened.tree).find(leaf => leaf.kind === "tool"),
      {
        panelId: opened.focusedPaneId,
        ptyTabId: explorer.tabId,
        kind: "tool",
        toolKind: "explorer",
      },
    )

    const reopened = placeToolPane(
      { ...opened, focusedPaneId: terminal },
      explorer,
    )
    assert.equal(reopened.focusedPaneId?.id, opened.focusedPaneId?.id)
    assert.equal(listPaneLeaves(reopened.tree).length, 2)
  })

  it("survives panel-tree serialization with its split", () => {
    const tree = emptyMuxTree()
    const terminal = placePtyInTree(tree, "yaade:terminal:s1", null)
    placePtyInTree(tree, muxToolPane("explorer").tabId, terminal, "bottom")
    const restored = YaadePanelTree.jetFromJSON(tree.toJSON())
    const leaves = listPaneLeaves(restored)
    assert.equal(leaves.length, 2)
    assert.equal(
      leaves.find(leaf => leaf.kind === "tool")?.toolKind,
      "explorer",
    )
    assert.equal(restored.root.kind, "column")
  })
})

describe("placeOrPushEditorTab", () => {
  it("pushes a second file into the focused editor pane", () => {
    const tree = emptyMuxTree()
    const term = placePtyInTree(tree, "yaade:terminal:s1", null)
    const editor = placeOrPushEditorTab(tree, "file:///a.ts", term)
    assert.notEqual(editor.id, term.id)
    const again = placeOrPushEditorTab(tree, "file:///b.ts", editor)
    assert.equal(again.id, editor.id)
    const view = tree.getView(editor)
    assert.ok(view && view.kind === "tabs")
    assert.deepEqual(panelTabIds(view).sort(), [
      "file:///a.ts",
      "file:///b.ts",
    ])
    assert.equal(view.activeTabId, "file:///b.ts")
  })

  it("activates an existing tab instead of duplicating", () => {
    const tree = emptyMuxTree()
    const editor = placeOrPushEditorTab(tree, "file:///a.ts", null)
    placeOrPushEditorTab(tree, "file:///b.ts", editor)
    placeOrPushEditorTab(tree, "file:///a.ts", editor)
    const view = tree.getView(editor)
    assert.ok(view && view.kind === "tabs")
    assert.equal(panelTabIds(view).length, 2)
    assert.equal(view.activeTabId, "file:///a.ts")
  })

  it("treats .. and encoded URI variants as the same file", () => {
    const tree = emptyMuxTree()
    const editor = placeOrPushEditorTab(
      tree,
      "file:///Users/proj/src/foo.ts",
      null,
    )
    const again = placeOrPushEditorTab(
      tree,
      "file:///Users/proj/src/../src/foo.ts",
      editor,
    )
    assert.equal(again.id, editor.id)
    const view = tree.getView(editor)
    assert.ok(view && view.kind === "tabs")
    assert.equal(panelTabIds(view).length, 1)
    assert.equal(view.activeTabId, "file:///Users/proj/src/foo.ts")
  })

  it("forceNewGroup always splits a new editor pane", () => {
    const tree = emptyMuxTree()
    const first = placeOrPushEditorTab(tree, "file:///a.ts", null)
    const second = placeOrPushEditorTab(tree, "file:///b.ts", first, "right", {
      forceNewGroup: true,
    })
    assert.notEqual(second.id, first.id)
    assert.deepEqual(panelTabIds(tree.getView(first)!), ["file:///a.ts"])
    assert.deepEqual(panelTabIds(tree.getView(second)!), ["file:///b.ts"])
  })

  it("paneView still builds a single-tab view", () => {
    const view = paneView("file:///x.ts")
    assert.deepEqual(view, buildTabsView("file:///x.ts", ["file:///x.ts"]))
  })
})

describe("YaadePanelTree smoke", () => {
  it("findEditorPanelForFile sees file tabs", () => {
    const tree = emptyMuxTree()
    const panel = placeOrPushEditorTab(tree, "file:///z.ts", null)
    assert.equal(tree.findEditorPanelForFile("file:///z.ts")?.id, panel.id)
  })
})

describe("project surface helpers", () => {
  it("buildTerminalOnlyDisplayTree keeps only terminal leaves", () => {
    const tree = emptyMuxTree()
    const term = placePtyInTree(tree, "yaade:terminal:s1", null)
    placeOrPushEditorTab(tree, "file:///a.ts", term, "right")
    placePtyInTree(tree, "yaade:terminal:s2", term, "bottom")
    const display = buildTerminalOnlyDisplayTree(tree)
    const leaves = listPaneLeaves(display)
    assert.equal(leaves.length, 2)
    assert.ok(leaves.every(l => l.kind === "terminal"))
    assert.deepEqual(
      listTerminalLeaves(display)
        .map(l => l.ptyTabId)
        .sort(),
      ["yaade:terminal:s1", "yaade:terminal:s2"],
    )
    assert.deepEqual(
      leaves.map(leaf => leaf.panelId.id).sort(),
      listTerminalLeaves(tree).map(leaf => leaf.panelId.id).sort(),
    )
  })

  it("buildTerminalOnlyDisplayTree honors include filter", () => {
    const tree = emptyMuxTree()
    const shell = placePtyInTree(tree, "yaade:terminal:shell", null)
    placePtyInTree(tree, "yaade:terminal:other", shell, "right")
    const display = buildTerminalOnlyDisplayTree(
      tree,
      tabId => tabId !== "yaade:terminal:other",
    )
    assert.deepEqual(
      listTerminalLeaves(display).map(leaf => leaf.ptyTabId),
      ["yaade:terminal:shell"],
    )
  })

  it("buildTerminalOnlyDisplayTree keeps all terminal leaves by default", () => {
    const tree = emptyMuxTree()
    const shell = placePtyInTree(tree, "yaade:terminal:shell", null)
    placePtyInTree(tree, "yaade:terminal:agent", shell, "right")
    assert.deepEqual(
      listTerminalLeaves(buildTerminalOnlyDisplayTree(tree))
        .map(leaf => leaf.ptyTabId)
        .sort(),
      ["yaade:terminal:agent", "yaade:terminal:shell"],
    )
  })

  it("listEditorBufferTabIds unions buffers across editor groups", () => {
    const tree = emptyMuxTree()
    const first = placeOrPushEditorTab(tree, "file:///a.ts", null)
    placeOrPushEditorTab(tree, "file:///b.ts", first)
    placeOrPushEditorTab(tree, "file:///c.ts", first, "right", {
      forceNewGroup: true,
    })
    assert.deepEqual(listEditorBufferTabIds(tree).sort(), [
      "file:///a.ts",
      "file:///b.ts",
      "file:///c.ts",
    ])
  })
})
