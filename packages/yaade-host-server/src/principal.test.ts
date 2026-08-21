import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  makePairedDevicePrincipal,
  RequestPrincipalRegistry,
} from "./principal.js"

test("HTTP correlation keys select server-generated identities per principal", () => {
  const registry = new RequestPrincipalRegistry()
  const first = makePairedDevicePrincipal("device-a", ["observe"], "request")
  const second = makePairedDevicePrincipal("device-b", ["admin"], "request")
  const firstConnection = registry.resolve(first, "browser")
  const firstAgain = registry.resolve(first, "browser")
  const secondConnection = registry.resolve(second, "browser")
  assert.equal(firstConnection.connectionId, firstAgain.connectionId)
  assert.notEqual(firstConnection.connectionId, secondConnection.connectionId)
  assert.deepEqual([...firstConnection.scopes], ["observe"])
})
