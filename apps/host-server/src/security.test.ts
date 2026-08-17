import assert from "node:assert/strict"
import test from "node:test"
import { isAllowedWebSocketOrigin, isLoopbackHostname } from "./security.js"

test("identifies loopback bind hosts", () => {
  assert.equal(isLoopbackHostname("127.0.0.1"), true)
  assert.equal(isLoopbackHostname("localhost"), true)
  assert.equal(isLoopbackHostname("ide.local"), false)
  assert.equal(isLoopbackHostname("[::1]"), true)
  assert.equal(isLoopbackHostname("0.0.0.0"), false)
  assert.equal(isLoopbackHostname("192.168.1.8"), false)
})

test("websocket origin permits local browser clients and non-browser clients", () => {
  assert.equal(isAllowedWebSocketOrigin(undefined), true)
  assert.equal(isAllowedWebSocketOrigin("http://127.0.0.1:5173"), true)
  assert.equal(isAllowedWebSocketOrigin("http://localhost:4747"), true)
  assert.equal(isAllowedWebSocketOrigin("http://ide.local:5174"), true)
  assert.equal(isAllowedWebSocketOrigin("https://[::1]:4747"), true)
  assert.equal(isAllowedWebSocketOrigin("https://example.com"), false)
  assert.equal(isAllowedWebSocketOrigin("file:///tmp/index.html"), false)
  assert.equal(isAllowedWebSocketOrigin("not a url"), false)
})

test("websocket origin permits an exact remote same-origin deployment", () => {
  assert.equal(
    isAllowedWebSocketOrigin("https://yaade.example", "yaade.example"),
    true,
  )
  assert.equal(
    isAllowedWebSocketOrigin("https://yaade.example:8443", "yaade.example:8443"),
    true,
  )
  assert.equal(
    isAllowedWebSocketOrigin("https://attacker.example", "yaade.example"),
    false,
  )
  assert.equal(
    isAllowedWebSocketOrigin("https://yaade.example:8443", "yaade.example"),
    false,
  )
})
