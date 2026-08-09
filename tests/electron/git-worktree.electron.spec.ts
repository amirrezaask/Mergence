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

test.describe("git worktree sessions", () => {
  test.skip(!hasGit(), "git not available")

  test("worktree session spawns terminal in the worktree cwd", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-wt-home-"))
    const project = path.join(home, "repo")
    fs.mkdirSync(project, { recursive: true })
    execSync("git init && git config user.email t@t && git config user.name t && echo hi > README && git add . && git commit -m init", {
      cwd: project,
      stdio: "ignore",
    })

    const { app, page } = await launchJet({
      homeDir: home,
      startPath: "/repo",
      launchWithoutWorkspace: true,
      projectPage: true,
    })
    try {
      await waitForProjectPage(page)
      const branch = `e2e-wt-${Date.now().toString(36)}`
      await page.evaluate(async br => {
        await window.__yaadeAgent!.createProjectSession?.({
          title: br,
          worktree: { branch: br },
        })
      }, branch)
      await waitForMux(page)
      await page.evaluate(() => window.__yaadeAgent!.executeCommand("terminal.new"))
      await page.locator("[data-yaade-terminal-panel]").waitFor({
        state: "visible",
        timeout: 15_000,
      })

      const state = await page.evaluate(() => window.__yaadeAgent!.getState())
      expect(state.sessionCwd).toContain(".yaade/worktrees")
      expect(fs.existsSync(state.sessionCwd!)).toBe(true)

      await page.locator("[data-yaade-terminal-panel]").first().click()
      await page.keyboard.type("pwd")
      await page.keyboard.press("Enter")
      await waitForTerminalText(page, ".yaade/worktrees")
    } finally {
      await app.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  test("worktrees picker opens main and can create a worktree", async () => {
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

      await expect
        .poll(() =>
          page.evaluate(() => {
            const tabs = [
              ...document.querySelectorAll("[data-yaade-project-tab]"),
            ].map(el => el.getAttribute("data-yaade-project-tab"))
            return tabs
          }),
        )
        .toEqual(["changes", "agents", "editors", "terminals", "history"])

      await page.locator('[data-yaade-project-tab="terminals"]').click()
      const switcher = page.locator(
        '[data-yaade-worktree-switcher-for="terminals"]',
      )
      await switcher.waitFor({ state: "visible" })

      await switcher.click()
      const menu = page.locator(
        '[data-yaade-worktree-switcher-menu-for="terminals"]',
      )
      await menu.waitFor({ state: "visible" })
      await page.locator("[data-yaade-worktree-main]").waitFor({
        state: "visible",
      })
      await page.locator("[data-yaade-worktree-create]").waitFor({
        state: "visible",
      })
      await expect
        .poll(() =>
          page.evaluate(() => {
            const input = document.querySelector(
              "[data-yaade-worktree-switcher-search]",
            )
            return input === document.activeElement
          }),
        )
        .toBe(true)

      await page.locator("[data-yaade-worktree-main]").click()
      await waitForMux(page)
      await expect
        .poll(() =>
          page.evaluate(() => {
            const cwd = window.__yaadeAgent!.getState().sessionCwd ?? ""
            return {
              isRepo: /\/repo$/.test(cwd),
              isWorktree: cwd.includes(".yaade/worktrees"),
            }
          }),
        )
        .toEqual({ isRepo: true, isWorktree: false })

      await page.locator('[data-yaade-project-tab="changes"]').click()
      await page.locator('[data-yaade-project-panel="changes"]').waitFor({
        state: "visible",
      })

      const changesSwitcher = page.locator(
        '[data-yaade-worktree-switcher-for="changes"]',
      )
      await changesSwitcher.click()
      const changesMenu = page.locator(
        '[data-yaade-worktree-switcher-menu-for="changes"]',
      )
      await changesMenu.waitFor({ state: "visible" })
      await page.locator("[data-yaade-worktree-create]").waitFor({
        state: "visible",
      })
      await page.locator("[data-yaade-worktree-create]").click()
      const dialog = page.locator("[data-yaade-create-worktree-dialog]")
      await dialog.waitFor({ state: "visible" })
      const branch = `picker-wt-${Date.now().toString(36)}`
      await dialog.locator("[data-yaade-worktree-branch]").fill(branch)
      await dialog.locator("[data-yaade-create-worktree]").click()
      await expect
        .poll(
          async () => (await changesSwitcher.textContent()) ?? "",
          { timeout: 5_000 },
        )
        .toContain(branch)
      await expect
        .poll(() =>
          page.evaluate(() => new URLSearchParams(location.search).get("checkout")),
        )
        .toContain(".yaade/worktrees")
    } finally {
      await app.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
