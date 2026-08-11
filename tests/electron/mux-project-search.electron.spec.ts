import { expect, test } from "@playwright/test"
import { expectListRows } from "../helpers/list.js"
import {
  expectLocatorVisible,
} from "../shell/assert.js"
import { execCommand, launchJet, waitForMux } from "./_launch.js"

test.describe("project search", () => {
  test("sidebar search lists hits and opens Monaco on click", async () => {
    const { app, page } = await launchJet({
      workspaceRel: "fixtures/non-git-search",
      withTerminal: false,
    })
    try {
      await waitForMux(page)

      await execCommand(page, "editor.projectSearch")
      await expectLocatorVisible(page.locator("[data-yaade-project-search-panel]"))
      await expectLocatorVisible(page.locator("[data-yaade-project-searches-group]"))

      const input = page.locator("[data-yaade-project-search-input]")
      await input.fill("nonGitSearchFixture")
      await expect
        .poll(
          async () =>
            page.locator('[data-yaade-list-panel="project-search"] [data-yaade-list-item]').count(),
          { timeout: 15_000 },
        )
        .toBeGreaterThanOrEqual(1)
      await expectListRows(page, {
        panel: "project-search",
        minItems: 1,
        needle: "nonGitSearchFixture",
        noResultsText: "No matches.",
      })
      await expectLocatorVisible(
        page.locator('[data-yaade-project-search-hit="src/index.ts:1"]'),
      )
      await expectLocatorVisible(page.locator("[data-yaade-project-search-chunk]"))
      await expect
        .poll(async () =>
          page
            .locator('[data-yaade-project-search-file="src/index.ts"]')
            .getAttribute("data-yaade-project-search-file-loaded"),
        )
        .toBe("1")
      await expect
        .poll(async () =>
          page.locator('[data-yaade-project-search-chunk] [data-yaade-list-item]').count(),
        )
        .toBeGreaterThanOrEqual(1)

      await page
        .locator('[data-yaade-list-panel="project-search"] [data-yaade-list-item]')
        .first()
        .click()

      await waitForMux(page)
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__yaadeAgent!.getEditorDiagnostics().editors.openBuffers.some(uri =>
              uri.endsWith("/src/index.ts"),
            ),
          ),
        )
        .toBe(true)

      await expectLocatorVisible(
        page.locator("[data-yaade-project-search-item]").first(),
      )
    } finally {
      await app.close()
    }
  })
})
