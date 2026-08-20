import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  MAX_EDITOR_RECOVERY_BUFFER_BYTES,
  MAX_EDITOR_RECOVERY_SESSION_BYTES,
  isEditorRecoveryBufferSummary,
} from "./editor-recovery.js"

test("editor recovery limits and metadata guard", () => {
  assert.equal(MAX_EDITOR_RECOVERY_BUFFER_BYTES, 16 * 1024 * 1024)
  assert.equal(MAX_EDITOR_RECOVERY_SESSION_BYTES, 64 * 1024 * 1024)
  assert.equal(
    isEditorRecoveryBufferSummary({
      sessionId: "ses-1",
      uri: "file:///workspace/index.ts",
      baseVersion: "10:4",
      languageId: "typescript",
      contentBytes: 4,
      updatedAt: "2026-08-08T00:00:00.000Z",
    }),
    true,
  )
  assert.equal(
    isEditorRecoveryBufferSummary({
      sessionId: "ses-1",
      uri: "untitled:one",
      baseVersion: null,
      languageId: "plaintext",
      contentBytes: -1,
      updatedAt: "2026-08-08T00:00:00.000Z",
    }),
    false,
  )
})
