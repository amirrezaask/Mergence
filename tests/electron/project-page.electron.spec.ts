import { expect, test } from "@playwright/test"
import { execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expectListRows } from "../helpers/list.js"
import { launchJet, waitForProjectPage } from "./_launch.js"

test.describe("project page", () => {
  test("a bare project URL registers the directory and lands on Changes/Main", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-project-route-"))
    const project = path.join(home, "repo")
    fs.mkdirSync(project, { recursive: true })
    execSync(
      "git init && git config user.email t@t && git config user.name tester && echo one > note.txt && git add . && git commit -m seed",
      { cwd: project, stdio: "ignore" },
    )

    const { app, page } = await launchJet({
      projectPage: true,
      launchWithoutWorkspace: true,
      homeDir: home,
      startPath: "/repo",
    })
    try {
      await waitForProjectPage(page)
      const tabs = page.locator("[data-yaade-project-tab]")
      await expect.poll(() => tabs.count()).toBe(5)
      expect(
        await tabs.evaluateAll(items => items.map(item => item.textContent?.trim())),
      ).toEqual([
        "Changes",
        "Agents",
        "Editors",
        "Terminals",
        "History",
      ])
      await expect
        .poll(() =>
          page
            .locator('[data-yaade-project-tab="changes"]')
            .getAttribute("aria-selected"),
        )
        .toBe("true")
      await expect
        .poll(async () =>
          (await page
            .locator('[data-yaade-git-toolbar] [data-yaade-worktree-switcher]')
            .textContent()) ?? "",
        )
        .toContain("Main")
      const dock = page.locator('[data-yaade-project-dock]')
      await dock.waitFor({ state: "visible" })
      expect(
        await page.locator('[data-yaade-shell="project"] [data-yaade-app-header]').count(),
      ).toBe(0)
      const dockBox = await dock.boundingBox()
      const viewport = page.viewportSize()
      expect(dockBox).not.toBeNull()
      expect(viewport).not.toBeNull()
      expect(dockBox!.y + dockBox!.height).toBeGreaterThan(viewport!.height - 48)
      expect(await page.evaluate(() => location.search)).toBe("")

      const projects = await page.evaluate(async () => {
        const response = await fetch("/api/v1/hq")
        return (await response.json()).projects as Array<{ rootPath: string }>
      })
      expect(
        projects.some(item => fs.realpathSync(item.rootPath) === fs.realpathSync(project)),
      ).toBe(true)

      await expect
        .poll(() =>
          page.locator('[data-yaade-project-tab="native-agents"]').count(),
        )
        .toBe(0)
      await expect
        .poll(() =>
          page.locator('[data-yaade-project-tab="agents"]').count(),
        )
        .toBe(1)
    } finally {
      await app.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  test("a missing URL directory is actionable and is never created", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-project-missing-"))
    const missing = path.join(home, "missing")
    const { app, page } = await launchJet({
      projectPage: true,
      launchWithoutWorkspace: true,
      expectBootError: true,
      expectedHttpErrors: [
        { method: "POST", path: "/api/v1/projects/open", status: 404 },
      ],
      homeDir: home,
      startPath: "/missing",
    })
    try {
      await page.locator('[data-yaade-boot="error"]').waitFor({
        state: "visible",
        timeout: 15_000,
      })
      await expect
        .poll(async () =>
          (await page.locator('[data-yaade-boot="error"]').textContent()) ?? "",
        )
        .toMatch(/does not exist|not found/i)
      await expect
        .poll(() =>
          page
            .locator('[data-yaade-boot="error"]')
            .getByRole("button", { name: "Open Project" })
            .isVisible(),
        )
        .toBe(true)
      expect(fs.existsSync(missing)).toBe(false)
    } finally {
      await app.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  test("history tab shows current changes; commit opens changes dialog", async () => {
    test.skip(
      (() => {
        try {
          execSync("which git", { stdio: "ignore" })
          return false
        } catch {
          return true
        }
      })(),
      "git not available",
    )

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-history-diff-"))
    const project = path.join(home, "repo")
    fs.mkdirSync(project, { recursive: true })
    execSync(
      "git init && git config user.email t@t && git config user.name t && echo one > note.txt && git add . && git commit -m alpha && echo two > note.txt && git add . && git commit -m beta && echo dirty >> note.txt",
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
      await page.locator('[data-yaade-project-tab="history"]').click()
      expect(
        await page.locator('[data-yaade-git-toolbar] [data-yaade-git-commit-trigger]').count(),
      ).toBe(0)
      await page
        .locator('[data-yaade-list-panel="git-history"] [data-yaade-git-working-tree]')
        .waitFor({ state: "visible", timeout: 15_000 })
      await expect
        .poll(
          async () =>
            (await page
              .locator(
                '[data-yaade-list-panel="git-history"] [data-yaade-git-working-tree]',
              )
              .textContent()) ?? "",
          { timeout: 5_000 },
        )
        .toMatch(/Current changes/)

      await page
        .locator('[data-yaade-list-panel="git-history"] [data-yaade-list-item]')
        .filter({ hasText: "beta" })
        .click()

      await page.locator("[data-yaade-commit-changes-dialog]").waitFor({
        state: "visible",
        timeout: 10_000,
      })
      await expectListRows(page, {
        panel: "commit-changes-files",
        minItems: 1,
        needle: "note.txt",
        noResultsText: "No files changed",
      })

      await page
        .locator('[data-yaade-list-panel="commit-changes-files"] [data-yaade-list-item]')
        .first()
        .click()

      await expect
        .poll(
          async () =>
            page
              .locator(
                "[data-yaade-commit-changes-dialog] [data-yaade-git-diff] [data-yaade-pierre-diff] diffs-container",
              )
              .count(),
          { timeout: 15_000 },
        )
        .toBeGreaterThan(0)
      const historyDiff = page.locator(
        "[data-yaade-commit-changes-dialog] [data-yaade-git-diff] [data-yaade-pierre-diff]",
      )
      await expect
        .poll(async () => (await historyDiff.boundingBox())?.height ?? 0, {
          timeout: 10_000,
        })
        .toBeGreaterThan(80)
    } finally {
      await app.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  test("virtualized history paginates to the oldest of more than 250 commits", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-history-pages-"))
    const project = path.join(home, "repo")
    fs.mkdirSync(project, { recursive: true })
    execSync(
      "git init -q && git config user.email t@t && git config user.name t && git config gc.auto 0 && git config maintenance.auto false && for i in $(seq 0 259); do echo $i > counter.txt; git add counter.txt; git -c gc.auto=0 commit -q -m history-$i; done",
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
      await page.locator('[data-yaade-project-tab="history"]').click()
      const panel = page.locator('[data-yaade-list-panel="git-history"]')
      await panel.waitFor({ state: "visible", timeout: 15_000 })
      await expect
        .poll(
          async () => {
            await panel.evaluate(element => {
              element.scrollTop = element.scrollHeight
            })
            await page.waitForTimeout(150)
            return (await panel.textContent()) ?? ""
          },
          { timeout: 20_000 },
        )
        .toContain("history-0")

      await expectListRows(page, {
        panel: "git-history",
        minItems: 1,
        needle: "history-0",
        noResultsText: "No commit history",
      })
      const rendered = await panel.locator("[data-yaade-list-item]").count()
      expect(rendered).toBeLessThan(60)
    } finally {
      await app.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
