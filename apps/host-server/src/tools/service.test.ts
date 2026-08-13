import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import {
  CreateToolUse,
  MainCheckout,
  ProjectTarget,
  SearchToolInput,
  ToolUse,
  ToolUseId,
} from "@yaade/rpc"
import { Schema } from "effect"
import { dispatchPromise } from "../dispatch.js"
import { loadConfig } from "../config.js"
import { startHostServer } from "../server.js"

describe("ToolService", () => {
  it("persists a SearchTool before running its host-owned lifecycle", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-tool-service-"))
    const dataDir = path.join(root, "data")
    const config = await loadConfig([
      "--host", "127.0.0.1", "--port", "0",
      "--data-dir", dataDir, "--allowed-roots", root, root,
    ])
    const host = await startHostServer(config)
    try {
      const project = host.runtime.db.projects()[0]
      assert.ok(project)
      const session = host.runtime.toolSessions.listSessions()[0]
      assert.ok(session)
      const command = CreateToolUse.make({
        sessionId: session.id,
        kind: "search",
        project: ProjectTarget.make({
          projectId: project.id,
          projectPath: project.rootPath,
          projectName: project.name,
        }),
        checkout: MainCheckout.make({ kind: "main" }),
        input: SearchToolInput.make({ kind: "search", query: "", options: {} }),
      })
      const created = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(host.runtime, "tools:createUse", [command], "test-client"),
      )
      assert.equal(created.kind, "search")
      const useId = Schema.decodeUnknownSync(ToolUseId)(created.id)
      await new Promise(resolve => setTimeout(resolve, 20))
      const stored = host.runtime.toolSessions.getToolUse(useId)
      assert.equal(stored?.status, "succeeded")
      assert.equal(stored?.output.kind, "search")
    } finally {
      await host.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects a cancel that carries a stale revision", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-tool-service-conflict-"))
    const config = await loadConfig([
      "--host", "127.0.0.1", "--port", "0",
      "--data-dir", path.join(root, "data"), "--allowed-roots", root, root,
    ])
    const host = await startHostServer(config)
    try {
      const project = host.runtime.db.projects()[0]
      assert.ok(project)
      const session = host.runtime.toolSessions.listSessions()[0]
      assert.ok(session)
      const created = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(host.runtime, "tools:createUse", [CreateToolUse.make({
          sessionId: session.id,
          kind: "search",
          project: ProjectTarget.make({
            projectId: project.id,
            projectPath: project.rootPath,
            projectName: project.name,
          }),
          checkout: MainCheckout.make({ kind: "main" }),
          input: SearchToolInput.make({ kind: "search", query: "", options: {} }),
        })], "conflict-test"),
      )
      await assert.rejects(
        () => dispatchPromise(host.runtime, "tools:cancelUse", [created.id, created.revision - 1], "conflict-test"),
        /conflict|revision/i,
      )
    } finally {
      await host.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
