import { expect, test } from "@playwright/test"
import { execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  launchJet,
  waitForMux,
  waitForProjectPage,
  waitForTerminalText,
} from "./_launch.js"

function hasGit(): boolean {
  try {
    execSync("which git", { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

test.describe("per-surface worktrees", () => {
  test.skip(!hasGit(), "git not available")

  test("one project session; terminal launch into a worktree keeps session on Main", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-wt-home-"))
    const project = path.join(home, "repo")
    fs.mkdirSync(project, { recursive: true })
    execSync(
      "git init && git config user.email t@t && git config user.name t && echo hi > README && git add . && git commit -m init",
      {
        cwd: project,
        stdio: "ignore",
      },
    )

    const { app, page } = await launchJet({
      homeDir: home,
      startPath: "/repo",
      launchWithoutWorkspace: true,
      projectPage: true,
    })
    try {
      await waitForProjectPage(page)
      const branch = `e2e-wt-${Date.now().toString(36)}`
      const created = await page.evaluate(async br => {
        return window.__yaadeAgent!.createProjectSession?.({
          title: "Main",
          worktree: { branch: br },
        })
      }, branch)
      expect(created?.id).toBeTruthy()
      expect(created?.createdWorktree?.path).toContain(".yaade/worktrees")
      await waitForMux(page)

      const before = await page.evaluate(() => window.__yaadeAgent!.getState())
      expect(before.sessionCwd).toMatch(/\/repo$/)
      expect(before.sessionCwd).not.toContain(".yaade/worktrees")
      const sessionId = before.sessionId

      await page.locator('[data-yaade-project-tab="terminals"]').click()
      await page.locator('[data-yaade-project-panel="terminals"]').waitFor({
        state: "visible",
      })
      await page.locator("[data-yaade-instance-sidebar-new]").click()
      const dialog = page.locator("[data-yaade-worktree-switcher-menu]")
      await dialog.waitFor({ state: "visible" })
      await page.locator(`[data-yaade-worktree-item="${branch}"]`).click()

      await page.locator("[data-yaade-terminal-panel]").waitFor({
        state: "visible",
        timeout: 15_000,
      })

      const after = await page.evaluate(() => window.__yaadeAgent!.getState())
      expect(after.sessionId).toBe(sessionId)
      expect(after.sessionCwd).toMatch(/\/repo$/)

      await expect
        .poll(async () =>
          page
            .locator("[data-yaade-instance-sidebar='terminals'] [data-yaade-list-item]")
            .first()
            .textContent(),
        )
        .toContain(branch)

      await page.locator("[data-yaade-terminal-panel]").first().click()
      await page.keyboard.type("pwd")
      await page.keyboard.press("Enter")
      await waitForTerminalText(page, ".yaade/worktrees")
    } finally {
      await app.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  test("Changes tab worktree switcher remounts git root without swapping session", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-wt-picker-"))
    const project = path.join(home, "repo")
    fs.mkdirSync(project, { recursive: true })
    execSync(
      "git init && git config user.email t@t && git config user.name t && echo hi > README && git add . && git commit -m init",
      { cwd: project, stdio: "ignore" },
    )

    const { app, page } = await launchJet({
      homeDir: home,
      startPath: "/repo",
      launchWithoutWorkspace: true,
      projectPage: true,
    })
    try {
      await waitForProjectPage(page)

      await page.locator('[data-yaade-project-tab="changes"]').click()
      await page.locator('[data-yaade-project-panel="changes"]').waitFor({
        state: "visible",
      })

      const switcher = page.locator(
        '[data-yaade-app-header] [data-yaade-worktree-switcher]',
      )
      await switcher.waitFor({ state: "visible" })
      await expect
        .poll(async () => (await switcher.textContent()) ?? "")
        .toContain("Main")

      // Agents/Terminals surfaces do not show the Changes checkout switcher.
      await page.locator('[data-yaade-project-tab="terminals"]').click()
      await waitForMux(page)
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.querySelectorAll(
                "[data-yaade-app-header] [data-yaade-worktree-switcher]",
              ).length,
          ),
        )
        .toBe(0)
      const sessionId = await page.evaluate(
        () => window.__yaadeAgent!.getState().sessionId,
      )

      await page.locator('[data-yaade-project-tab="changes"]').click()
      await switcher.waitFor({ state: "visible" })
      await switcher.click()
      const menu = page.locator("[data-yaade-worktree-switcher-menu]")
      await menu.waitFor({ state: "visible" })
      await page.locator("[data-yaade-worktree-create]").click()
      const dialog = page.locator("[data-yaade-create-worktree-dialog]")
      await dialog.waitFor({ state: "visible" })
      const branch = `picker-wt-${Date.now().toString(36)}`
      await dialog.locator("[data-yaade-worktree-branch]").fill(branch)
      await dialog.locator("[data-yaade-create-worktree]").click()
      await expect
        .poll(async () => (await switcher.textContent()) ?? "", {
          timeout: 5_000,
        })
        .toContain(branch)

      await expect
        .poll(() =>
          page.evaluate(() => {
            const checkout = new URLSearchParams(location.search).get("checkout")
            return checkout != null && checkout.length > 0 && checkout !== "main"
          }),
        )
        .toBe(true)

      const after = await page.evaluate(() => window.__yaadeAgent!.getState())
      expect(after.sessionId).toBe(sessionId)
      expect(after.sessionCwd).toMatch(/\/repo$/)

      await expect
        .poll(() =>
          page
            .locator(
              `[data-yaade-project-panel="changes"] [data-yaade-git-root]`,
            )
            .getAttribute("data-yaade-git-root"),
        )
        .toContain(".yaade/worktrees")
    } finally {
      await app.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
