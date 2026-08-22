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
  assert.equal(isHostRouteName("mux:listSessions"), true)
  assert.equal(isHostRouteName("mux:not-a-route"), false)
  assert.equal(getHostRoute("mux:listSessions")?.pathPolicy.kind, "none")
  assert.deepEqual(
    decodeHostRouteArgs("mux:listSessions", [false]),
    [false],
  )
  assert.throws(() => decodeHostRouteArgs("mux:listSessions", []))
  assert.throws(() => decodeHostRouteArgs("mux:listSessions", [42]))
  assert.deepEqual(decodeHostRouteResult("mux:listSessions", []), [])
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
