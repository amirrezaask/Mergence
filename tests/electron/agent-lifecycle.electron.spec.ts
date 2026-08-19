import { expect } from "@playwright/test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "../fixtures/e2e.js"
import { launchWeb } from "../shell/launch-web.js"

test.describe("long-running agent lifecycle", () => {
  test.skip(process.platform === "win32", "the deterministic agent shim uses a POSIX shebang")

  test("keeps a live agent in the sidebar and projects permission attention", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-agent-e2e-"))
    const bin = path.join(root, "bin")
    fs.mkdirSync(bin)
    fs.writeFileSync(
      path.join(bin, "claude"),
      [
        "#!/usr/bin/env node",
        "if (process.argv.includes('--version')) { console.log('claude-e2e 1.0'); process.exit(0) }",
        "console.log('FAKE_AGENT_READY')",
        "process.stdin.resume()",
        "setInterval(() => {}, 1e9)",
        "",
      ].join("\n"),
      { mode: 0o755 },
    )

    const pathEnv = [bin, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter)
    const result = await launchWeb({
      workspaceRel: "fixtures/sample-workspace",
      userDataDir: root,
      env: { PATH: pathEnv },
    })
    try {
      const target = await result.page.evaluate(async () => {
        const project = (await window.yaade?.tools?.listProjects())?.[0]
        if (!project) throw new Error("project is unavailable")
        return {
          projectId: project.projectId,
          projectPath: project.projectPath,
        }
      })

      const instance = await result.page.evaluate(async input => {
        const terminal = window.yaade?.terminal
        if (!terminal) throw new Error("terminal API is unavailable")
        return terminal.createInstance({
          launchRequestId: "agent-e2e-launch",
          provider: "claude",
          projectId: input.projectId,
          checkoutKey: "main",
          checkoutPath: input.projectPath,
          title: "Claude",
        })
      }, target)
      const ptyId = instance.ptyId
      if (!ptyId) throw new Error("agent launch did not return a PTY")

      await expect
        .poll(
          () =>
            result.page.evaluate(async () => {
              const live = await window.yaade!.agents.listLive()
              return live.map(run => run.runId)
            }),
          { timeout: 30_000 },
        )
        .toContain(instance.id)
      const row = result.page.locator(
        `[data-yaade-running-agent="${instance.id}"]`,
      )
      await expect(row).toBeVisible({ timeout: 30_000 })

      await result.page.evaluate(async input => {
        const agents = window.yaade?.agents
        if (!agents) throw new Error("agent API is unavailable")
        await agents.ingestNative({
          provider: "claude",
          sessionId: input.runId,
          processId: input.ptyId,
          projectId: input.projectId,
          payload: {
            hook_event_name: "SessionStart",
            session_id: "native-agent-e2e",
            source: "startup",
          },
        })
        await agents.ingestNative({
          provider: "claude",
          sessionId: input.runId,
          processId: input.ptyId,
          projectId: input.projectId,
          payload: {
            hook_event_name: "PermissionRequest",
            session_id: "native-agent-e2e",
            permission_id: "permission-e2e",
            tool_name: "Bash",
          },
        })
      }, {
        runId: instance.id,
        ptyId,
        projectId: target.projectId,
      })

      await expect(row).toHaveAttribute(
        "data-yaade-agent-status",
        "waiting_for_permission",
        { timeout: 30_000 },
      )
      await expect(
        row.getByRole("button", { name: "Claude, Needs permission" }),
      ).toBeVisible()

      const counts = await result.page.evaluate(() =>
        window.yaade!.notifications.counts(),
      )
      expect(counts.actionRequired).toBeGreaterThan(0)

      await expect
        .poll(
          () =>
            result.page.evaluate(async id => {
              const attached = await window.yaade!.terminal.attach(id)
              return (attached?.outputChunks ?? [attached?.output ?? ""]).join("")
            }, ptyId),
          { timeout: 15_000 },
        )
        .toContain("FAKE_AGENT_READY")

      await result.page.evaluate(async run => {
        await window.yaade!.terminal.closeInstance({
          id: run.id,
          generation: run.generation,
        })
      }, { id: instance.id, generation: instance.generation })
      await expect(row).toHaveCount(0, { timeout: 30_000 })
    } finally {
      await result.app.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
