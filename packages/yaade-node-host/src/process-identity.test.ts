import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { test } from "vite-plus/test"
import {
  captureProcessIdentity,
  matchesProcessIdentity,
  signalVerifiedProcess,
} from "./process-identity.js"

test("captures and revalidates an OS process start token", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
    stdio: "ignore",
  })
  try {
    const identity = captureProcessIdentity(child.pid ?? -1)
    assert.ok(identity)
    assert.equal(matchesProcessIdentity(identity), true)
    assert.equal(
      matchesProcessIdentity({ ...identity, startToken: `${identity.startToken}-stale` }),
      false,
    )
  } finally {
    child.kill("SIGKILL")
    await new Promise<void>(resolve => child.once("exit", () => resolve()))
  }
})

test("does not signal a process when the persisted start token is stale", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
    stdio: "ignore",
  })
  try {
    const identity = captureProcessIdentity(child.pid ?? -1)
    assert.ok(identity)
    assert.equal(
      signalVerifiedProcess({ ...identity, startToken: `${identity.startToken}-stale` }, "SIGTERM"),
      false,
    )
    assert.equal(matchesProcessIdentity(identity), true)
  } finally {
    child.kill("SIGKILL")
    await new Promise<void>(resolve => child.once("exit", () => resolve()))
  }
})
