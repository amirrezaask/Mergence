import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Schema } from "effect";
import { ToolUseId } from "@yaade/rpc";
import {
  MAX_TOOL_TILES,
  closeToolPanel,
  createToolWorkspace,
  dockToolView,
  openToolView,
  splitToolPanel,
  toolIdsInWorkspace,
} from "./tool-tiling.js";

const toolId = (suffix: string) =>
  Schema.decodeUnknownSync(ToolUseId)(`use-${suffix}`);

describe("tool tiling workspace", () => {
  it("opens tools into tiles and focuses an existing tile", () => {
    const first = toolId("first");
    const second = toolId("second");
    let workspace = openToolView(createToolWorkspace(), first);
    workspace = openToolView(workspace, second);

    assert.deepEqual(toolIdsInWorkspace(workspace), [first, second]);
    const focusedBefore = workspace.focusedPanelId;
    workspace = openToolView(workspace, first);
    assert.notEqual(workspace.focusedPanelId.id, focusedBefore.id);
    assert.deepEqual(toolIdsInWorkspace(workspace), [first, second]);
  });

  it("closing a tile only removes its view", () => {
    const first = toolId("first");
    const workspace = openToolView(createToolWorkspace(), first);
    const closed = closeToolPanel(workspace, workspace.focusedPanelId);

    assert.deepEqual(toolIdsInWorkspace(closed), []);
    assert.equal(closed.tree.getView(closed.focusedPanelId)?.kind, "empty");
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

  it("caps mounted tiles and reuses the focused tile", () => {
    let workspace = createToolWorkspace();
    for (let index = 0; index < MAX_TOOL_TILES + 1; index += 1) {
      workspace = openToolView(workspace, toolId(String(index)));
    }

    assert.equal(toolIdsInWorkspace(workspace).length, MAX_TOOL_TILES);
    assert.equal(
      toolIdsInWorkspace(workspace).includes(toolId(String(MAX_TOOL_TILES))),
      true,
    );
  });

  it("opens a tool in an explicit empty split", () => {
    const first = toolId("first");
    const second = toolId("second");
    let workspace = openToolView(createToolWorkspace(), first);
    workspace = splitToolPanel(workspace, workspace.focusedPanelId, "right");
    workspace = openToolView(workspace, second);

    assert.deepEqual(toolIdsInWorkspace(workspace), [first, second]);
  });
});
