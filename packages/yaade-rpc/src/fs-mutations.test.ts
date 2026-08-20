import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { Effect, Schema } from "effect"
import {
  EmptyTrashResult,
  FsRestoreTrashArgs,
  RestoreTrashResult,
  TrashEntry,
} from "./host.js"

test("filesystem mutation contracts decode trash results and restore-as arguments", async () => {
  const entry = {
    id: "8d105d24-e5a2-45fb-9acd-e0675b4ee345",
    originalUri: "file:///workspace/file.ts",
    name: "file.ts",
    isDirectory: false,
    size: 42,
    trashedAt: 1234,
  }
  assert.deepEqual(
    await Effect.runPromise(Schema.decodeUnknown(TrashEntry)(entry)),
    entry,
  )
  assert.deepEqual(
    await Effect.runPromise(
      Schema.decodeUnknown(RestoreTrashResult)({
        entry,
        uri: "file:///workspace/restored.ts",
      }),
    ),
    { entry, uri: "file:///workspace/restored.ts" },
  )
  assert.deepEqual(
    await Effect.runPromise(Schema.decodeUnknown(FsRestoreTrashArgs)([entry.id])),
    [entry.id],
  )
  assert.deepEqual(
    await Effect.runPromise(
      Schema.decodeUnknown(FsRestoreTrashArgs)([
        entry.id,
        "file:///workspace/restored.ts",
      ]),
    ),
    [entry.id, "file:///workspace/restored.ts"],
  )
  assert.deepEqual(
    await Effect.runPromise(
      Schema.decodeUnknown(EmptyTrashResult)({ removed: 1, bytes: 42 }),
    ),
    { removed: 1, bytes: 42 },
  )
})
