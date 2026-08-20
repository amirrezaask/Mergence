import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  decodeHostRouteArgs,
  decodeHostRouteResult,
  getHostRoute,
  HOST_HOT_ROUTES,
  isHostRouteName,
} from "./routes.js"

test("route registry owns argument and result validation", () => {
  assert.equal(isHostRouteName("git:status"), true)
  assert.equal(isHostRouteName("git:not-a-route"), false)
  assert.equal(getHostRoute("git:status")?.pathPolicy.kind, "allowed-root")
  assert.deepEqual(
    decodeHostRouteArgs("git:status", ["file:///tmp/project"]),
    ["file:///tmp/project"],
  )
  assert.throws(() => decodeHostRouteArgs("git:status", []))
  assert.throws(() => decodeHostRouteArgs("git:status", [42]))
  assert.deepEqual(decodeHostRouteResult("git:status", []), [])
})

test("hot terminal routes are selected from the same registry", () => {
  assert.deepEqual([...HOST_HOT_ROUTES].sort(), [
    "terminal:ack",
    "terminal:attach",
    "terminal:ready",
    "terminal:resize",
    "terminal:write",
    "terminal:writeBinary",
  ])
})
