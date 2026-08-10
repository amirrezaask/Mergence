import { expect, test } from "@playwright/test"
import { expectListRows } from "../helpers/list.js"
import {
  expectLocatorContainsText,
  expectSelectorVisible,
} from "../shell/assert.js"
import {
  launchJet,
  waitForProjectPage,
  waitForTerminalText,
} from "./_launch.js"

const RUNNING_ITEMS =
  '[data-yaade-list-panel="project-running"] [data-yaade-list-item]'

test.describe("project instance sidebars", () => {
  test("Running reconstructs from the server across navigation and reload", async () => {
    const { app, page } = await launchJet({ projectPage: true })
    try {
      await expectSelectorVisible(page, '[data-yaade-project-process-group="running"]')

      await page.locator('[data-yaade-project-process-new="running"]').click()
      await page.locator('[data-yaade-agent-provider="terminal"]').click()
      await page.locator('[data-yaade-worktree-main]').click()
      await expectListRows(page, {
        panel: "project-running",
        minItems: 1,
        needle: "Main",
        noResultsText: "No processes yet",
      })
      const item = page.locator(
        `${RUNNING_ITEMS} button[data-yaade-instance-sidebar-item]`,
      ).first()
      const instanceId = await item.getAttribute("data-yaade-instance-sidebar-item")
      expect(instanceId).toBeTruthy()
      const before = await page.evaluate(async () => {
        const projectId = document.querySelector<HTMLElement>("[data-yaade-project-id]")
          ?.dataset.yaadeProjectId
        if (!projectId) throw new Error("project id unavailable")
        const rows = await window.yaade!.terminal!.listInstances(
          projectId,
        )
        return rows[0]
      })
      expect(before?.id).toBe(instanceId)
      expect(before?.ptyId).toBeTruthy()

      await page.locator("[data-yaade-terminal-panel] .yaade-terminal-surface").click()
      await page.keyboard.type("printf 'yaade-server-owned-terminal\\n'")
      await page.keyboard.press("Enter")
      await waitForTerminalText(page, "yaade-server-owned-terminal")

      await page.locator('[data-yaade-project-tab="history"]').click()
      await expectSelectorVisible(page, '[data-yaade-project-panel="history"]')
      await page.locator(`[data-yaade-instance-sidebar-item="${instanceId}"]`).click()
      await expectSelectorVisible(page, `[data-yaade-instance-sidebar-item="${instanceId}"]`)

      await page.reload()
      await waitForProjectPage(page)
      await expectSelectorVisible(page, '[data-yaade-project-process-group="running"]')
      await expectSelectorVisible(page, `[data-yaade-instance-sidebar-item="${instanceId}"]`)
      await waitForTerminalText(page, "yaade-server-owned-terminal")
      const after = await page.evaluate(async projectId => {
        const rows = await window.yaade!.terminal!.listInstances(projectId)
        return rows.find(row => row.id === new URL(location.href).searchParams.get("process"))
      }, before!.projectId)
      expect(after?.id).toBe(before?.id)
      expect(after?.ptyId).toBe(before?.ptyId)

      await page.locator(`[data-yaade-instance-sidebar-close="${instanceId}"]`).click()
      await expect
        .poll(
          async () =>
            page
              .locator(
                `[data-yaade-list-panel="project-running"] [data-yaade-instance-sidebar-item="${instanceId}"]`,
              )
              .count(),
          { timeout: 15_000 },
        )
        .toBe(0)
      await expectLocatorContainsText(
        page.locator('[data-yaade-list-panel="project-running"]'),
        "No processes yet",
      )
    } finally {
      await app.close()
    }
  })

  test("Running keeps an agent launcher before launch", async () => {
    const { app, page } = await launchJet({ projectPage: true })
    try {
      await waitForProjectPage(page)
      await expect
        .poll(async () => page.locator('[data-yaade-project-tab="native-agents"]').count())
        .toBe(0)

      await expectSelectorVisible(page, '[data-yaade-project-process-group="running"]')
      await page.locator('[data-yaade-project-process-new="running"]').click()
      await expectSelectorVisible(page, "[data-yaade-process-launch-menu]")
      await expectSelectorVisible(page, '[data-yaade-agent-provider="terminal"]')
      await expectSelectorVisible(page, '[data-yaade-agent-provider="codex"]')
      await page.locator('[data-yaade-agent-provider="codex"]').click()
      await expectSelectorVisible(page, "[data-yaade-worktree-main]")
    } finally {
      await app.close()
    }
  })
})
