import { expect, test } from "@playwright/test"
import { expectSelectorVisible } from "../shell/assert.js"
import { execCommand, launchJet, waitForMux } from "./_launch.js"

/**
 * Mux chrome smoke tests for the project Terminals surface (sidebar + single
 * focused pane). Tiled MuxPaneChrome controls/zoom are no longer shown there.
 */
test.describe("mux chrome", () => {
  test("terminals surface shows instance sidebar and focused pane chrome", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await expectSelectorVisible(page, '[data-yaade-instance-sidebar="terminals"]')
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
      await execCommand(page, "terminal.new")
      await expect
        .poll(async () =>
          page
            .locator(
              '[data-yaade-list-panel="project-terminals"] [data-yaade-list-item]',
            )
            .count(),
        )
        .toBeGreaterThanOrEqual(2)
      await expect
        .poll(async () =>
          page
            .locator(
              '[data-yaade-project-surface="terminals"] [data-yaade-mux-pane-kind="terminal"]',
            )
            .count(),
        )
        .toBe(1)
    } finally {
      await app.close()
    }
  })
})
