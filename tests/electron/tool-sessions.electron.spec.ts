import { expect } from "@playwright/test"
import { test } from "../fixtures/e2e.js"
import { pressShellPrefix } from "./_launch.js"

test("Session shell exposes only Terminal and Git tools", async ({ launchApp }) => {
  const { page } = await launchApp()
  await expect(page.locator('[data-yaade-shell="tool-session"]')).toBeVisible()

  await pressShellPrefix(page)
  const hud = page.locator("[data-yaade-which-key]")
  await expect(hud).toContainText("New Terminal")
  await expect(hud).toContainText("New Git")
  await expect(hud).not.toContainText("Search")
  await expect(hud).not.toContainText("Neovim")
})
