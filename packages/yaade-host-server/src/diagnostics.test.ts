import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { diagnosticBundle, redactDiagnostics } from "./diagnostics.js"

test("redactDiagnostics hides secret keys and known token strings", () => {
  const redacted = redactDiagnostics(
    {
      host: "127.0.0.1",
      token: "live-secret",
      nested: { authorization: "Bearer live-secret", note: "ok" },
    },
    ["live-secret"],
  ) as Record<string, unknown>
  assert.equal(redacted.token, "[redacted]")
  assert.equal((redacted.nested as { authorization: string }).authorization, "[redacted]")
  assert.equal((redacted.nested as { note: string }).note, "ok")
})

test("diagnosticBundle does not echo the host token", () => {
  const bundle = JSON.stringify(
    diagnosticBundle(
      {
        generatedAt: "now",
        identity: { serverId: "srv-1", protocolVersion: 2 },
        health: { status: "ok" },
        config: { host: "127.0.0.1" },
        devices: [],
        capabilities: { checkpoint: true },
      },
      ["yaade-diagnostic-secret-token"],
    ),
  )
  assert.equal(bundle.includes("yaade-diagnostic-secret-token"), false)
  assert.match(bundle, /srv-1/)
})
