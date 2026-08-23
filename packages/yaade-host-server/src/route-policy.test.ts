import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { makePairedDevicePrincipal } from "./principal.js"
import { principalMayInvoke, routeCapability } from "./route-policy.js"

test("route policy keeps terminal observation separate from control and admin", () => {
  const observe = makePairedDevicePrincipal("device-a", ["observe"], "connection-a")
  const control = makePairedDevicePrincipal("device-b", ["control"], "connection-b")
  const admin = makePairedDevicePrincipal("device-c", ["admin"], "connection-c")

  assert.equal(routeCapability("terminal:attach"), "observe")
  assert.equal(routeCapability("terminal:detach"), "observe")
  assert.equal(routeCapability("terminal:write"), "control")
  assert.equal(routeCapability("terminal:dispose"), "admin")
  assert.equal(principalMayInvoke(observe, "terminal:attach"), true)
  assert.equal(principalMayInvoke(observe, "terminal:detach"), true)
  assert.equal(principalMayInvoke(observe, "terminal:write"), false)
  assert.equal(principalMayInvoke(observe, "terminal:dispose"), false)
  assert.equal(principalMayInvoke(control, "terminal:attach"), true)
  assert.equal(principalMayInvoke(control, "terminal:write"), true)
  assert.equal(principalMayInvoke(control, "terminal:dispose"), false)
  assert.equal(principalMayInvoke(admin, "terminal:dispose"), true)
})

test("unknown routes fail closed", () => {
  const observe = makePairedDevicePrincipal("device-a", ["observe"], "connection-a")
  assert.equal(routeCapability("future:mutation"), "local-admin")
  assert.equal(principalMayInvoke(observe, "future:mutation"), false)
})
