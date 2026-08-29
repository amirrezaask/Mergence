import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import type { GhosttyCell, GhosttySnapshot } from "./core.js";
import {
  GHOSTTY_RENDER_STYLE,
  GhosttyRenderUpdateBuilder,
  packGhosttyColor,
  unpackGhosttyColor,
  validateGhosttyRenderUpdate,
} from "./render-update.js";

const foreground = { r: 240, g: 241, b: 242 };
const background = { r: 3, g: 4, b: 5 };

function cell(text: string, overrides: Partial<GhosttyCell> = {}): GhosttyCell {
  return {
    text,
    wide: 0,
    foreground,
    background,
    bold: false,
    italic: false,
    invisible: false,
    strikethrough: false,
    overline: false,
    underline: 0,
    selected: false,
    ...overrides,
  };
}

function snapshot(rows: readonly (readonly GhosttyCell[])[], dirtyRows: number[]): GhosttySnapshot {
  return {
    cols: rows[0]?.length ?? 1,
    rows: rows.length,
    foreground,
    background,
    cursor: { r: 10, g: 20, b: 30 },
    cursorX: 1,
    cursorY: 0,
    cursorVisible: true,
    cursorBlinking: true,
    cursorStyle: 2,
    dirtyRows: new Set(dirtyRows),
    rowData: rows.map((cells, index) => ({
      cells,
      text: cells.map((value) => value.text || " ").join("").trimEnd(),
      isWrapContinuation: index === 1,
      wrapsToNext: index === 0,
    })),
  };
}

test("packs full rows, UTF-8 graphemes, cursor, colors, width, and every style", () => {
  const builder = new GhosttyRenderUpdateBuilder();
  const update = builder.build({
    snapshot: snapshot([
      [cell("A", { bold: true, italic: true, underline: 5 }), cell("界", { wide: 1 })],
      [cell("", { wide: 2 }), cell("e\u0301", {
        invisible: true,
        strikethrough: true,
        overline: true,
        selected: true,
      })],
    ], [0, 1]),
    frameId: 1,
    generation: 1,
    full: true,
  });

  assert.equal(validateGhosttyRenderUpdate(update), true);
  assert.deepEqual([...update.dirtyRows], [0, 1]);
  assert.equal(new TextDecoder().decode(update.graphemes), "A界e\u0301");
  assert.equal(update.cursorBlinking, true);
  assert.equal(update.cursorStyle, 2);
  assert.equal(update.styles[1] & GHOSTTY_RENDER_STYLE.widthMask, 1);
  assert.equal(update.styles[2] & GHOSTTY_RENDER_STYLE.widthMask, 2);
  assert.notEqual(update.styles[0] & GHOSTTY_RENDER_STYLE.bold, 0);
  assert.notEqual(update.styles[0] & GHOSTTY_RENDER_STYLE.italic, 0);
  assert.notEqual(update.styles[3] & GHOSTTY_RENDER_STYLE.invisible, 0);
  assert.notEqual(update.styles[3] & GHOSTTY_RENDER_STYLE.strikethrough, 0);
  assert.notEqual(update.styles[3] & GHOSTTY_RENDER_STYLE.overline, 0);
  assert.notEqual(update.styles[3] & GHOSTTY_RENDER_STYLE.selected, 0);
  assert.equal(unpackGhosttyColor(packGhosttyColor(foreground)).r, foreground.r);
  builder.release(update);
});

test("packs sorted partial rows and an empty update", () => {
  const builder = new GhosttyRenderUpdateBuilder();
  const source = snapshot([[cell("a")], [cell("b")], [cell("🙂")]], [2, 0]);
  const partial = builder.build({ snapshot: source, frameId: 2, generation: 1, full: false });
  assert.deepEqual([...partial.dirtyRows], [0, 2]);
  assert.equal(partial.graphemeOffsets.length, 2);
  assert.equal(validateGhosttyRenderUpdate(partial), true);
  builder.release(partial);

  const empty = builder.build({
    snapshot: snapshot([[cell("")]], []),
    frameId: 3,
    generation: 1,
    full: false,
  });
  assert.equal(empty.dirtyRows.length, 0);
  assert.equal(empty.graphemes.length, 0);
  assert.equal(validateGhosttyRenderUpdate(empty), true);
  builder.release(empty);
});

test("does not mutate a borrowed update and reuses a released buffer", () => {
  const builder = new GhosttyRenderUpdateBuilder();
  const first = builder.build({
    snapshot: snapshot([[cell("first")]], [0]),
    frameId: 1,
    generation: 1,
    full: true,
  });
  const firstText = new TextDecoder().decode(first.graphemes);
  const second = builder.build({
    snapshot: snapshot([[cell("second")]], [0]),
    frameId: 2,
    generation: 1,
    full: true,
  });
  assert.equal(new TextDecoder().decode(first.graphemes), firstText);
  builder.release(first);
  const firstBuffer = first.graphemes.buffer;
  const third = builder.build({
    snapshot: snapshot([[cell("third")]], [0]),
    frameId: 3,
    generation: 1,
    full: true,
  });
  assert.equal(third.graphemes.buffer, firstBuffer);
  builder.release(second);
  builder.release(third);
});

test("rejects malformed versions, lengths, row order, and grapheme offsets", () => {
  const builder = new GhosttyRenderUpdateBuilder();
  const update = builder.build({
    snapshot: snapshot([[cell("x")], [cell("y")]], [0, 1]),
    frameId: 1,
    generation: 1,
    full: true,
  });
  assert.equal(validateGhosttyRenderUpdate({ ...update, version: 2 }), false);
  assert.equal(validateGhosttyRenderUpdate({ ...update, styles: new Uint16Array(1) }), false);
  assert.equal(validateGhosttyRenderUpdate({ ...update, dirtyRows: new Uint32Array([1, 0]) }), false);
  assert.equal(
    validateGhosttyRenderUpdate({ ...update, graphemeOffsets: new Uint32Array([99, 0]) }),
    false,
  );
  assert.equal(validateGhosttyRenderUpdate({ ...update, frameId: 0 }), false);
  builder.release(update);
});
