import { expect, test } from "@playwright/test"
import { launchWeb } from "../shell/launch-web.js"

test("material gallery exposes named chrome and matte content surfaces", async () => {
  const launched = await launchWeb({
    launchWithoutWorkspace: true,
    startPath: "/__yaade/glass-gallery",
  })
  try {
    const { page } = launched
    await page.waitForSelector('[data-yaade-glass-gallery=""]')

    const materials = page.locator("[data-yaade-glass-gallery-material]")
    expect(await materials.count()).toBe(4)
    expect(await page.locator('[data-yaade-glass-gallery-material="shell"]').count()).toBe(1)
    expect(await page.locator('[data-yaade-glass-gallery-material="chrome"]').count()).toBe(1)
    expect(await page.locator('[data-yaade-glass-gallery-material="content"]').count()).toBe(1)
    expect(await page.locator('[data-yaade-glass-gallery-material="floating"]').count()).toBe(1)

    const computed = await page.locator('[data-yaade-glass-gallery-material="floating"]').evaluate(element => {
      const style = getComputedStyle(element)
      return {
        backdropFilter: style.backdropFilter,
        borderRadius: style.borderRadius,
      }
    })
    expect(computed.backdropFilter).toMatch(/3[24]px/)
    expect(computed.borderRadius).not.toBe("0px")

    const contentComputed = await page.locator('[data-yaade-glass-gallery-material="content"]').evaluate(element => {
      const style = getComputedStyle(element)
      return {
        backdropFilter: style.backdropFilter,
        background: style.backgroundColor,
      }
    })
    expect(contentComputed.backdropFilter).toContain("0px")
    expect(contentComputed.background).not.toBe("rgba(0, 0, 0, 0)")

    const classicComputed = await page.evaluate(() => {
      document.documentElement.dataset.yaadeInterfaceMaterial = "classic"
      const element = document.querySelector<HTMLElement>(
        '[data-yaade-glass-gallery-material="floating"]',
      )
      if (!element) throw new Error("floating gallery surface missing")
      const style = getComputedStyle(element)
      return { backdropFilter: style.backdropFilter, background: style.backgroundColor }
    })
    expect(classicComputed.backdropFilter).toContain("0px")
    expect(classicComputed.background).not.toBe("rgba(0, 0, 0, 0)")

    await page.locator('[data-yaade-glass-gallery-busy-toggle=""]').click()
    expect(
      await page.locator('[data-yaade-glass-gallery=""]').getAttribute("class"),
    ).toContain("yaade-glass-gallery-busy")
  } finally {
    await launched.app.close()
  }
})

test("settings keep the default material treatment without a material switch", async () => {
  const launched = await launchWeb()
  try {
    const { page } = launched
    await page.waitForSelector('[data-yaade-shell="tool-session"]')
    await page.keyboard.press(
      `${process.platform === "darwin" ? "Meta" : "Control"}+Comma`,
    )
    await page.waitForSelector("[data-yaade-settings-overlay]")

    expect(
      await page.locator('[data-yaade-interface-material-option]').count(),
    ).toBe(0)
    expect(
      await page.evaluate(() => document.documentElement.dataset.yaadeInterfaceMaterial),
    ).toBe("liquid-glass")
    await page.locator('[data-yaade-reduced-transparency-toggle=""]').click()
    expect(
      await page.evaluate(() => document.documentElement.dataset.yaadeReducedTransparency),
    ).toBe("true")
  } finally {
    await launched.app.close()
  }
})

test("top Window tabs stay on the shared tab-bar surface", async () => {
  const launched = await launchWeb()
  try {
    const { page } = launched
    await page.waitForSelector('[data-yaade-top-tabbar]')
    const activeTab = page.locator(
      '[data-yaade-window-tabs] [data-yaade-session-tab][data-active="true"]',
    )
    await activeTab.waitFor({ state: "visible" })
    const computed = await activeTab.evaluate(element => {
      const style = getComputedStyle(element)
      return {
        backgroundColor: style.backgroundColor,
        boxShadow: style.boxShadow,
      }
    })
    expect(computed.backgroundColor).toBe("rgba(0, 0, 0, 0)")
    expect(computed.boxShadow).toBe("none")

    expect(await page.locator('[data-yaade-top-tabbar] > span').count()).toBe(0)
  } finally {
    await launched.app.close()
  }
})
