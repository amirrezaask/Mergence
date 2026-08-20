import assert from "node:assert/strict"
import test from "node:test"
import {
  isAllowedCorsOrigin,
  isAllowedWebSocketOrigin,
  isAuthorizedRequest,
  isLoopbackHostname,
} from "./security.js"

test("authorizes requests against the configured host token", () => {
  const req = (headers: Record<string, string | string[] | undefined>) =>
    ({ headers }) as import("node:http").IncomingMessage
  assert.equal(isAuthorizedRequest(req({}), null), true)
  assert.equal(isAuthorizedRequest(req({}), "secret"), false)
  assert.equal(
    isAuthorizedRequest(req({ authorization: "Bearer secret" }), "secret"),
    true,
  )
  assert.equal(
    isAuthorizedRequest(req({ "x-yaade-token": "secret" }), "secret"),
    true,
  )
  assert.equal(
    isAuthorizedRequest(
      req({}),
      "secret",
      new URL("http://127.0.0.1/ws?token=secret"),
    ),
    true,
  )
  assert.equal(
    isAuthorizedRequest(req({ authorization: "Bearer other" }), "secret"),
    false,
  )
})

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

test("CORS origin matching keeps local clients and explicit origins available", () => {
  assert.equal(isAllowedCorsOrigin("http://127.0.0.1:5174"), true)
  assert.equal(isAllowedCorsOrigin("https://client.example", ["https://client.example"]), true)
  assert.equal(isAllowedCorsOrigin("https://client.example", ["https://other.example"]), false)
  assert.equal(isAllowedCorsOrigin("https://client.example", ["*"]), true)
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
