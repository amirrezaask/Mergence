import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { deviceMayInvoke } from "./device-scopes.js"

test("observe scope allows attach and denies write", () => {
  assert.equal(deviceMayInvoke(["observe"], "terminal:attach"), true)
  assert.equal(deviceMayInvoke(["observe"], "tools:listSessions"), true)
  assert.equal(deviceMayInvoke(["observe"], "terminal:write"), false)
  assert.equal(deviceMayInvoke(["observe"], "agents:stop"), false)
  assert.equal(deviceMayInvoke(["observe"], "tools:createUse"), false)
  assert.equal(deviceMayInvoke(["control"], "terminal:write"), true)
  assert.equal(deviceMayInvoke(["admin"], "tools:archiveSession"), true)
  assert.equal(deviceMayInvoke(undefined, "terminal:write"), true)
})
