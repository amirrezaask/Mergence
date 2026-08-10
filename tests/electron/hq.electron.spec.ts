import { expect, test } from "@playwright/test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expectListRows } from "../helpers/list.js"
import { launchJet, waitForHq, waitForProjectPage } from "./_launch.js"

function installFakeProviders(root: string): string {
  const bin = path.join(root, "bin")
  fs.mkdirSync(bin, { recursive: true })
  const script = `#!/bin/sh
case "$1" in
  --version|-V|version) echo "fake-agent 1.0.0"; exit 0 ;;
esac
printf 'YAADE_FAKE_AGENT_READY\\n'
trap 'exit 0' TERM INT
while IFS= read -r line; do printf 'YAADE_FAKE:%s\\n' "$line"; done
`
  for (const provider of ["codex", "claude"]) {
    const target = path.join(bin, provider)
    fs.writeFileSync(target, script)
    fs.chmodSync(target, 0o755)
  }
  return bin
}

type SeededAgent = {
  runId: string
  generation: number
  workspaceId: string
  ptyId: string
}

async function seedAgent(
  page: Awaited<ReturnType<typeof launchJet>>["page"],
  input: {
    rootPath: string
    title: string
    provider: "codex" | "claude"
    permission?: boolean
  },
): Promise<SeededAgent> {
  return page.evaluate(async seed => {
    const projectResponse = await fetch("/api/v1/projects/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootPath: seed.rootPath }),
    })
    if (!projectResponse.ok) throw new Error(await projectResponse.text())
    const { project } = (await projectResponse.json()) as {
      project: { id: string }
    }
    const checkoutResponse = await fetch(
      "/api/v1/project-sessions/open-checkout",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, checkoutKey: "main" }),
      },
    )
    if (!checkoutResponse.ok) throw new Error(await checkoutResponse.text())
    const workspace = (await checkoutResponse.json()) as { id: string }
    const launched = await window.yaade!.agents!.launch({
      launchRequestId: `hq-e2e-${seed.provider}-${crypto.randomUUID()}`,
      provider: seed.provider,
      projectId: project.id,
      workspaceId: workspace.id,
      checkoutKey: "main",
      title: seed.title,
    })
    if (!launched.pty) throw new Error("agent launch did not return a PTY")
    await window.yaade!.agents!.ingestNative({
      provider: seed.provider,
      sessionId: launched.run.runId,
      processId: launched.pty.id,
      projectId: project.id,
      payload: seed.permission
        ? { hook_event_name: "PermissionRequest", permission_id: "e2e-permission" }
        : { hook_event_name: "Stop", turn_id: "e2e-turn" },
    })
    return {
      runId: launched.run.runId,
      generation: launched.run.generation,
      workspaceId: workspace.id,
      ptyId: launched.pty.id,
    }
  }, input)
}

test.describe("YAADE HQ", () => {
  test("lists projects in the collapsible HQ sidebar", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-hq-project-switcher-"))
    const home = path.join(root, "home")
    const alpha = path.join(home, "alpha")
    const beta = path.join(home, "beta")
    fs.mkdirSync(alpha, { recursive: true })
    fs.mkdirSync(beta, { recursive: true })

    const { app, page } = await launchJet({
      homeDir: home,
      startPath: "/",
      launchWithoutWorkspace: true,
      hq: true,
    })
    try {
      expect(await page.locator('[data-yaade-hq-summary=""]').count()).toBe(0)
      expect(await page.locator('[data-yaade-project-sidebar=""]').count()).toBe(1)
      expect(await page.locator('[data-yaade-hq-column="agents"]').count()).toBe(1)
      await page.evaluate(async roots => {
        for (const rootPath of roots) {
          const response = await fetch("/api/v1/projects/open", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rootPath }),
          })
          if (!response.ok) throw new Error(await response.text())
        }
        window.dispatchEvent(new Event("yaade:agent-signal"))
      }, [alpha, beta])

      const sidebarProjects = page.locator("[data-yaade-project-sidebar-item]")
      await expect.poll(() => sidebarProjects.count()).toBeGreaterThanOrEqual(2)
      const sidebarProjectText = await page.evaluate(() =>
        [...document.querySelectorAll("[data-yaade-project-sidebar-item]")]
          .map(item => item.textContent ?? "")
          .join(" "),
      )
      expect(sidebarProjectText).toContain("alpha")
      expect(sidebarProjectText).toContain("beta")

      await page.locator('[data-yaade-project-sidebar-toggle=""]').click()
      await expect
        .poll(() =>
          page
            .locator('[data-yaade-project-sidebar=""]')
            .getAttribute("data-yaade-sidebar-state"),
        )
        .toBe("collapsed")
      await page.locator('[data-yaade-project-sidebar-toggle=""]').click()

      await page.getByRole("button", { name: "Add project" }).click()
      await page
        .locator('[data-yaade-project-switcher-menu=""]')
        .waitFor({ state: "visible" })
      expect(await page.locator('[data-slot="dialog-overlay"]').count()).toBe(0)
      expect(await page.locator('[data-yaade-open-project-item]').count()).toBeGreaterThanOrEqual(2)

      const search = page.locator('[data-yaade-project-switcher-search=""]')
      await search.fill("~/beta")
      await expectListRows(page, {
        panel: "project-switcher",
        minItems: 1,
        needle: beta,
        noResultsText: "Path does not exist or is not a directory.",
      })
      await search.press("Enter")
      await waitForProjectPage(page)
      expect(await page.evaluate(() => location.pathname)).toBe("/beta")
    } finally {
      await app.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("uses authoritative live runs and direct agent anchors", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-hq-runs-"))
    const home = path.join(root, "home")
    const alpha = path.join(home, "alpha")
    fs.mkdirSync(alpha, { recursive: true })
    const bin = installFakeProviders(root)
    const { app, page } = await launchJet({
      homeDir: home,
      startPath: "/",
      launchWithoutWorkspace: true,
      hq: true,
      env: {
        JET_ALLOWED_ROOTS: root,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    })
    try {
      const agent = await seedAgent(page, {
        rootPath: alpha,
        title: "Codex Alpha",
        provider: "codex",
        permission: true,
      })
      await expectListRows(page, {
        panel: "hq-agents",
        minItems: 1,
        needle: "Codex Alpha",
        noResultsText: "No live agents",
      })
      const row = page.locator(`[data-yaade-hq-agent="${agent.runId}"]`)
      await expect.poll(() => row.count()).toBe(1)
      const href = await row.getByRole("link", { name: /Codex Alpha/ }).getAttribute("href")
      expect(href).toContain(`view=agents`)
      expect(href).not.toContain("s=")
      expect(href).toContain(`agent=${encodeURIComponent(agent.runId)}`)

      await row.getByRole("link", { name: /Codex Alpha/ }).click()
      await waitForProjectPage(page)
      expect(await page.evaluate(() => location.pathname)).toBe("/alpha")
      const route = await page.evaluate(() => Object.fromEntries(new URLSearchParams(location.search)))
      expect(route).toMatchObject({
        view: "agents",
        agent: agent.runId,
      })
      expect(route.s).toBeUndefined()
      await expect
        .poll(() => page.locator("[data-yaade-hq-agent-dialog]").count())
        .toBe(0)
      await expect
        .poll(() =>
          page
            .locator('[data-yaade-project-tab="agents"]')
            .getAttribute("aria-selected"),
        )
        .toBe("true")
      await expect
        .poll(() =>
          page.locator(
            `[data-yaade-instance-sidebar-item="${agent.runId}"]`,
          ).count(),
        )
        .toBe(1)
      await expectListRows(page, {
        panel: "project-agents",
        minItems: 1,
        needle: "Codex Alpha",
        noResultsText: "No agents yet",
      })
      await page.locator('[data-yaade-project-tab="history"]').click()
      await page.locator('[data-yaade-project-tab="agents"]').click()
      await page.reload()
      await waitForProjectPage(page)
      await expect
        .poll(() => page.locator(`[data-yaade-instance-sidebar-item="${agent.runId}"]`).count())
        .toBe(1)
      const restored = await page.evaluate(runId => window.yaade!.agents!.get(runId), agent.runId)
      expect(restored?.ptyId).toBe(agent.ptyId)
      expect(restored?.processState).toBe("running")
    } finally {
      await app.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

})
