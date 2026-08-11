import { expect, test } from "@playwright/test"
import { expectSelectorVisible } from "../shell/assert.js"
import { launchJet, openMuxTerminal, waitForMux } from "./_launch.js"

/**
 * Mux chrome smoke tests for the project Running surface (sidebar + single
 * focused pane). Tiled MuxPaneChrome controls/zoom are no longer shown there.
 */
test.describe("mux chrome", () => {
  test("Running surface shows project process sidebar and focused pane chrome", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await expectSelectorVisible(page, '[data-yaade-project-process-group="running"]')
      expect(
        await page.locator('[data-yaade-mux] [data-yaade-instance-sidebar="running"]').count(),
      ).toBe(0)
      await expectSelectorVisible(page, "[data-yaade-mux-pane-chrome]")
      await expect
        .poll(async () =>
          page.locator('[data-yaade-mux-pane-kind="terminal"][data-focused]').count(),
        )
        .toBe(1)
    } finally {
      await app.close()
    }
  })

  test("the shell leaves the workspace surface unobstructed at the bottom", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      expect(await page.locator("[data-yaade-mux-status-strip]").count()).toBe(0)
    } finally {
      await app.close()
    }
  })

  test("creating another terminal keeps a single focused pane", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await page.locator('[data-yaade-project-process-new="running"]').click()
      await page.locator('[data-yaade-agent-provider="terminal"]').click()
      await page.locator("[data-yaade-worktree-main]").click()
      await expect
        .poll(async () =>
          page
            .locator(
              '[data-yaade-list-panel="project-running"] [data-yaade-list-item]',
            )
            .count(),
        )
        .toBeGreaterThanOrEqual(2)
      await expect
        .poll(async () =>
          page
            .locator(
              '[data-yaade-project-surface="running"] [data-yaade-mux-pane-kind="terminal"]',
            )
            .count(),
        )
        .toBe(1)
      await openMuxTerminal(page)
    } finally {
      await app.close()
    }
  })
})
