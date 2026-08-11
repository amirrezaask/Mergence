import { expect, test } from "@playwright/test"
import { launchJet, waitForHome, waitForMux } from "./_launch.js"

test.describe("release build branding", () => {
  test("serves release favicon and omits the DEV badge", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForHome(page)
      await waitForMux(page)

      const branding = await page.evaluate(() => {
        const icon = document.querySelector('link[rel="icon"]')?.getAttribute("href")
        const apple = document
          .querySelector('link[rel="apple-touch-icon"]')
          ?.getAttribute("href")
        return {
          title: document.title,
          icon: icon ?? null,
          apple: apple ?? null,
          badgeCount: document.querySelectorAll("[data-yaade-build-badge]").length,
        }
      })

      expect(branding.icon).toBe("/favicon.png")
      expect(branding.apple).toBe("/apple-touch-icon.png")
      expect(branding.badgeCount).toBe(0)
      expect(branding.title.startsWith("DEV · ")).toBe(false)

      const favicon = await page.evaluate(async () => {
        const res = await fetch("/favicon.png")
        return { ok: res.ok, status: res.status }
      })
      expect(favicon.ok).toBe(true)
      expect(favicon.status).toBe(200)
    } finally {
      await app.close()
    }
  })
})
