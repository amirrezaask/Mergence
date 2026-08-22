import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "vite-plus/test"
import { loadConfig } from "./config.js"

describe("loadConfig launch workspace", () => {
  it("defaults to an ephemeral port when none is configured", async () => {
    const previous = process.env.YAADE_PORT
    delete process.env.YAADE_PORT
    try {
      const config = await loadConfig(["--host", "127.0.0.1"])
      assert.equal(config.port, 0)
    } finally {
      if (previous === undefined) delete process.env.YAADE_PORT
      else process.env.YAADE_PORT = previous
    }
  })

  it("accepts an explicit non-loopback host for LAN mode", async () => {
    const config = await loadConfig([
      "--host",
      "0.0.0.0",
      "--port",
      "0",
      "--token",
      "test-host-token",
    ])
    assert.equal(config.host, "0.0.0.0")
    assert.equal(config.authToken, "test-host-token")
    assert.deepEqual(config.corsOrigins, [])
  })

  it("refuses a non-loopback bind without a host token", async () => {
    await assert.rejects(
      () => loadConfig(["--host", "0.0.0.0", "--port", "0"]),
      /requires --token or YAADE_HOST_TOKEN/,
    )
  })

  it("falls back to home when process cwd is outside allowed roots", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-host-cwd-"))
    const prev = process.cwd()
    try {
      process.chdir(outside)
      const config = await loadConfig(["--host", "127.0.0.1", "--port", "0"])
      assert.equal(config.launchConfig.workspacePath, path.resolve(os.homedir()))
      assert.ok(
        config.allowedRoots.some(root => path.resolve(root) === path.resolve(os.homedir())),
      )
    } finally {
      process.chdir(prev)
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("keeps cwd as launch workspace when it is under home", async () => {
    const underHome = fs.mkdtempSync(path.join(os.homedir(), ".yaade-host-cfg-"))
    const prev = process.cwd()
    try {
      process.chdir(underHome)
      const config = await loadConfig(["--host", "127.0.0.1", "--port", "0"])
      assert.equal(config.launchConfig.workspacePath, path.resolve(underHome))
    } finally {
      process.chdir(prev)
      fs.rmSync(underHome, { recursive: true, force: true })
    }
  })

  it("adds an explicit outside path to allowed roots", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-host-explicit-"))
    try {
      const config = await loadConfig([
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        outside,
      ])
      assert.equal(config.launchConfig.workspacePath, path.resolve(outside))
      assert.ok(
        config.allowedRoots.some(root => {
          const resolved = path.resolve(root)
          const target = path.resolve(outside)
          return resolved === target || target.startsWith(resolved + path.sep)
        }),
      )
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("can advertise disabled terminal checkpoints", async () => {
    const previousCheckpoints = process.env.YAADE_TERMINAL_CHECKPOINTS
    process.env.YAADE_TERMINAL_CHECKPOINTS = "0"
    try {
      const config = await loadConfig(["--host", "127.0.0.1", "--port", "0"])
      assert.equal(config.features.terminalCheckpoints, false)
    } finally {
      if (previousCheckpoints === undefined) delete process.env.YAADE_TERMINAL_CHECKPOINTS
      else process.env.YAADE_TERMINAL_CHECKPOINTS = previousCheckpoints
    }
  })
})
