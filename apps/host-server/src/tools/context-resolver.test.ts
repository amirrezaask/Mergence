import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { MainCheckout, CreateToolUse, ProjectTarget, SessionId, TerminalToolInput } from "@yaade/rpc"
import { Schema } from "effect"
import { ProjectDatabase } from "../persistence.js"
import { resolveToolContext } from "./context-resolver.js"

function config(root: string) {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: path.join(root, "data"),
    allowedRoots: [fs.realpathSync(root)],
    openBrowser: false,
    launchPath: root,
    launchConfig: { workspacePath: root, source: "default" as const },
    staticDir: null,
    authToken: null,
    ptySupervisor: false,
    killPtysOnShutdown: true,
  }
}

describe("tool context resolver", () => {
  it("resolves Main from the host project catalog", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-tool-context-"))
    const db = new ProjectDatabase(path.join(root, "db.sqlite3"))
    try {
      const project = db.addProject(root, "Fixture")
      const command = CreateToolUse.make({
        sessionId: Schema.decodeUnknownSync(SessionId)("ses-test"),
        kind: "terminal",
        project: ProjectTarget.make({ projectId: project.id, projectPath: project.rootPath, projectName: project.name }),
        checkout: MainCheckout.make({ kind: "main" }),
        input: TerminalToolInput.make({ kind: "terminal" }),
      })
      // The resolver only needs a valid project target; session validation is a store concern.
      const context = await resolveToolContext({ config: config(root), db, homeDir: root }, command)
      assert.equal(context.checkoutKey, "main")
      assert.equal(context.checkoutPath, fs.realpathSync(root))
      assert.equal(context.project.projectId, project.id)
    } finally {
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects a browser-supplied project path that differs from the catalog", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-tool-context-"))
    const db = new ProjectDatabase(path.join(root, "db.sqlite3"))
    try {
      const project = db.addProject(root, "Fixture")
      const command = CreateToolUse.make({
        sessionId: Schema.decodeUnknownSync(SessionId)("ses-test"),
        kind: "terminal",
        project: ProjectTarget.make({ projectId: project.id, projectPath: path.join(root, "elsewhere"), projectName: project.name }),
        checkout: MainCheckout.make({ kind: "main" }),
        input: TerminalToolInput.make({ kind: "terminal" }),
      })
      await assert.rejects(
        resolveToolContext({ config: config(root), db, homeDir: root }, command),
        /project target is unavailable/,
      )
    } finally {
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
