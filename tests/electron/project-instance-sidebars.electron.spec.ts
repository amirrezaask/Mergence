import { expect, test } from "@playwright/test"
import { expectListRows } from "../helpers/list.js"
import {
  expectLocatorCount,
  expectLocatorContainsText,
  expectLocatorVisible,
  expectSelectorVisible,
} from "../shell/assert.js"
import {
  launchJet,
  waitForProjectPage,
  waitForTerminalText,
} from "./_launch.js"

const TERMINALS_ITEMS =
  '[data-yaade-list-panel="project-terminals"] [data-yaade-list-item]'

test.describe("project instance sidebars", () => {
  test("Terminals reconstruct from the server across navigation and reload", async () => {
    const { app, page } = await launchJet({ projectPage: true })
    try {
      await page.locator('[data-yaade-project-tab="terminals"]').click()
      await expectSelectorVisible(page, '[data-yaade-instance-sidebar="terminals"]')

      await page.locator('[data-yaade-instance-sidebar="terminals"] [data-yaade-instance-sidebar-new]').click()
      await expectListRows(page, {
        panel: "project-terminals",
        minItems: 1,
        needle: "Main",
        noResultsText: "No terminals yet",
      })
      const item = page.locator(
        `${TERMINALS_ITEMS} button[data-yaade-instance-sidebar-item]`,
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
      await page.locator('[data-yaade-project-tab="terminals"]').click()
      await expectSelectorVisible(page, `[data-yaade-instance-sidebar-item="${instanceId}"]`)
      await page.evaluate(() => history.back())
      await expectSelectorVisible(page, '[data-yaade-project-panel="history"]')
      await page.evaluate(() => history.forward())
      await expectSelectorVisible(page, `[data-yaade-instance-sidebar-item="${instanceId}"]`)

      await page.reload()
      await waitForProjectPage(page)
      await expectSelectorVisible(page, '[data-yaade-instance-sidebar="terminals"]')
      await expectSelectorVisible(page, `[data-yaade-instance-sidebar-item="${instanceId}"]`)
      await waitForTerminalText(page, "yaade-server-owned-terminal")
      const after = await page.evaluate(async projectId => {
        const rows = await window.yaade!.terminal!.listInstances(projectId)
        return rows.find(row => row.id === new URL(location.href).searchParams.get("terminal"))
      }, before!.projectId)
      expect(after?.id).toBe(before?.id)
      expect(after?.ptyId).toBe(before?.ptyId)

      await page.locator(`[data-yaade-instance-sidebar-close="${instanceId}"]`).click()
      await expect
        .poll(
          async () =>
            page
              .locator(
                `[data-yaade-list-panel="project-terminals"] [data-yaade-instance-sidebar-item="${instanceId}"]`,
              )
              .count(),
          { timeout: 15_000 },
        )
        .toBe(0)
      await expectLocatorContainsText(
        page.locator('[data-yaade-list-panel="project-terminals"]'),
        "No terminals yet",
      )
    } finally {
      await app.close()
    }
  })

  test("Agents tab keeps an instance sidebar before launch", async () => {
    const { app, page } = await launchJet({ projectPage: true })
    try {
      await waitForProjectPage(page)
      await expect
        .poll(async () => page.locator('[data-yaade-project-tab="native-agents"]').count())
        .toBe(0)

      await page.locator('[data-yaade-project-tab="agents"]').click()
      await expectSelectorVisible(page, '[data-yaade-instance-sidebar="agents"]')
      await page.locator("[data-yaade-instance-sidebar-new]").click()
      await expectLocatorVisible(
        page.getByRole("dialog").filter({ hasText: "Launch an agent" }),
      )
      await expectLocatorCount(
        page.locator('[data-yaade-agent-cli-combobox]'),
        1,
      )
      await expectSelectorVisible(page, "[data-yaade-agent-checkout]")
      await expectLocatorCount(page.locator("[data-yaade-worktree-name]"), 0)
      await page.locator("[data-yaade-agent-checkout]").click()
      await expectSelectorVisible(page, "[data-yaade-worktree-main]")
      await page.locator("[data-yaade-worktree-create]").click()
      await expectSelectorVisible(page, "[data-yaade-worktree-name]")
      await page.locator("[data-yaade-agent-cli-combobox]").click()
      await expectSelectorVisible(page, 'input[placeholder="Search providers…"]')
      await expectSelectorVisible(page, '[data-yaade-agent-cli-option="codex"]')
      await expectLocatorVisible(
        page.locator('[data-yaade-agent-cli-option="codex"] svg'),
      )
      await page.locator('[data-yaade-agent-cli-option="claude"]').click()
      await expectLocatorContainsText(
        page.locator("[data-yaade-agent-cli-combobox]"),
        "Claude",
      )
    } finally {
      await app.close()
    }
  })
})
