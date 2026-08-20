import { describe, it } from "vite-plus/test"
import assert from "node:assert/strict"
import type { PanelNode } from "@yaade/panels"
import type { PanelView } from "@yaade/shared"
import { YaadePanelTree } from "./panel-tree.js"
import {
  activatePanelTab,
  buildTabsView,
  popPanelTab,
  pushPanelTab,
  reorderPanelTab,
} from "./panel-tabs.js"

function countLeaves(tree: YaadePanelTree): number {
  let count = 0
  const walk = (node: PanelNode<PanelView>) => {
    if (node.kind === "leaf") count++
    else node.split.children.forEach(walk)
  }
  walk(tree.root)
  return count
}

describe("panel tabs", () => {
  it("push appends new tab and activates without reordering", () => {
    const first = buildTabsView("file:///a", ["file:///a"])
    const second = pushPanelTab(first, "file:///b")
    assert.deepEqual(second.tabIds, ["file:///a", "file:///b"])
    assert.equal(second.activeTabId, "file:///b")
  })

  it("push activates existing tab without reordering or duplicate", () => {
    const view = buildTabsView("file:///a", ["file:///a", "file:///b"])
    const next = pushPanelTab(view, "file:///b")
    assert.deepEqual(next.tabIds, ["file:///a", "file:///b"])
    assert.equal(next.activeTabId, "file:///b")
  })

  it("push collapses file URI path variants", () => {
    const view = buildTabsView("file:///Users/p/src/a.ts", [
      "file:///Users/p/src/a.ts",
    ])
    const next = pushPanelTab(view, "file:///Users/p/src/../src/a.ts")
    assert.equal(next.tabIds.length, 1)
    assert.equal(next.activeTabId, "file:///Users/p/src/a.ts")
  })

  it("activate changes active tab without reordering", () => {
    const view = buildTabsView("file:///a", ["file:///a", "file:///b", "file:///c"])
    const next = activatePanelTab(view, "file:///c")
    assert.deepEqual(next.tabIds, ["file:///a", "file:///b", "file:///c"])
    assert.equal(next.activeTabId, "file:///c")
  })

  it("pop reveals previous tab", () => {
    const view = buildTabsView("file:///b", ["file:///b", "file:///a"])
    const next = popPanelTab(view, "file:///b")
    assert.equal(next.kind, "tabs")
    if (next.kind === "tabs") {
      assert.equal(next.activeTabId, "file:///a")
      assert.deepEqual(next.tabIds, ["file:///a"])
    }
  })

  it("reorder preserves visual order without moving active tab to front", () => {
    const view = buildTabsView("file:///b", ["file:///b", "file:///a"])
    const next = reorderPanelTab(view, "file:///a", 0)
    assert.deepEqual(next.tabIds, ["file:///a", "file:///b"])
    assert.equal(next.activeTabId, "file:///b")
  })
  it("push stacks multiple terminal tabs with the same label", () => {
    const first = pushPanelTab(null, "yaade:terminal:session-a")
    const second = pushPanelTab(first, "yaade:terminal:session-b")
    assert.deepEqual(second.tabIds, [
      "yaade:terminal:session-a",
      "yaade:terminal:session-b",
    ])
    assert.equal(second.activeTabId, "yaade:terminal:session-b")
  })

  it("push does not collapse terminal ids via file-path equality", () => {
    const view = buildTabsView("yaade:terminal:a", ["yaade:terminal:a"])
    const next = pushPanelTab(view, "yaade:terminal:b")
    assert.deepEqual(next.tabIds, ["yaade:terminal:a", "yaade:terminal:b"])
  })
})

describe("YaadePanelTree tab stacks", () => {
  it("findEditorPanelForFile matches hidden tabs", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    tree.setView(editorPanel, buildTabsView("file:///b", ["file:///b", "file:///a"]))
    assert.equal(tree.findEditorPanelForFile("file:///a")?.id, editorPanel.id)
  })

  it("pruneEmptyLeaves collapses extra empty leaf", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    const splitPanel = tree.splitAtEdge(editorPanel, "right")
    tree.setView(editorPanel, { kind: "empty" })
    tree.setView(splitPanel, buildTabsView("file:///x", ["file:///x"]))
    tree.pruneEmptyLeaves()
    assert.equal(countLeaves(tree), 1)
    assert.notEqual(tree.findEditorPanelForFile("file:///x"), null)
  })
})
