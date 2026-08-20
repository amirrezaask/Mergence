import { describe, it } from "vite-plus/test"
import assert from "node:assert/strict"
import { YaadePanelTree } from "./panel-tree.js"
import { buildTabsView, panelTabIds } from "./panel-tabs.js"
import { EXPLORER_TAB_ID } from "./tab-registry.js"

function tabs(view: ReturnType<YaadePanelTree["getView"]>) {
  if (view?.kind !== "tabs") throw new Error("expected tabs view")
  return view
}

describe("YaadePanelTree — layouts", () => {
  it("editorOnlyLayout yields one empty leaf", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    assert.equal(tree.getView(editorPanel)?.kind, "empty")
    assert.equal(tree.root.kind, "leaf")
  })

  it("workspaceLayout splits sidebar+editor left/right", () => {
    const { tree, sidebarPanel, editorPanel } = YaadePanelTree.workspaceLayout()
    assert.notEqual(sidebarPanel.id, editorPanel.id)
    assert.equal(tree.root.kind, "row")
    if (tree.root.kind === "row") {
      const [first, second] = tree.root.split.children
      assert.equal(first?.kind, "leaf")
      assert.equal(second?.kind, "leaf")
      if (first?.kind === "leaf") assert.equal(first.panelId.id, sidebarPanel.id)
      if (second?.kind === "leaf") assert.equal(second.panelId.id, editorPanel.id)
    }
  })
})

describe("YaadePanelTree — findEditorPanelForFile", () => {
  it("matches active tab", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    tree.setView(editorPanel, buildTabsView("file:///a.ts", ["file:///a.ts"]))
    assert.equal(tree.findEditorPanelForFile("file:///a.ts")?.id, editorPanel.id)
  })

  it("matches inactive tab in stack", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    tree.setView(editorPanel, buildTabsView("file:///b.ts", ["file:///b.ts", "file:///a.ts"]))
    assert.equal(tree.findEditorPanelForFile("file:///a.ts")?.id, editorPanel.id)
  })

  it("returns null when uri not present", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    tree.setView(editorPanel, buildTabsView("file:///a.ts", ["file:///a.ts"]))
    assert.equal(tree.findEditorPanelForFile("file:///missing.ts"), null)
  })

  it("finds panel across splits", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    const right = tree.splitAtEdge(editorPanel, "right")
    tree.setView(right, buildTabsView("file:///z.ts", ["file:///z.ts"]))
    assert.equal(tree.findEditorPanelForFile("file:///z.ts")?.id, right.id)
  })
})

describe("YaadePanelTree — normalizeTabViews", () => {
  it("populates tabIds when missing", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    tree.setView(editorPanel, { kind: "tabs", activeTabId: "file:///a.ts", tabIds: [] })
    tree.normalizeTabViews()
    const view = tabs(tree.getView(editorPanel))
    assert.deepEqual(panelTabIds(view), ["file:///a.ts"])
  })

  it("normalizeTabViews preserves tab order", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    tree.setView(editorPanel, {
      kind: "tabs",
      activeTabId: "file:///b.ts",
      tabIds: ["file:///a.ts", "file:///b.ts"],
    })
    tree.normalizeTabViews()
    const view = tabs(tree.getView(editorPanel))
    assert.deepEqual(panelTabIds(view), ["file:///a.ts", "file:///b.ts"])
  })
})

describe("YaadePanelTree — applyTabDrop", () => {
  it("clone preserves YaadePanelTree drop behavior and panel ids", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    const right = tree.splitAtEdge(editorPanel, "right")
    tree.setView(editorPanel, buildTabsView("file:///a.ts", ["file:///a.ts"]))

    const clone = tree.clone()
    const res = clone.applyTabDrop(editorPanel, "file:///a.ts", right, {
      kind: "split",
      edge: "bottom",
    })

    assert.equal(res.moved, true)
    assert.equal(res.createdPanel?.id, 3)
  })

  it("moveToPane merges tab into target stack and removes from source", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    const right = tree.splitAtEdge(editorPanel, "right")
    tree.setView(editorPanel, buildTabsView("file:///a.ts", ["file:///a.ts", "file:///b.ts"]))
    tree.setView(right, buildTabsView("file:///c.ts", ["file:///c.ts"]))

    const res = tree.applyTabDrop(editorPanel, "file:///b.ts", right, { kind: "moveToPane" })
    assert.equal(res.moved, true)
    assert.equal(res.createdPanel, null)

    const src = tabs(tree.getView(editorPanel))
    assert.deepEqual(panelTabIds(src), ["file:///a.ts"])
    assert.equal(src.activeTabId, "file:///a.ts")

    const tgt = tabs(tree.getView(right))
    assert.deepEqual(panelTabIds(tgt), ["file:///c.ts", "file:///b.ts"])
    assert.equal(tgt.activeTabId, "file:///b.ts")
  })

  it("moveToPane with insertIndex splices at tab-bar position", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    const right = tree.splitAtEdge(editorPanel, "right")
    tree.setView(editorPanel, buildTabsView("file:///a.ts", ["file:///a.ts", "file:///b.ts"]))
    tree.setView(
      right,
      buildTabsView("file:///c.ts", ["file:///c.ts", "file:///d.ts", "file:///e.ts"]),
    )

    const res = tree.applyTabDrop(editorPanel, "file:///b.ts", right, {
      kind: "moveToPane",
      insertIndex: 1,
    })
    assert.equal(res.moved, true)
    const tgt = tabs(tree.getView(right))
    assert.deepEqual(panelTabIds(tgt), ["file:///c.ts", "file:///b.ts", "file:///d.ts", "file:///e.ts"])
    assert.equal(tgt.activeTabId, "file:///b.ts")
  })

  it("moveToPane onto empty target promotes target to tabs view", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    const right = tree.splitAtEdge(editorPanel, "right")
    tree.setView(editorPanel, buildTabsView("file:///a.ts", ["file:///a.ts", "file:///b.ts"]))

    const res = tree.applyTabDrop(editorPanel, "file:///b.ts", right, { kind: "moveToPane" })
    assert.equal(res.moved, true)
    const tgt = tabs(tree.getView(right))
    assert.deepEqual(panelTabIds(tgt), ["file:///b.ts"])
  })

  it("moveToPane onto same panel is no-op", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    tree.setView(editorPanel, buildTabsView("file:///a.ts", ["file:///a.ts", "file:///b.ts"]))
    const res = tree.applyTabDrop(editorPanel, "file:///b.ts", editorPanel, { kind: "moveToPane" })
    assert.equal(res.moved, false)
    const v = tabs(tree.getView(editorPanel))
    assert.deepEqual(panelTabIds(v), ["file:///a.ts", "file:///b.ts"])
  })

  it("split(edge) pops tab into new pane on that edge of target", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    tree.setView(editorPanel, buildTabsView("file:///a.ts", ["file:///a.ts", "file:///b.ts"]))
    const res = tree.applyTabDrop(editorPanel, "file:///b.ts", editorPanel, {
      kind: "split",
      edge: "right",
    })
    assert.equal(res.moved, true)
    assert.ok(res.createdPanel)
    assert.equal(tree.root.kind, "row")
    const src = tabs(tree.getView(editorPanel))
    assert.deepEqual(panelTabIds(src), ["file:///a.ts"])
    const created = tabs(tree.getView(res.createdPanel!))
    assert.deepEqual(panelTabIds(created), ["file:///b.ts"])
  })

  it("split from other-panel drop creates new leaf next to target", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    const right = tree.splitAtEdge(editorPanel, "right")
    tree.setView(editorPanel, buildTabsView("file:///a.ts", ["file:///a.ts", "file:///b.ts"]))
    tree.setView(right, buildTabsView("file:///c.ts", ["file:///c.ts"]))

    const res = tree.applyTabDrop(editorPanel, "file:///b.ts", right, {
      kind: "split",
      edge: "bottom",
    })
    assert.equal(res.moved, true)
    assert.ok(res.createdPanel)
    const created = tabs(tree.getView(res.createdPanel!))
    assert.deepEqual(panelTabIds(created), ["file:///b.ts"])
    const src = tabs(tree.getView(editorPanel))
    assert.deepEqual(panelTabIds(src), ["file:///a.ts"])
  })

  it("moving last tab collapses source to empty then prunes", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    const right = tree.splitAtEdge(editorPanel, "right")
    tree.setView(editorPanel, buildTabsView("file:///a.ts", ["file:///a.ts"]))
    tree.setView(right, buildTabsView("file:///c.ts", ["file:///c.ts"]))

    const res = tree.applyTabDrop(editorPanel, "file:///a.ts", right, { kind: "moveToPane" })
    assert.equal(res.moved, true)
    assert.equal(tree.root.kind, "leaf")
    if (tree.root.kind === "leaf") {
      assert.equal(tree.root.panelId.id, right.id)
    }
    const tgt = tabs(tree.getView(right))
    assert.deepEqual(panelTabIds(tgt), ["file:///c.ts", "file:///a.ts"])
    assert.equal(tgt.activeTabId, "file:///a.ts")
  })

  it("missing sourceUri returns moved=false with no state change", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    const right = tree.splitAtEdge(editorPanel, "right")
    tree.setView(editorPanel, buildTabsView("file:///a.ts", ["file:///a.ts"]))
    tree.setView(right, buildTabsView("file:///c.ts", ["file:///c.ts"]))

    const res = tree.applyTabDrop(editorPanel, "file:///missing.ts", right, { kind: "moveToPane" })
    assert.equal(res.moved, false)
    const src = tabs(tree.getView(editorPanel))
    assert.deepEqual(panelTabIds(src), ["file:///a.ts"])
  })

  it("explorer tab moves as a single tab", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    const right = tree.splitAtEdge(editorPanel, "right")
    tree.setView(editorPanel, buildTabsView(EXPLORER_TAB_ID, [EXPLORER_TAB_ID]))
    tree.setView(right, buildTabsView("file:///c.ts", ["file:///c.ts"]))
    const res = tree.applyTabDrop(editorPanel, EXPLORER_TAB_ID, right, {
      kind: "split",
      edge: "left",
    })
    assert.equal(res.moved, true)
    assert.ok(res.createdPanel)
    const created = tabs(tree.getView(res.createdPanel!))
    assert.deepEqual(panelTabIds(created), [EXPLORER_TAB_ID])
  })

  it("explorer tab moveToPane merges into target", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    const right = tree.splitAtEdge(editorPanel, "right")
    tree.setView(editorPanel, buildTabsView(EXPLORER_TAB_ID, [EXPLORER_TAB_ID]))
    tree.setView(right, buildTabsView("file:///c.ts", ["file:///c.ts"]))
    const res = tree.applyTabDrop(editorPanel, EXPLORER_TAB_ID, right, { kind: "moveToPane" })
    assert.equal(res.moved, true)
    const tgt = tabs(tree.getView(right))
    assert.deepEqual(panelTabIds(tgt), ["file:///c.ts", EXPLORER_TAB_ID])
    assert.equal(tgt.activeTabId, EXPLORER_TAB_ID)
    assert.equal(tree.root.kind, "leaf")
  })

  it("split(edge=left) creates new leaf on left side", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    tree.setView(editorPanel, buildTabsView("file:///a.ts", ["file:///a.ts", "file:///b.ts"]))
    const res = tree.applyTabDrop(editorPanel, "file:///b.ts", editorPanel, {
      kind: "split",
      edge: "left",
    })
    assert.equal(res.moved, true)
    assert.equal(tree.root.kind, "row")
    if (tree.root.kind === "row") {
      const [first, second] = tree.root.split.children
      if (first?.kind === "leaf") assert.equal(first.panelId.id, res.createdPanel!.id)
      if (second?.kind === "leaf") assert.equal(second.panelId.id, editorPanel.id)
    }
  })

  it("split(edge=top) creates column split with new leaf on top", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    tree.setView(editorPanel, buildTabsView("file:///a.ts", ["file:///a.ts", "file:///b.ts"]))
    const res = tree.applyTabDrop(editorPanel, "file:///b.ts", editorPanel, {
      kind: "split",
      edge: "top",
    })
    assert.equal(res.moved, true)
    assert.equal(tree.root.kind, "column")
    if (tree.root.kind === "column") {
      const [first] = tree.root.split.children
      if (first?.kind === "leaf") assert.equal(first.panelId.id, res.createdPanel!.id)
    }
  })
})

describe("YaadePanelTree — jetFromJSON", () => {
  it("restores structure and normalizes tab views", () => {
    const { tree, editorPanel } = YaadePanelTree.editorOnlyLayout()
    tree.setView(editorPanel, { kind: "tabs", activeTabId: "file:///a.ts", tabIds: [] })
    const restored = YaadePanelTree.jetFromJSON(tree.toJSON())
    const view = tabs(restored.getView(editorPanel))
    assert.deepEqual(panelTabIds(view), ["file:///a.ts"])
    assert.equal(restored.findEditorPanelForFile("file:///a.ts")?.id, editorPanel.id)
  })
})
