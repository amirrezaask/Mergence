import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { httpRouteCapability } from "./http-route-policy.js"

test("HTTP resource policy distinguishes reads, mutations, and unknown routes", () => {
  assert.equal(httpRouteCapability("/api/v1/rpc", "POST"), null)
  assert.equal(httpRouteCapability("/api/v1/system", "GET"), "observe")
  assert.equal(httpRouteCapability("/api/v1/fs/text-file", "GET"), "observe")
  assert.equal(httpRouteCapability("/api/v1/fs/text-file", "PUT"), "control")
  assert.equal(httpRouteCapability("/api/v1/security/pairing-code", "POST"), "local-admin")
  assert.equal(httpRouteCapability("/api/v1/unknown", "POST"), "admin")
})
