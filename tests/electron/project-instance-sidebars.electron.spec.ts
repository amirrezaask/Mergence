import { expect, test } from "@playwright/test"
import { expectListRows } from "../helpers/list.js"
import {
  expectLocatorCount,
  expectLocatorVisible,
  expectSelectorVisible,
} from "../shell/assert.js"
import {
  execCommand,
  launchJet,
  waitForMux,
  waitForProjectPage,
} from "./_launch.js"

const TERMINALS_ITEMS =
  '[data-yaade-list-panel="project-terminals"] [data-yaade-list-item]'

test.describe("project instance sidebars", () => {
  test("Terminals sidebar lists shells, creates, switches, and closes", async () => {
    const { app, page } = await launchJet({ withTerminal: false })
    try {
      await waitForMux(page)
      const surface = page.locator('[data-yaade-project-surface="terminals"]')
      await expectSelectorVisible(page, '[data-yaade-instance-sidebar="terminals"]')

      await surface.locator("[data-yaade-instance-sidebar-new]").click()
      await expectListRows(page, {
        panel: "project-terminals",
        minItems: 1,
        needle: "sample-workspace",
        noResultsText: "No terminals in this worktree.",
      })
      await expect
        .poll(async () =>
          surface.locator('[data-yaade-mux-pane-kind="terminal"]').count(),
        )
        .toBe(1)

      await execCommand(page, "terminal.new")
      await expectListRows(page, {
        panel: "project-terminals",
        minItems: 2,
        needle: "sample-workspace",
        noResultsText: "No terminals in this worktree.",
      })

      const items = surface.locator(
        `${TERMINALS_ITEMS} button[data-yaade-instance-sidebar-item]`,
      )
      const firstId = await items.nth(0).getAttribute("data-yaade-instance-sidebar-item")
      const secondId = await items.nth(1).getAttribute("data-yaade-instance-sidebar-item")
      expect(firstId).toBeTruthy()
      expect(secondId).toBeTruthy()
      expect(firstId).not.toEqual(secondId)

      await items.nth(0).click()
      await expect
        .poll(async () =>
          surface
            .locator(`[data-yaade-mux-pane="${firstId}"][data-focused]`)
            .count(),
        )
        .toBe(1)

      await surface.locator(`[data-yaade-instance-sidebar-close="${firstId}"]`).click()
      await page.getByRole("button", { name: "Close Pane" }).click({ timeout: 10_000 })
      await expect
        .poll(
          async () =>
            surface
              .locator(
                `[data-yaade-list-panel="project-terminals"] [data-yaade-instance-sidebar-item="${firstId}"]`,
              )
              .count(),
          { timeout: 15_000 },
        )
        .toBe(0)
      await expectListRows(page, {
        panel: "project-terminals",
        minItems: 1,
        needle: "sample-workspace",
        noResultsText: "No terminals in this worktree.",
      })
    } finally {
      await app.close()
    }
  })

  test("Agents tab hides sidebar until an agent is launched", async () => {
    const { app, page } = await launchJet({ projectPage: true })
    try {
      await waitForProjectPage(page)
      await expect
        .poll(async () => page.locator('[data-yaade-project-tab="native-agents"]').count())
        .toBe(0)

      await page.locator('[data-yaade-project-tab="agents"]').click()
      await expectLocatorCount(
        page.locator('[data-yaade-instance-sidebar="agents"]'),
        0,
      )
      await expectSelectorVisible(page, "[data-yaade-agents-empty]")
      await page.locator("[data-yaade-agents-empty-launch]").click()
      await expectLocatorVisible(
        page.getByRole("dialog").filter({ hasText: "Launch an agent" }),
      )
      await expectLocatorCount(
        page.locator('input[placeholder="Search providers…"]'),
        0,
      )
      await expectSelectorVisible(page, "[data-yaade-use-worktree]")
      await expectLocatorCount(page.locator("[data-yaade-worktree-name]"), 0)
      await page.locator("[data-yaade-use-worktree]").click()
      await expectSelectorVisible(page, "[data-yaade-worktree-name]")
      await expectSelectorVisible(page, '[data-yaade-agent-cli-option="codex"]')
    } finally {
      await app.close()
    }
  })
})
