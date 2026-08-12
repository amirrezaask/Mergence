import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getSingularPatch } from "@pierre/diffs"

import {
  buildHunkActionAnnotations,
  hunkIndexForLine,
  listApplyHunks,
  sliceRawHunkBodies,
} from "./pierre-hunk-patch.js"

const MULTI = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,3 +1,4 @@
 a
-b
+B
+BB
 c
@@ -8,2 +9,2 @@
 x
-y
+Y
`

const RENAME = `diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
index 111..222 100644
--- a/old.ts
+++ b/new.ts
@@ -1,2 +1,2 @@
 hello
-world
+WORLD
`

describe("listApplyHunks", () => {
  it("pairs Pierre typed hunks with raw git-apply payloads", () => {
    const hunks = listApplyHunks(MULTI)
    assert.equal(hunks.length, 2)
    assert.equal(hunks[0]!.added, 2)
    assert.equal(hunks[0]!.deleted, 1)
    assert.equal(hunks[1]!.added, 1)
    assert.equal(hunks[1]!.deleted, 1)
    assert.match(hunks[0]!.header, /^@@ -1,3 \+1,4 @@/)
    assert.match(hunks[1]!.header, /^@@ -8,2 \+9,2 @@/)
    assert.ok(hunks[0]!.patch.startsWith("diff --git a/m.ts b/m.ts\n"))
    assert.ok(hunks[0]!.patch.includes("@@ -1,3 +1,4 @@\n"))
    assert.ok(!hunks[0]!.patch.includes("@@ -8,2 +9,2 @@"))
    assert.ok(hunks[1]!.patch.includes("@@ -8,2 +9,2 @@\n"))
  })

  it("preserves rename headers on the apply payload", () => {
    const hunks = listApplyHunks(RENAME)
    assert.equal(hunks.length, 1)
    assert.ok(hunks[0]!.patch.includes("rename from old.ts\n"))
    assert.ok(hunks[0]!.patch.includes("rename to new.ts\n"))
    assert.equal(hunks[0]!.added, 1)
    assert.equal(hunks[0]!.deleted, 1)
  })

  it("returns empty when there are no @@ hunks", () => {
    assert.deepEqual(listApplyHunks("not a patch"), [])
    assert.deepEqual(listApplyHunks(""), [])
  })

  it("matches Pierre hunk count to raw slice count", () => {
    const pierre = getSingularPatch(MULTI)
    const slices = sliceRawHunkBodies(MULTI)
    assert.equal(pierre.hunks.length, slices.length)
    assert.equal(listApplyHunks(MULTI).length, pierre.hunks.length)
  })
})

describe("hunkIndexForLine", () => {
  it("maps addition/deletion line numbers to hunk indexes", () => {
    const fileDiff = getSingularPatch(MULTI)
    assert.equal(hunkIndexForLine(fileDiff, 2, "additions"), 0)
    assert.equal(hunkIndexForLine(fileDiff, 9, "additions"), 1)
    assert.equal(hunkIndexForLine(fileDiff, 2, "deletions"), 0)
    assert.equal(hunkIndexForLine(fileDiff, 9, "deletions"), 1)
    assert.equal(hunkIndexForLine(fileDiff, 99, "additions"), null)
  })
})

describe("buildHunkActionAnnotations", () => {
  it("anchors one annotation per hunk on the first changed line", () => {
    const fileDiff = getSingularPatch(MULTI)
    const annotations = buildHunkActionAnnotations(fileDiff)
    assert.equal(annotations.length, 2)
    assert.equal(annotations[0]!.metadata?.hunkIndex, 0)
    assert.equal(annotations[1]!.metadata?.hunkIndex, 1)
    assert.equal(annotations[0]!.side, "additions")
    assert.equal(annotations[0]!.lineNumber, fileDiff.hunks[0]!.additionStart)
  })
})
