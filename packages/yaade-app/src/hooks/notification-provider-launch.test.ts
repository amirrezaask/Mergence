import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { notificationLaunchForProviderSync } from "./notification-provider-launch.js"

describe("notificationLaunchForProviderSync", () => {
  const context = {
    sessionId: "sess-1",
    origin: "http://127.0.0.1:4747",
  }

  it("wires Claude with SessionStart and full hook surface", () => {
    const launch = notificationLaunchForProviderSync("claude", "claude", context)
    assert.equal(launch.driver, "hook")
    assert.equal(launch.args[0], "--settings")
    const settings = String(launch.args[1] ?? "")
    assert.ok(settings.includes("SessionStart"))
    assert.ok(settings.includes("PreToolUse"))
    assert.ok(settings.includes("Stop"))
    assert.ok(settings.includes("sessionId=sess-1"))
    assert.equal(launch.env.YAADE_SESSION_ID, "sess-1")
  })

  it("wires Codex notify + hooks feature flag", () => {
    const launch = notificationLaunchForProviderSync("codex", "codex", context)
    assert.equal(launch.driver, "hook")
    assert.ok(launch.args.includes("-c"))
    assert.ok(launch.args.some((a) => a.includes("notify=")))
    assert.ok(launch.args.some((a) => a.includes("codex_hooks")))
  })

  it("uses osc/plugin for providers without session --settings", () => {
    for (const provider of ["opencode", "grok", "pi"] as const) {
      const launch = notificationLaunchForProviderSync(provider, provider, context)
      assert.ok(launch.driver === "osc" || launch.driver === "plugin")
      assert.equal(launch.env.YAADE_PROVIDER, provider)
      assert.equal(
        launch.env.YAADE_INGEST_URL,
        `http://127.0.0.1:4747/api/v1/notifications/ingest?provider=${provider}&sessionId=sess-1`,
      )
    }
  })

  it("keeps Cursor --trust", () => {
    const launch = notificationLaunchForProviderSync(
      "cursor",
      "cursor-agent",
      context,
    )
    assert.deepEqual(launch.args, ["--trust"])
    assert.equal(launch.env.YAADE_PROVIDER, "cursor")
    assert.ok(launch.env.YAADE_INGEST_URL?.includes("provider=cursor"))
  })

  it("wires ingest env for every agent provider", () => {
    for (const provider of [
      "claude",
      "codex",
      "cursor",
      "opencode",
      "grok",
      "pi",
    ] as const) {
      const command = provider === "cursor" ? "cursor-agent" : provider
      const launch = notificationLaunchForProviderSync(provider, command, context)
      assert.equal(launch.env.YAADE_SESSION_ID, "sess-1")
      assert.equal(launch.env.YAADE_PROVIDER, provider)
      assert.ok(launch.env.YAADE_INGEST_URL?.includes(`provider=${provider}`))
    }
  })
})
