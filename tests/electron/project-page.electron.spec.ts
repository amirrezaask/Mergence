import { expect, test } from "@playwright/test"
import { execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expectListRows } from "../helpers/list.js"
import { createMockLspHarness } from "../../apps/host-server/mocks/mock-lsp-harness.js"
import { launchJet, waitForProjectPage } from "./_launch.js"

test.describe("project page", () => {
  test("project switcher searches known projects and paths", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-project-switcher-"))
    const project = path.join(home, "repo")
    const other = path.join(home, "other")
    fs.mkdirSync(project, { recursive: true })
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(path.join(project, "README.md"), "repo\n")
    fs.writeFileSync(path.join(other, "README.md"), "other\n")

    const { app, page } = await launchJet({
      projectPage: true,
      launchWithoutWorkspace: true,
      homeDir: home,
      startPath: "/repo",
    })
    try {
      await waitForProjectPage(page)
      await page.evaluate(async rootPath => {
        const response = await fetch("/api/v1/projects/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rootPath }),
        })
        if (!response.ok) throw new Error(await response.text())
        window.dispatchEvent(new Event("yaade:agent-signal"))
      }, other)

      await page.locator('[data-yaade-project-switcher=""]').click()
      await page
        .locator('[data-yaade-project-switcher-menu=""]')
        .waitFor({ state: "visible" })
      expect(await page.locator('[data-slot="dialog-overlay"]').count()).toBe(0)
      await expectListRows(page, {
        panel: "project-switcher",
        minItems: 2,
        needle: "repo",
        noResultsText: "No matching projects.",
      })

      const search = page.locator('[data-yaade-project-switcher-search=""]')
      await search.fill("other")
      await expectListRows(page, {
        panel: "project-switcher",
        minItems: 1,
        needle: "other",
        noResultsText: "No matching projects.",
      })
      await search.press("Enter")
      await expect.poll(() => page.evaluate(() => location.pathname)).toBe("/other")

      await page.locator('[data-yaade-project-switcher=""]').click()
      await page
        .locator('[data-yaade-project-switcher-search=""]')
        .fill("~/repo")
      await expectListRows(page, {
        panel: "project-switcher",
        minItems: 1,
        needle: path.join(home, "repo"),
        noResultsText: "No matching projects.",
      })
      await page.locator('[data-yaade-project-switcher-search=""]').press("Escape")
      await expect
        .poll(() => page.locator('[data-yaade-project-switcher-menu=""]').count())
        .toBe(0)
    } finally {
      await app.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  test("a bare project URL registers the directory and lands on Git/Main", async () => {
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
      await expect
        .poll(() => page.locator('[data-yaade-project-git-history-group=""]').count())
        .toBe(1)
      await expectListRows(page, {
        panel: "project-git-history",
        minItems: 1,
        needle: "Main",
        noResultsText: "No worktrees yet",
      })
      expect(await page.locator('[data-yaade-project-sidebar=""]').count()).toBe(1)
      expect(await page.locator('[data-yaade-project-switcher=""]').count()).toBe(1)
      expect(
        await page.locator('[data-yaade-project-process-group="running"]').isVisible(),
      ).toBe(true)
      expect(
        await page.locator('[data-yaade-project-process-group="running"]').isVisible(),
      ).toBe(true)
      expect(await page.locator('[data-yaade-project-tab="editors"]').count()).toBe(0)
      expect(await page.locator('[data-yaade-project-tab="changes"]').count()).toBe(0)
      expect(
        await page.locator('[data-yaade-git-toolbar] [data-yaade-worktree-switcher]').count(),
      ).toBe(0)
      expect(await page.locator('[data-yaade-project-dock]').count()).toBe(0)
      expect(await page.getByRole("button", { name: "Open HQ" }).count()).toBe(1)
      expect(await page.getByRole("button", { name: "Settings" }).count()).toBe(0)
      expect(
        await page.locator('[data-yaade-shell="project"] [data-yaade-app-header]').count(),
      ).toBe(0)
      expect(await page.evaluate(() => location.search)).toBe("")

      const projects = await page.evaluate(async () => {
        const response = await fetch("/api/v1/hq")
        return (await response.json()).projects as Array<{ rootPath: string }>
      })
      expect(
        projects.some(item => fs.realpathSync(item.rootPath) === fs.realpathSync(project)),
      ).toBe(true)

    } finally {
      await app.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  test("Editors chooses a worktree, keeps dirty buffers, and retargets LSP cwd", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-editor-worktree-"))
    const project = path.join(home, "repo")
    const worktree = path.join(home, "feature")
    const mock = createMockLspHarness()
    fs.mkdirSync(path.join(project, "src"), { recursive: true })
    fs.writeFileSync(path.join(project, "src", "index.ts"), "export const value = 1\n")
    execSync(
      "git init && git config user.email t@t && git config user.name tester && git add . && git commit -m seed && git worktree add -b feature ../feature HEAD",
      { cwd: project, stdio: "ignore" },
    )

    const { app, page } = await launchJet({
      projectPage: true,
      launchWithoutWorkspace: true,
      homeDir: home,
      startPath: "/repo",
      env: mock.env,
    })
    try {
      await waitForProjectPage(page)
      await page.locator('[data-yaade-project-tab="editors"]').click()
      const panel = page.locator('[data-yaade-project-panel="editors"]')
      await panel.locator('[data-yaade-worktree-switcher=""]').waitFor({
        state: "visible",
      })

      await page.evaluate(() => window.__yaadeAgent!.openFile("src/index.ts"))
      await page.evaluate(() => window.__yaadeAgent!.waitForEditor())
      await mock.waitForStartCount(1, 15_000)
      const firstStart = mock.events("started").at(-1)
      expect((firstStart?.details as { cwd?: string } | undefined)?.cwd).toBe(
        fs.realpathSync(project),
      )

      await page.locator("[data-yaade-monaco-editor] textarea.inputarea").fill(" ")
      await expect
        .poll(() => page.evaluate(() => window.__yaadeAgent!.getState().activeEditorDirty))
        .toBe(true)

      await panel.locator('[data-yaade-worktree-switcher=""]').click()
      await page.locator('[data-yaade-worktree-item="feature"]').click()
      await expect
        .poll(() => panel.locator('[data-yaade-worktree-switcher=""]').textContent())
        .toContain("feature")
      await expect
        .poll(() => panel.locator('[data-yaade-editor-workspace-path]').getAttribute("data-yaade-editor-workspace-path"))
        .toBe(fs.realpathSync(worktree))
      await expect
        .poll(() => page.evaluate(() => window.__yaadeAgent!.getState().activeEditorDirty))
        .toBe(true)
      await expect
        .poll(() => page.evaluate(() => window.__yaadeAgent!.getState().sessionCwd))
        .toBe(fs.realpathSync(project))

      await mock.waitForStartCount(2, 15_000)
      const starts = mock.events("started")
      expect((starts.at(-1)?.details as { cwd?: string } | undefined)?.cwd).toBe(
        fs.realpathSync(worktree),
      )
    } finally {
      await app.close()
      mock.dispose()
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
      await page.locator('[data-yaade-project-worktree-item="main"]').click()
      expect(
        await page.locator('[data-yaade-git-toolbar] [data-yaade-git-commit-trigger]').count(),
      ).toBe(1)
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
        .toMatch(/Uncommitted/)

      await page
        .locator('[data-yaade-list-panel="git-history"] [data-yaade-git-working-tree]')
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
      const changesDialog = page.locator("[data-yaade-commit-changes-dialog]")
      await changesDialog.getByRole("button", { name: /^Stage all/ }).click()
      await expect
        .poll(() => execSync("git diff --cached --name-only", { cwd: project }).toString().trim())
        .toContain("note.txt")
      await changesDialog.getByRole("button", { name: /^Unstage all/ }).click()
      await expect
        .poll(() => execSync("git diff --cached --name-only", { cwd: project }).toString().trim())
        .toBe("")
      await changesDialog.getByRole("button", { name: /^Stage all/ }).click()
      await expect
        .poll(() => execSync("git diff --cached --name-only", { cwd: project }).toString().trim())
        .toContain("note.txt")
      await changesDialog.getByRole("button", { name: /^Commit/ }).click()
      await page.locator("[data-yaade-git-commit-dialog]").waitFor({ state: "visible" })
      await page.getByRole("button", { name: "Cancel" }).click()
      await page.keyboard.press("Escape")
      await page.locator("[data-yaade-commit-changes-dialog]").waitFor({
        state: "hidden",
      })
      expect(await page.locator('[data-yaade-git-toolbar] [data-yaade-git-commit-trigger]').count()).toBe(1)

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

  test("Git refreshes uncommitted changes while visible", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-git-live-refresh-"))
    const project = path.join(home, "repo")
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, "note.txt"), "one\n")
    execSync(
      "git init && git config user.email t@t && git config user.name t && git add . && git commit -m seed",
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
      const workingTree = page.locator(
        '[data-yaade-list-panel="git-history"] [data-yaade-git-working-tree]',
      )
      await workingTree.waitFor({ state: "visible", timeout: 15_000 })
      await expect
        .poll(async () => (await workingTree.textContent()) ?? "")
        .toContain("Working tree clean")

      fs.appendFileSync(path.join(project, "note.txt"), "two\n")
      await expect
        .poll(async () => (await workingTree.textContent()) ?? "", { timeout: 10_000 })
        .toContain("1 file changed")
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
      await page.locator('[data-yaade-project-worktree-item="main"]').click()
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
