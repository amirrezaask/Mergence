import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Schema } from "effect";
import { ToolUseId } from "@yaade/rpc";
import {
  MAX_TOOL_TILES,
  closeToolPanel,
  closeToolTab,
  createToolWorkspace,
  dockToolView,
  openToolView,
  openToolViewInPanel,
  restoreToolWorkspace,
  serializeToolWorkspace,
  splitToolPanel,
  toolIdsInWorkspace,
  toolPaneCount,
} from "./tool-tiling.js";

const toolId = (suffix: string) =>
  Schema.decodeUnknownSync(ToolUseId)(`use-${suffix}`);

function focusedTool(workspace: ReturnType<typeof createToolWorkspace>) {
  const view = workspace.tree.getView(workspace.focusedPanelId);
  return view?.kind === "tool" ? view.toolUseId : undefined;
}

describe("tool tiling workspace", () => {
  it("opens every ToolUse in its own pane", () => {
    const first = toolId("first");
    const second = toolId("second");
    let workspace = openToolView(createToolWorkspace(), first);
    const firstPanel = workspace.focusedPanelId;
    workspace = openToolView(workspace, second);

    assert.deepEqual(toolIdsInWorkspace(workspace), [first, second]);
    assert.equal(toolPaneCount(workspace), 2);
    assert.equal(focusedTool(workspace), second);

    workspace = openToolView(workspace, first);
    assert.equal(workspace.focusedPanelId.id, firstPanel.id);
    assert.equal(focusedTool(workspace), first);
    assert.deepEqual(toolIdsInWorkspace(workspace), [first, second]);
  });

  it("fills an explicit empty split before creating another pane", () => {
    const first = toolId("first");
    const second = toolId("second");
    let workspace = openToolView(createToolWorkspace(), first);
    workspace = splitToolPanel(workspace, workspace.focusedPanelId, "bottom");
    workspace = openToolView(workspace, second);

    assert.equal(toolPaneCount(workspace), 2);
    assert.equal(workspace.tree.root.kind, "column");
    assert.equal(focusedTool(workspace), second);
  });

  it("opens a selected split tool in the new pane", () => {
    const first = toolId("first");
    const second = toolId("second");
    let workspace = openToolView(createToolWorkspace(), first);
    const firstPanel = workspace.focusedPanelId;
    workspace = splitToolPanel(workspace, firstPanel, "right");
    const splitPanel = workspace.focusedPanelId;
    workspace = openToolViewInPanel(workspace, splitPanel, second);

    assert.deepEqual(toolIdsInWorkspace(workspace), [first, second]);
    assert.equal(workspace.tree.getView(splitPanel)?.kind, "tool");
    assert.equal(focusedTool(workspace), second);
  });

  it("closing a ToolUse closes exactly its pane", () => {
    const first = toolId("first");
    const second = toolId("second");
    let workspace = openToolView(createToolWorkspace(), first);
    const firstPanel = workspace.focusedPanelId;
    workspace = openToolView(workspace, second);
    workspace = closeToolTab(workspace, firstPanel, first);

    assert.deepEqual(toolIdsInWorkspace(workspace), [second]);
    assert.equal(toolPaneCount(workspace), 1);
    workspace = closeToolPanel(workspace, workspace.focusedPanelId);
    assert.deepEqual(toolIdsInWorkspace(workspace), []);
    assert.equal(workspace.tree.getView(workspace.focusedPanelId)?.kind, "empty");
  });

  it("drops a sidebar ToolUse at a panel edge", () => {
    const first = toolId("first");
    const second = toolId("second");
    const workspace = openToolView(createToolWorkspace(), first);
    const docked = dockToolView(workspace, second, workspace.focusedPanelId, {
      kind: "split",
      edge: "bottom",
    });

    assert.deepEqual(toolIdsInWorkspace(docked), [first, second]);
    assert.equal(docked.tree.root.kind, "column");
  });

  it("center-dropping an external ToolUse beside an occupied pane does not replace it", () => {
    const first = toolId("first");
    const second = toolId("second");
    const workspace = openToolView(createToolWorkspace(), first);
    const docked = dockToolView(workspace, second, workspace.focusedPanelId, {
      kind: "moveToPane",
    });

    assert.deepEqual(toolIdsInWorkspace(docked), [first, second]);
    assert.equal(toolPaneCount(docked), 2);
  });

  it("center-dropping between panes swaps their ToolUses", () => {
    const first = toolId("first");
    const second = toolId("second");
    let workspace = openToolView(createToolWorkspace(), first);
    const firstPanel = workspace.focusedPanelId;
    workspace = openToolView(workspace, second);
    const secondPanel = workspace.focusedPanelId;

    workspace = dockToolView(workspace, second, firstPanel, {
      kind: "moveToPane",
    });

    assert.equal(workspace.tree.getView(firstPanel)?.kind, "tool");
    assert.equal(workspace.tree.getView(secondPanel)?.kind, "tool");
    assert.equal(
      workspace.tree.getView(firstPanel)?.kind === "tool"
        ? workspace.tree.getView(firstPanel)?.toolUseId
        : undefined,
      second,
    );
    assert.deepEqual(new Set(toolIdsInWorkspace(workspace)), new Set([first, second]));
  });

  it("round-trips split geometry and focus", () => {
    const first = toolId("first");
    const second = toolId("second");
    let workspace = openToolView(createToolWorkspace(), first);
    workspace = openToolView(workspace, second);
    const layoutJson = serializeToolWorkspace(workspace);

    const restored = restoreToolWorkspace(layoutJson, [first, second]);
    assert.deepEqual(toolIdsInWorkspace(restored), [first, second]);
    assert.equal(restored.tree.root.kind, "row");
    assert.equal(focusedTool(restored), second);
  });

  it("normalizes tampered persisted split ratios", () => {
    const first = toolId("first");
    const second = toolId("second");
    let workspace = openToolView(createToolWorkspace(), first);
    workspace = openToolView(workspace, second);
    if (workspace.tree.root.kind !== "row") throw new Error("expected row");
    workspace.tree.root.split.ratios = [100, 1];
    const restored = restoreToolWorkspace(serializeToolWorkspace(workspace), [first, second]);
    if (restored.tree.root.kind !== "row") throw new Error("expected row");
    const sum = restored.tree.root.split.ratios.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6);
    assert.ok(restored.tree.root.split.ratios[0]! < 1);
  });

  it("drops stale persisted ToolUses and places new ones", () => {
    const stale = toolId("stale");
    const current = toolId("current");
    const layoutJson = serializeToolWorkspace(
      openToolView(createToolWorkspace(), stale),
    );

    const restored = restoreToolWorkspace(layoutJson, [current]);
    assert.deepEqual(toolIdsInWorkspace(restored), [current]);
  });

  it("caps one-to-one panes without hiding additional ToolUses", () => {
    let workspace = createToolWorkspace();
    for (let index = 0; index < MAX_TOOL_TILES; index += 1) {
      workspace = openToolView(workspace, toolId(`tool-${index}`));
    }
    assert.equal(toolPaneCount(workspace), MAX_TOOL_TILES);

    const unchanged = openToolView(workspace, toolId("overflow"));
    assert.equal(unchanged, workspace);
    assert.equal(toolIdsInWorkspace(unchanged).includes(toolId("overflow")), false);
  });
});
