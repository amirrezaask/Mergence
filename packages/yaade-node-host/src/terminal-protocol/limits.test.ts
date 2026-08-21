import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  MAX_COMMAND_BYTES,
  MAX_INPUT_BYTES,
  MAX_PENDING_REQUESTS,
  supervisorOperationLimit,
} from "./limits.js"

test("operation limits keep interactive input below generic command limits", () => {
  assert.ok(MAX_INPUT_BYTES < MAX_COMMAND_BYTES)
  assert.equal(supervisorOperationLimit("sendInput"), MAX_INPUT_BYTES)
  assert.equal(supervisorOperationLimit("inspect"), MAX_COMMAND_BYTES)
  assert.equal(MAX_PENDING_REQUESTS, 1_024)
})
