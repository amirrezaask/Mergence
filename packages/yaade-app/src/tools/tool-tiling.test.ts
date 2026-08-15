import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Schema } from "effect";
import { ToolUseId } from "@yaade/rpc";
import {
  MAX_TOOL_TILES,
  activateToolTab,
  closeToolPanel,
  closeToolTab,
  createToolWorkspace,
  dockToolView,
  openToolView,
  reorderToolTabs,
  splitToolPanel,
  toolIdsInWorkspace,
} from "./tool-tiling.js";

const toolId = (suffix: string) =>
  Schema.decodeUnknownSync(ToolUseId)(`use-${suffix}`);

function focusedTabs(workspace: ReturnType<typeof createToolWorkspace>) {
  const view = workspace.tree.getView(workspace.focusedPanelId);
  assert.equal(view?.kind, "tabs");
  return view?.kind === "tabs" ? view : undefined;
}

describe("tool tiling workspace", () => {
  it("opens tools as tabs in the focused pane", () => {
    const first = toolId("first");
    const second = toolId("second");
    let workspace = openToolView(createToolWorkspace(), first);
    workspace = openToolView(workspace, second);

    assert.deepEqual(toolIdsInWorkspace(workspace), [first, second]);
    assert.deepEqual(focusedTabs(workspace)?.toolUseIds, [first, second]);
    assert.equal(focusedTabs(workspace)?.activeToolUseId, second);

    workspace = openToolView(workspace, first);
    assert.equal(focusedTabs(workspace)?.activeToolUseId, first);
    assert.deepEqual(toolIdsInWorkspace(workspace), [first, second]);
  });

  it("activates and reorders tabs without changing panes", () => {
    const first = toolId("first");
    const second = toolId("second");
    let workspace = openToolView(createToolWorkspace(), first);
    workspace = openToolView(workspace, second);
    workspace = activateToolTab(
      workspace,
      workspace.focusedPanelId,
      first,
    );
    workspace = reorderToolTabs(
      workspace,
      workspace.focusedPanelId,
      second,
      0,
    );

    assert.deepEqual(focusedTabs(workspace)?.toolUseIds, [second, first]);
    assert.equal(focusedTabs(workspace)?.activeToolUseId, first);
  });

  it("closing a tab or pane only removes workspace views", () => {
    const first = toolId("first");
    const second = toolId("second");
    let workspace = openToolView(createToolWorkspace(), first);
    workspace = openToolView(workspace, second);
    workspace = closeToolTab(workspace, workspace.focusedPanelId, first);

    assert.deepEqual(toolIdsInWorkspace(workspace), [second]);
    workspace = closeToolPanel(workspace, workspace.focusedPanelId);
    assert.deepEqual(toolIdsInWorkspace(workspace), []);
    assert.equal(workspace.tree.getView(workspace.focusedPanelId)?.kind, "empty");
  });

  it("drops a sidebar tool at a panel edge", () => {
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

  it("drops a tool in the center as a tab", () => {
    const first = toolId("first");
    const second = toolId("second");
    const workspace = openToolView(createToolWorkspace(), first);
    const docked = dockToolView(workspace, second, workspace.focusedPanelId, {
      kind: "moveToPane",
    });

    assert.deepEqual(focusedTabs(docked)?.toolUseIds, [first, second]);
    assert.equal(focusedTabs(docked)?.activeToolUseId, second);
  });

  it("moves a tab between panes and removes an empty source pane", () => {
    const first = toolId("first");
    const second = toolId("second");
    let workspace = openToolView(createToolWorkspace(), first);
    const firstPanel = workspace.focusedPanelId;
    workspace = splitToolPanel(workspace, firstPanel, "right");
    workspace = openToolView(workspace, second);
    const secondPanel = workspace.focusedPanelId;

    workspace = dockToolView(workspace, second, firstPanel, {
      kind: "moveToPane",
    });

    assert.equal(workspace.tree.getLeaf(secondPanel), null);
    assert.deepEqual(toolIdsInWorkspace(workspace), [first, second]);
    assert.deepEqual(focusedTabs(workspace)?.toolUseIds, [first, second]);
  });

  it("splits one tab out of a multi-tab pane", () => {
    const first = toolId("first");
    const second = toolId("second");
    let workspace = openToolView(createToolWorkspace(), first);
    workspace = openToolView(workspace, second);
    const sourcePanel = workspace.focusedPanelId;

    workspace = dockToolView(workspace, second, sourcePanel, {
      kind: "split",
      edge: "right",
    });

    assert.equal(workspace.tree.root.kind, "row");
    assert.deepEqual(toolIdsInWorkspace(workspace), [first, second]);
    assert.deepEqual(focusedTabs(workspace)?.toolUseIds, [second]);
  });

  it("caps panes while allowing more tabs", () => {
    let workspace = createToolWorkspace();
    workspace = openToolView(workspace, toolId("first"));
    for (let index = 1; index < MAX_TOOL_TILES + 2; index += 1) {
      workspace = splitToolPanel(
        workspace,
        workspace.focusedPanelId,
        "right",
      );
    }

    let panes = 0;
    workspace.tree.visitLeaves(() => {
      panes += 1;
    });
    assert.equal(panes, MAX_TOOL_TILES);

    workspace = openToolView(workspace, toolId("extra-a"));
    workspace = openToolView(workspace, toolId("extra-b"));
    assert.deepEqual(focusedTabs(workspace)?.toolUseIds, [
      toolId("extra-a"),
      toolId("extra-b"),
    ]);
  });
});
