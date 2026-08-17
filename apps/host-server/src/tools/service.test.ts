import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import {
  CreateToolUse,
  GitToolInput,
  MainCheckout,
  NeovimToolInput,
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
  it("does not create tools when a host or session starts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-empty-session-"))
    const config = await loadConfig([
      "--host", "127.0.0.1", "--port", "0",
      "--data-dir", path.join(root, "data"), "--allowed-roots", root, root,
    ])
    const host = await startHostServer(config)
    try {
      const session = host.runtime.toolSessions.listSessions()[0]
      assert.ok(session)
      assert.deepEqual(host.runtime.toolSessions.listToolUses(session.id), [])
      assert.equal(host.runtime.toolSessions.getSession(session.id)?.activeToolUseId, undefined)

      await dispatchPromise(
        host.runtime,
        "tools:createSession",
        ["Empty"],
        "empty-session-test",
      )
      const created = host.runtime.toolSessions.listSessions().find(
        candidate => candidate.title === "Empty",
      )
      assert.ok(created)
      assert.deepEqual(host.runtime.toolSessions.listToolUses(created.id), [])
      assert.equal(host.runtime.toolSessions.getSession(created.id)?.activeToolUseId, undefined)
    } finally {
      await host.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

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

  it("creates a Git History tool without launching a process", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-git-tool-service-"))
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
          kind: "git",
          project: ProjectTarget.make({
            projectId: project.id,
            projectPath: project.rootPath,
            projectName: project.name,
          }),
          checkout: MainCheckout.make({ kind: "main" }),
          input: GitToolInput.make({ kind: "git" }),
        })], "git-tool-test"),
      )
      assert.equal(created.status, "running")
      assert.equal(created.output.kind, "git")
      assert.equal(created.input.kind, "git")
    } finally {
      await host.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("owns Neovim lifecycle through create, restart, and archive", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-neovim-tool-service-"))
    const secondRoot = path.join(root, "second-project")
    fs.mkdirSync(secondRoot)
    const previousBinary = process.env.YAADE_NVIM_BIN
    process.env.YAADE_NVIM_BIN = path.resolve("mocks/mock-neovim-server.mjs")
    const config = await loadConfig([
      "--host", "127.0.0.1", "--port", "0",
      "--data-dir", path.join(root, "data"), "--allowed-roots", root, root,
    ])
    const host = await startHostServer(config)
    try {
      const project = host.runtime.db.projects()[0]
      const session = host.runtime.toolSessions.listSessions()[0]
      assert.ok(project)
      assert.ok(session)
      const service = host.runtime.toolService
      assert.ok(service)
      const command = CreateToolUse.make({
        sessionId: session.id,
        kind: "neovim",
        project: ProjectTarget.make({
          projectId: project.id,
          projectPath: project.rootPath,
          projectName: project.name,
        }),
        checkout: MainCheckout.make({ kind: "main" }),
        input: NeovimToolInput.make({ kind: "neovim" }),
      })
      const created = await service.create(command)
      assert.equal(created.status, "running")
      assert.equal(created.output.kind, "neovim")
      assert.equal(host.runtime.neovim.get(created.id)?.generation, 1)

      const restarted = await service.restart(created.id, created.revision)
      assert.equal(restarted.output.kind, "neovim")
      if (restarted.output.kind === "neovim") assert.equal(restarted.output.generation, 2)
      assert.equal(host.runtime.neovim.get(created.id)?.generation, 2)

      const secondProject = host.runtime.db.addProject(secondRoot)
      const changed = await service.updateContext(CreateToolUse.make({
        sessionId: session.id,
        kind: "neovim",
        project: ProjectTarget.make({
          projectId: secondProject.id,
          projectPath: secondProject.rootPath,
          projectName: secondProject.name,
        }),
        checkout: MainCheckout.make({ kind: "main" }),
        input: NeovimToolInput.make({ kind: "neovim" }),
      }), created.id, restarted.revision)
      assert.equal(changed.output.kind, "neovim")
      if (changed.output.kind === "neovim") assert.equal(changed.output.generation, 3)
      assert.equal(host.runtime.neovim.get(created.id)?.cwd, fs.realpathSync(secondRoot))

      await service.archiveUse(created.id)
      assert.equal(host.runtime.neovim.get(created.id), undefined)
      assert.ok(host.runtime.toolSessions.getToolUse(created.id)?.archivedAt)
    } finally {
      await host.close()
      if (previousBinary === undefined) delete process.env.YAADE_NVIM_BIN
      else process.env.YAADE_NVIM_BIN = previousBinary
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
