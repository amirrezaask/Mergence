import { expect, test } from "@playwright/test"
import { execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expectSelectorVisible } from "../shell/assert.js"
import { execCommand, launchJet, waitForMux } from "./_launch.js"

function hasGit(): boolean {
  try {
    execSync("which git", { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/** Open Git → History (Uncommitted), then the working-tree changes dialog. */
async function openWorkingTreeDialog(
  page: Parameters<typeof waitForMux>[0],
): Promise<void> {
  await execCommand(page, "mux.openGit")
  await expectSelectorVisible(page, '[data-yaade-project-panel="history"]', {
    timeout: 15_000,
  })
  await expectSelectorVisible(page, "[data-yaade-git-working-tree]", {
    timeout: 15_000,
  })
  await page.locator("[data-yaade-git-working-tree]").click()
  await expectSelectorVisible(page, "[data-yaade-commit-changes-dialog]", {
    timeout: 15_000,
  })
}

test.describe("git hunk staging", () => {
  test.skip(!hasGit(), "git not available")

  test("inline Stage hunk applies via git and moves the change to staged", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-hunk-home-"))
    const project = path.join(home, "repo")
    fs.mkdirSync(project, { recursive: true })
    execSync(
      "git init && git config user.email t@t && git config user.name t && printf 'one\\ntwo\\nthree\\n' > note.txt && git add . && git commit -m init",
      { cwd: project, stdio: "ignore" },
    )
    fs.writeFileSync(path.join(project, "note.txt"), "one\nTWO\nthree\n")

    const { app, page } = await launchJet({
      homeDir: home,
      startPath: "/repo",
      launchWithoutWorkspace: true,
    })
    try {
      await waitForMux(page)
      await openWorkingTreeDialog(page)

      const dialog = page.locator("[data-yaade-commit-changes-dialog]")
      await expect
        .poll(async () =>
          dialog.locator('[data-yaade-list-panel="commit-changes-files"]').count(),
        )
        .toBeGreaterThan(0)

      await expectSelectorVisible(page, "[data-yaade-commit-changes-dialog] [data-yaade-pierre-patch]", {
        timeout: 15_000,
      })
      await expectSelectorVisible(
        page,
        '[data-yaade-commit-changes-dialog] [data-yaade-hunk-action="stage"]',
        { timeout: 15_000 },
      )

      await dialog.locator('[data-yaade-hunk-action="stage"]').first().click()

      await expect
        .poll(async () => {
          const staged = execSync("git diff --cached --name-only", {
            cwd: project,
            encoding: "utf8",
          }).trim()
          return staged
        })
        .toContain("note.txt")

      await expect
        .poll(async () =>
          dialog.locator('[data-yaade-hunk-action="unstage"]').count(),
        )
        .toBeGreaterThan(0)
    } finally {
      await app.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  test("inline Discard hunk restores the worktree via git apply --reverse", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-hunk-discard-"))
    const project = path.join(home, "repo")
    fs.mkdirSync(project, { recursive: true })
    execSync(
      "git init && git config user.email t@t && git config user.name t && printf 'alpha\\nbeta\\n' > keep.txt && git add . && git commit -m init",
      { cwd: project, stdio: "ignore" },
    )
    fs.writeFileSync(path.join(project, "keep.txt"), "alpha\nBETA\n")

    const { app, page } = await launchJet({
      homeDir: home,
      startPath: "/repo",
      launchWithoutWorkspace: true,
    })
    try {
      await waitForMux(page)
      await openWorkingTreeDialog(page)

      const dialog = page.locator("[data-yaade-commit-changes-dialog]")
      await expectSelectorVisible(
        page,
        '[data-yaade-commit-changes-dialog] [data-yaade-hunk-action="discard"]',
        { timeout: 15_000 },
      )
      await dialog.locator('[data-yaade-hunk-action="discard"]').first().click()

      await expect
        .poll(async () => fs.readFileSync(path.join(project, "keep.txt"), "utf8"))
        .toBe("alpha\nbeta\n")
    } finally {
      await app.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
