import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import { WebGlGlyphBatch, WebGlRectBatch } from "./batches.js";

test("rectangle batches reuse storage and enforce their bound", () => {
  const batch = new WebGlRectBatch(2);
  assert.equal(batch.push(1, 2, 3, 4, 0.1, 0.2, 0.3), true);
  const buffer = batch.data.buffer;
  assert.equal(batch.push(5, 6, 7, 8, 0.4, 0.5, 0.6), true);
  assert.equal(batch.push(9, 9, 9, 9, 1, 1, 1), false);
  assert.equal(batch.count, 2);
  assert.deepEqual([...batch.data.slice(0, 4)], [1, 2, 3, 4]);
  batch.clear();
  batch.push(0, 0, 1, 1, 1, 1, 1);
  assert.equal(batch.data.buffer, buffer);
});

test("glyph batches retain UV, tint, alpha, and color mode", () => {
  const batch = new WebGlGlyphBatch(1);
  assert.equal(batch.push(1, 2, 3, 4, 0.1, 0.2, 0.3, 0.4, 1, 0.5, 0.25, 0.75, 1), true);
  assert.equal(batch.data.length, 13);
  assert.equal(batch.data[12], 1);
  assert.equal(batch.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), false);
});
