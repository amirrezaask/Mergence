import { expect, test } from "@playwright/test"
import { execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expectListRows } from "../helpers/list.js"
import { launchJet, waitForProjectPage } from "./_launch.js"

function createRepository(prefix: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const project = path.join(home, "repo")
  fs.mkdirSync(path.join(project, "src"), { recursive: true })
  fs.writeFileSync(path.join(project, "src", "app.ts"), "export const ready = true\n")
  execSync(
    "git init && git config user.email test@example.com && git config user.name Cockpit && git add . && git commit -m 'feat: seed cockpit'",
    { cwd: project, stdio: "ignore" },
  )
  fs.appendFileSync(path.join(project, "src", "app.ts"), "export const followUp = true\n")
  execSync("git add . && git commit -m 'fix: add cockpit follow-up'", {
    cwd: project,
    stdio: "ignore",
  })
  fs.appendFileSync(path.join(project, "src", "app.ts"), "export const dirty = true\n")
  return { home }
}

test.describe("project cockpit", () => {
  test("keeps the agent/worktree navigation compact and responsive", async () => {
    const { home } = createRepository("yaade-cockpit-")
    const { app, page } = await launchJet({
      homeDir: home,
      startPath: "/repo",
      launchWithoutWorkspace: true,
      projectPage: true,
    })
    try {
      await waitForProjectPage(page)
      await expect
        .poll(() =>
          page.evaluate(() => ({
            overview: document.querySelectorAll('[data-yaade-project-tab="overview"]').length,
            tabs: document.querySelectorAll("[data-yaade-project-tab]").length,
            worktreeSwitcher: document.querySelectorAll("[data-yaade-worktree-switcher]").length,
            agentSwitcher: document.querySelectorAll("[data-yaade-agent-switcher]").length,
            historyGroup: document.querySelectorAll("[data-yaade-project-git-history-group]").length,
            mainWorktree: document.querySelectorAll('[data-yaade-project-worktree-item="main"]').length,
          })),
        )
        .toEqual({ overview: 0, tabs: 0, worktreeSwitcher: 0, agentSwitcher: 0, historyGroup: 1, mainWorktree: 1 })

      await page.locator('[data-yaade-project-worktree-item="main"]').click()
      await expectListRows(page, {
        panel: "git-history",
        minItems: 3,
        needle: "fix: add cockpit follow-up",
        noResultsText: "No commits yet",
      })

      await page.setViewportSize({ width: 390, height: 844 })
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true)

      await page.evaluate(() => {
        document.documentElement.dataset.yaadeReducedMotion = "true"
      })
      expect(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue("--yaade-motion-panel")
            .trim(),
        ),
      ).toMatch(/^0(?:ms|s)$/)

      await page.evaluate(() => {
        localStorage.setItem("jet-theme-id", "default-light")
        localStorage.setItem("jet-color-scheme", "light")
        localStorage.setItem(
          "jet-appearance-settings",
          JSON.stringify({ themeId: "default-light" }),
        )
      })
      await page.reload()
      await waitForProjectPage(page)
      expect(
        await page.evaluate(() =>
          document.documentElement.classList.contains("dark"),
        ),
      ).toBe(false)
    } finally {
      await app.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
