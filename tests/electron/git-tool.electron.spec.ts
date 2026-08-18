import { expect } from "@playwright/test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { ShellDriver } from "../shell/driver.js"
import { test } from "../fixtures/e2e.js"
import { expectContainsText } from "../shell/assert.js"
import { expectListRows } from "../helpers/list.js"

async function openToolSessionShell(page: ShellDriver): Promise<void> {
  await page.evaluate(() => {
    history.pushState(null, "", "/")
    window.dispatchEvent(new Event("popstate"))
  })
  await expect(page.locator('[data-yaade-shell="tool-session"]')).toBeVisible()
}

async function ensureGitRepository(page: ShellDriver): Promise<string> {
  const projectPath = await page.evaluate(async () => {
    const project = (await window.yaade?.tools?.listProjects?.())?.[0]
    if (!project) throw new Error("No launch project")
    return project.projectPath
  })
  if (!fs.existsSync(path.join(projectPath, ".git"))) {
    execFileSync("git", ["init", "-q"], { cwd: projectPath })
    execFileSync("git", ["config", "user.email", "e2e@yaade.test"], {
      cwd: projectPath,
    })
    execFileSync("git", ["config", "user.name", "yaade-e2e"], {
      cwd: projectPath,
    })
    fs.writeFileSync(path.join(projectPath, "history-seed.txt"), "seed\n")
    execFileSync("git", ["add", "."], { cwd: projectPath })
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: projectPath })
  }
  return projectPath
}

test("Git History is available as a Session tool", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  })
  await ensureGitRepository(page)
  await openToolSessionShell(page)

  const existingGit = page
    .locator("[data-yaade-tool-tabs] [data-yaade-tool-use]")
    .filter({ hasText: "Git History" })
  if ((await existingGit.count()) > 0) await existingGit.click()
  else await page.locator('[data-yaade-empty-tool="git"]').click()

  await expect(page.locator('[data-yaade-list-panel="git-history"]')).toBeVisible({
    timeout: 30_000,
  })
  await expectListRows(page, {
    panel: "git-history",
    minItems: 2,
    needle: "seed",
    noResultsText: "No commit history",
  })
  await expectContainsText(
    page,
    '[data-yaade-list-panel="git-history"]',
    "Uncommitted",
  )
})

test("mobile Git drills from commits to files to an on-demand diff", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await ensureGitRepository(page)
  await openToolSessionShell(page)

  const session = page.locator("[data-yaade-mobile-session-group]").first()
  await expect(session).toBeVisible()
  // The mobile session renders compact and expanded add-tool controls; use
  // the first control in the session header explicitly.
  await session.locator("[data-yaade-mobile-new-tool]").first().click()
  await page.locator('[data-yaade-mobile-new-tool-kind="git"]').click()

  await expect(page.locator('[data-yaade-git-mobile="true"]')).toBeVisible({
    timeout: 30_000,
  })
  const historyRows = page.locator(
    '[data-yaade-list-panel="git-history"] [data-yaade-list-item]',
  )
  await expect(historyRows.first()).toBeVisible({ timeout: 30_000 })
  await expect(
    page.locator('[data-yaade-list-panel="commit-changes-files"]'),
  ).toHaveCount(0)
  await test.info().attach("mobile-git-commits", {
    body: Buffer.from(await page.screenshot(), "base64"),
    contentType: "image/png",
  })

  const scrollable = await page
    .locator('[data-yaade-list-panel="git-history"]')
    .evaluate(element => {
      if (!(element instanceof HTMLElement)) throw new Error("Git history panel is not HTML")
      const panel = element
      panel.style.flex = "none"
      panel.style.height = "70px"
      panel.scrollTop = 40
      return {
        overflowY: getComputedStyle(panel).overflowY,
        scrollTop: panel.scrollTop,
        scrollHeight: panel.scrollHeight,
        clientHeight: panel.clientHeight,
        touchAction: getComputedStyle(panel).touchAction,
      }
    })
  expect(scrollable.overflowY).toMatch(/auto|scroll/)
  expect(scrollable.scrollHeight).toBeGreaterThan(scrollable.clientHeight)
  expect(scrollable.scrollTop).toBeGreaterThan(0)
  expect(scrollable.touchAction).toContain("pan-y")

  const commit = historyRows.filter({ hasText: "seed" }).first()
  await expect(commit).toBeVisible()
  await commit.click()
  await expect(
    page.locator('[data-yaade-list-panel="commit-changes-files"]'),
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-yaade-git-diff]')).toHaveCount(0)
  await test.info().attach("mobile-git-files", {
    body: Buffer.from(await page.screenshot(), "base64"),
    contentType: "image/png",
  })

  const file = page.locator('[data-yaade-pierre-file-tree] [role="treeitem"]').first()
  await expect(file).toBeVisible({ timeout: 30_000 })
  await file.click()
  await expect(page.locator('[data-yaade-git-diff]')).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByRole("button", { name: "Back to changed files" }),
  ).toBeVisible({ timeout: 30_000 })
  await test.info().attach("mobile-git-diff", {
    body: Buffer.from(await page.screenshot(), "base64"),
    contentType: "image/png",
  })

  const layout = await page.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }))
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.width)
})
