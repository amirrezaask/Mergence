import { expect } from "@playwright/test"
import { test } from "../fixtures/e2e.js"

test("material gallery exposes named chrome and matte content surfaces", async ({ launchApp }) => {
  const { page } = await launchApp({
    launchWithoutWorkspace: true,
    startPath: "/__yaade/glass-gallery",
  })

  await expect(page.locator('[data-yaade-glass-gallery=""]')).toBeVisible()

  const materials = page.locator("[data-yaade-glass-gallery-material]")
  await expect(materials).toHaveCount(4)
  await expect(page.locator('[data-yaade-glass-gallery-material="shell"]')).toHaveCount(1)
  await expect(page.locator('[data-yaade-glass-gallery-material="chrome"]')).toHaveCount(1)
  await expect(page.locator('[data-yaade-glass-gallery-material="content"]')).toHaveCount(1)
  await expect(page.locator('[data-yaade-glass-gallery-material="floating"]')).toHaveCount(1)

  const computed = await page
    .locator('[data-yaade-glass-gallery-material="floating"]')
    .evaluate(element => {
      const style = getComputedStyle(element)
      return {
        backdropFilter: style.backdropFilter,
        borderRadius: style.borderRadius,
      }
    })
  expect(computed.backdropFilter).toMatch(/3[24]px/)
  expect(computed.borderRadius).not.toBe("0px")

  const contentComputed = await page
    .locator('[data-yaade-glass-gallery-material="content"]')
    .evaluate(element => {
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
  await expect(page.locator('[data-yaade-glass-gallery=""]')).toHaveClass(
    /yaade-glass-gallery-busy/,
  )
})

test("settings keep the default material treatment without a material switch", async ({ launchApp }) => {
  const { page } = await launchApp()
  await expect(page.locator('[data-yaade-shell="tool-session"]')).toBeVisible()
  await page.keyboard.press(
    `${process.platform === "darwin" ? "Meta" : "Control"}+Comma`,
  )
  await expect(page.locator("[data-yaade-settings-overlay]")).toBeVisible()

  await expect(page.locator('[data-yaade-interface-material-option]')).toHaveCount(0)
  await expect(page.locator("html")).toHaveAttribute(
    "data-yaade-interface-material",
    "liquid-glass",
  )
  await page.locator('[data-yaade-reduced-transparency-toggle=""]').click()
  await expect(page.locator("html")).toHaveAttribute(
    "data-yaade-reduced-transparency",
    "true",
  )
})

test("top Window tabs use a transparent strip with a rounded active surface", async ({ launchApp }) => {
  const { page } = await launchApp()
  await expect(page.locator('[data-yaade-top-tabbar]')).toBeVisible()

  const newTab = page.locator('[data-yaade-new-session-tab=""]')
  await expect(newTab).toBeVisible()
  await newTab.click()

  const tabs = page.locator('[data-yaade-window-tabs] [data-yaade-session-tab]')
  await expect(tabs).toHaveCount(2)
  const activeTab = page.locator(
    '[data-yaade-window-tabs] [data-yaade-session-tab][data-active="true"]',
  )
  const inactiveTab = page.locator(
    '[data-yaade-window-tabs] [data-yaade-session-tab]:not([data-active="true"])',
  )
  await expect(activeTab).toBeVisible()
  await expect(inactiveTab).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  const active = await activeTab.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
    }
  })
  expect(active.backgroundColor).not.toBe("rgba(0, 0, 0, 0)")
  expect(active.borderRadius).not.toBe("0px")
  expect(active.boxShadow).toBe("none")

  await expect(page.locator('[data-yaade-top-tabbar] > span')).toHaveCount(0)
})
