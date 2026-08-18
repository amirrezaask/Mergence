import assert from "node:assert/strict"
import test from "node:test"
import {
  contentSecurityPolicy,
  externalHttpUrl,
  isAllowedAppUrl,
  workspaceFromArgs,
} from "./policy.mjs"

test("allows only exact trusted app origins", () => {
  const origins = ["http://127.0.0.1:48123"]

  assert.equal(isAllowedAppUrl("http://127.0.0.1:48123/", origins), true)
  assert.equal(isAllowedAppUrl("http://127.0.0.1:48124/", origins), false)
  assert.equal(isAllowedAppUrl("https://127.0.0.1:48123/", origins), false)
  assert.equal(isAllowedAppUrl("http://127.0.0.1:48123.evil.test/", origins), false)
})

test("only returns credential-free HTTP URLs for external opening", () => {
  assert.equal(externalHttpUrl("https://example.com/docs"), "https://example.com/docs")
  assert.equal(externalHttpUrl("mailto:user@example.com"), null)
  assert.equal(externalHttpUrl("javascript:alert(1)"), null)
  assert.equal(externalHttpUrl("https://user:secret@example.com/"), null)
})

test("reads an explicit workspace without treating flags as paths", () => {
  assert.equal(workspaceFromArgs(["--workspace", "/tmp/project"]), "/tmp/project")
  assert.equal(workspaceFromArgs(["--workspace=/tmp/project"]), "/tmp/project")
  assert.equal(workspaceFromArgs(["--workspace", "--dev"]), null)
  assert.equal(workspaceFromArgs(["--", "/tmp/project"]), "/tmp/project")
  assert.equal(workspaceFromArgs(["--dev"]), null)
})

test("keeps production CSP free of eval while allowing required local WASM", () => {
  const policy = contentSecurityPolicy(["http://127.0.0.1:48123"], false)

  assert.match(policy, /connect-src 'self' http:\/\/127\.0\.0\.1:48123 ws:\/\/127\.0\.0\.1:48123/)
  assert.match(policy, /wasm-unsafe-eval/)
  assert.doesNotMatch(policy, /'unsafe-eval'/)
  assert.match(policy, /frame-src 'none'/)
  assert.match(policy, /object-src 'none'/)
})
