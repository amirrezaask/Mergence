import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { Schema } from "effect"
import {
  CreateToolUse,
  MainCheckout,
  ProjectTarget,
  SearchToolInput,
  ToolEvent,
  ToolUse,
} from "@yaade/rpc"
import { dispatchPromise } from "../dispatch.js"
import { loadConfig } from "../config.js"
import { startHostServer } from "../server.js"

async function waitFor(check: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for search lifecycle")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function hostWithProject(count = 0) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-search-driver-"))
  const projectRoot = path.join(parent, "project")
  fs.mkdirSync(projectRoot)
  const canonicalProjectRoot = fs.realpathSync(projectRoot)
  for (let index = 0; index < count; index += 1) {
    fs.writeFileSync(path.join(projectRoot, `match-${String(index).padStart(4, "0")}.txt`), "needle\n")
  }
  const config = await loadConfig([
    "--host", "127.0.0.1", "--port", "0",
    "--data-dir", path.join(parent, "data"), "--allowed-roots", parent,
    projectRoot,
  ])
  const host = await startHostServer(config)
  return { host, parent, projectRoot: canonicalProjectRoot }
}

describe("SearchTool driver", () => {
  it("publishes bounded result batches and loads the next persisted page", async () => {
    const { host, parent, projectRoot } = await hostWithProject(240)
    const events: Array<Extract<ToolEvent, { readonly _tag: "SearchResultsAppended" }>> = []
    const unsubscribe = host.runtime.events.subscribe(event => {
      if (event.channel !== "tools:event") return
      const decoded = Schema.decodeUnknownSync(ToolEvent)(event.args[0])
      if (decoded._tag === "SearchResultsAppended") events.push(decoded)
    })
    try {
      const project = host.runtime.db.projects().find(item => item.rootPath === projectRoot)
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
        input: SearchToolInput.make({
          kind: "search",
          query: "needle",
          options: { limit: 120 },
        }),
      })
      const created = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(host.runtime, "tools:createUse", [command], "search-test"),
      )
      await waitFor(() => {
        const output = host.runtime.toolSessions.getToolUse(created.id)?.output
        return output?.kind === "search" && output.resultCount === 120
      })
      const first = host.runtime.toolSessions.getToolUse(created.id)
      assert.ok(first)
      assert.equal(first.output.kind, "search")
      if (first.output.kind !== "search") return
      assert.equal(first.output.resultCount, 120)
      assert.equal(first.output.nextCursor, "120")
      assert.ok(events.length >= 2)
      assert.ok(events.every(event => event.results.length <= 100))
      assert.equal(host.runtime.toolSessions.listSearchResults(created.id, first.output.resultRevision, 0, 500).length, 120)

      await dispatchPromise(host.runtime, "tools:loadMore", [{
        _tag: "ListSearchResults",
        toolUseId: created.id,
        resultRevision: first.output.resultRevision,
        cursor: 120,
        limit: 120,
      }], "search-test")
      await waitFor(() => {
        const output = host.runtime.toolSessions.getToolUse(created.id)?.output
        return output?.kind === "search" && output.resultCount === 240
      })
      const completed = host.runtime.toolSessions.getToolUse(created.id)
      assert.ok(completed)
      assert.equal(completed.status, "succeeded")
      assert.equal(host.runtime.toolSessions.listSearchResults(created.id, first.output.resultRevision, 0, 500).length, 240)
    } finally {
      unsubscribe()
      await host.close()
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it("turns a search host failure into a failed ToolUse rather than leaving it running", async () => {
    const { host, parent, projectRoot } = await hostWithProject()
    const previousRgPath = process.env.YAADE_RG_PATH
    process.env.YAADE_RG_PATH = path.join(parent, "missing-rg")
    try {
      const project = host.runtime.db.projects().find(item => item.rootPath === projectRoot)
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
        input: SearchToolInput.make({ kind: "search", query: "needle", options: {} }),
      })
      const created = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(host.runtime, "tools:createUse", [command], "search-failure-test"),
      )
      await waitFor(() => host.runtime.toolSessions.getToolUse(created.id)?.status === "failed")
      const failed = host.runtime.toolSessions.getToolUse(created.id)
      assert.ok(failed?.error)
      assert.equal(failed?.output.kind, "search")
      if (failed?.output.kind === "search") assert.equal(failed.output.running, false)
    } finally {
      if (previousRgPath === undefined) delete process.env.YAADE_RG_PATH
      else process.env.YAADE_RG_PATH = previousRgPath
      await host.close()
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it("rejects stale search results after a fast input change", async () => {
    const { host, parent, projectRoot } = await hostWithProject(80)
    try {
      const project = host.runtime.db.projects().find(item => item.rootPath === projectRoot)
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
          input: SearchToolInput.make({ kind: "search", query: "needle", options: { limit: 80 } }),
        })], "search-stale-test"),
      )
      await waitFor(() => {
        const output = host.runtime.toolSessions.getToolUse(created.id)?.output
        return output?.kind === "search" && output.resultCount > 0
      })
      const first = host.runtime.toolSessions.getToolUse(created.id)
      assert.ok(first)
      assert.equal(first.output.kind, "search")
      const firstRevision = first.output.kind === "search" ? first.output.resultRevision : 0
      const updated = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(host.runtime, "tools:updateUseInput", [{
          _tag: "UpdateToolUseInput",
          toolUseId: first.id,
          inputRevision: first.inputRevision,
          input: SearchToolInput.make({ kind: "search", query: "missing-token-xyz", options: { limit: 80 } }),
        }], "search-stale-test"),
      )
      await waitFor(() => {
        const output = host.runtime.toolSessions.getToolUse(updated.id)?.output
        return output?.kind === "search" && output.resultRevision > firstRevision && output.running === false
      })
      const finalUse = host.runtime.toolSessions.getToolUse(updated.id)
      assert.ok(finalUse)
      assert.equal(finalUse.input.kind, "search")
      if (finalUse.input.kind === "search") assert.equal(finalUse.input.query, "missing-token-xyz")
      assert.equal(finalUse.output.kind, "search")
      if (finalUse.output.kind === "search") {
        assert.ok(finalUse.output.resultRevision > firstRevision)
        assert.equal(finalUse.output.resultCount, 0)
        assert.equal(
          host.runtime.toolSessions.listSearchResults(finalUse.id, finalUse.output.resultRevision, 0, 500).length,
          0,
        )
      }
    } finally {
      await host.close()
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it("cancels a running search and restarts with a fresh result revision", async () => {
    const { host, parent, projectRoot } = await hostWithProject(120)
    try {
      const project = host.runtime.db.projects().find(item => item.rootPath === projectRoot)
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
          input: SearchToolInput.make({ kind: "search", query: "needle", options: { limit: 120 } }),
        })], "search-restart-test"),
      )
      await waitFor(() => {
        const output = host.runtime.toolSessions.getToolUse(created.id)?.output
        return output?.kind === "search" && output.resultCount > 0
      })
      const live = host.runtime.toolSessions.getToolUse(created.id)
      assert.ok(live)
      const cancelled = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(host.runtime, "tools:cancelUse", [live.id, live.revision], "search-restart-test"),
      )
      assert.equal(cancelled.status, "cancelled")
      const restarted = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(host.runtime, "tools:restartUse", [cancelled.id, cancelled.revision], "search-restart-test"),
      )
      assert.equal(restarted.output.kind, "search")
      const previousRevision = cancelled.output.kind === "search" ? cancelled.output.resultRevision : 0
      if (restarted.output.kind === "search") {
        assert.ok(restarted.output.resultRevision > previousRevision)
      }
      await waitFor(() => {
        const output = host.runtime.toolSessions.getToolUse(restarted.id)?.output
        return output?.kind === "search" && output.running === false && output.resultCount > 0
      })
      const recovered = host.runtime.toolSessions.getToolUse(restarted.id)
      assert.ok(recovered)
      assert.ok(recovered.status === "succeeded" || recovered.status === "waiting" || recovered.status === "running")
      assert.equal(recovered.output.kind, "search")
      if (recovered.output.kind === "search") assert.ok(recovered.output.resultCount > 0)
    } finally {
      await host.close()
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
})
