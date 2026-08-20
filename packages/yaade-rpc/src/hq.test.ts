import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import { Schema } from "effect"
import { HqSnapshot } from "./hq.js"

describe("HqSnapshot schema", () => {
  it("decodes lean snapshots and rejects invalid agent rows", () => {
    const base = {
      version: 1,
      generatedAt: "2026-08-08T00:00:00.000Z",
      machineHostname: "host",
      notificationCounts: { totalUnread: 0, actionRequired: 0, errors: 0 },
      projects: [],
      agents: [],
    }
    assert.equal(Schema.decodeUnknownSync(HqSnapshot)(base).version, 1)
    assert.throws(() =>
      Schema.decodeUnknownSync(HqSnapshot)({ ...base, agents: [{ telemetry: "lost" }] }),
    )
  })
})
