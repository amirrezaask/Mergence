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
  expect(computed.backdropFilter).toMatch(/blur\(([3-9]\d)px\)/)
  expect(computed.backdropFilter).toMatch(/saturate\(/)
  expect(computed.backdropFilter).toMatch(/brightness\(/)
  expect(computed.borderRadius).not.toBe("0px")

  const fill = await page
    .locator('[data-yaade-glass-gallery-material="floating"]')
    .evaluate(element => {
      const style = getComputedStyle(element)
      const color = style.backgroundColor
      const match = color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/)
      const oklchAlpha = color.match(/\/\s*([\d.]+)\s*\)/)?.[1]
      return {
        color,
        alpha:
          match?.[4] == null
            ? oklchAlpha == null
              ? 1
              : Number(oklchAlpha)
            : Number(match[4]),
        boxShadow: style.boxShadow,
        prefersReducedTransparency: window.matchMedia(
          "(prefers-reduced-transparency: reduce)",
        ).matches,
      }
    })
  expect(fill.alpha).toBeGreaterThan(0)
  if (fill.prefersReducedTransparency) expect(fill.alpha).toBe(1)
  else expect(fill.alpha).toBeLessThan(0.4)
  expect(fill.boxShadow).toMatch(/inset/)

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

test("settings keep fixed material and typography while allowing font selection", async ({ launchApp }) => {
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
  await expect(page.locator('[data-yaade-reduced-transparency-toggle=""]')).toHaveCount(0)
  await expect(page.locator("#yaade-ui-font-size")).toHaveCount(0)
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-yaade-reduced-transparency",
  )

  const fontInput = page.locator("#yaade-mono-font")
  const initialFont = await fontInput.inputValue()
  await fontInput.click()
  const fontOptions = page.locator("[data-yaade-mono-font-option]")
  await expect(fontOptions.first()).toBeVisible()
  const availableFonts = await fontOptions.evaluateAll(elements =>
    elements
      .map(element => element.getAttribute("data-yaade-mono-font-option"))
      .filter((font): font is string => Boolean(font)),
  )
  const nextFont = availableFonts.find(font => font !== initialFont)
  if (!nextFont) throw new Error("The font picker did not expose another font.")
  await fontOptions.filter({ hasText: nextFont }).click()
  await expect(fontInput).toHaveValue(nextFont)
})

test("top Window tabs use disconnected pills with a raised active surface", async ({ launchApp }) => {
  const { page } = await launchApp()
  const topBar = page.locator('[data-yaade-top-tabbar]')
  await expect(topBar).toBeVisible()
  const tabBarHeight = await topBar.evaluate(element => element.getBoundingClientRect().height)
  expect(tabBarHeight).toBeGreaterThan(40)
  const pillHeight = await page
    .locator('[data-yaade-window-tabs] [data-yaade-session-tab]')
    .first()
    .evaluate(element => element.getBoundingClientRect().height)
  expect(pillHeight).toBeGreaterThan(24)
  expect(pillHeight).toBeLessThan(tabBarHeight - 8)
  await expect(topBar.getByRole("button", { name: "Switch tool" })).toHaveCount(0)
  await expect(topBar.getByRole("button", { name: "Settings" })).toBeVisible()

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
  const inactiveBackground = await inactiveTab.evaluate(
    element => getComputedStyle(element).backgroundColor,
  )
  expect(["transparent", "rgba(0, 0, 0, 0)"]).toContain(inactiveBackground)
  const activeTabFill = await activeTab.evaluate(
    element => getComputedStyle(element).backgroundColor,
  )
  expect(["transparent", "rgba(0, 0, 0, 0)"]).toContain(activeTabFill)

  const activePill = page.locator('[data-yaade-window-tab-pill=""]')
  await expect(activePill).toHaveCount(1)
  const pill = await activePill.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: Number.parseFloat(style.borderRadius),
      boxShadow: style.boxShadow,
    }
  })
  expect(["transparent", "rgba(0, 0, 0, 0)"]).not.toContain(pill.backgroundColor)
  expect(pill.borderRadius).toBeGreaterThan(8)
  expect(pill.boxShadow).not.toBe("none")

  const inactiveId = await inactiveTab.getAttribute("data-yaade-session-tab")
  expect(inactiveId).toBeTruthy()
  await inactiveTab.click()
  const switched = page.locator(
    `[data-yaade-window-tabs] [data-yaade-session-tab="${inactiveId}"]`,
  )
  await expect(switched).toHaveAttribute("data-active", "true")
  await expect(switched.locator('[data-yaade-window-tab-pill=""]')).toBeVisible()

  await expect(page.locator('[data-yaade-top-tabbar] > span')).toHaveCount(0)
})

test("window tabs close with the x button and have no overflow menu", async ({ launchApp }) => {
  const { page } = await launchApp()
  const tabBar = page.locator('[data-yaade-window-tabs]')
  const tabs = tabBar.locator('[data-yaade-session-tab]')
  await expect(tabs).toHaveCount(1)
  await expect(tabs.first()).toContainText("Window 1")
  await expect(tabs.first().getByRole("button", { name: "Close Window 1" })).toBeVisible()
  await expect(tabBar.getByRole("button", { name: /Window actions/ })).toHaveCount(0)
  await expect(page.locator('[data-yaade-window-tab-menu]')).toHaveCount(0)
  await expect(tabBar.locator('[data-slot="dropdown-menu-trigger"]')).toHaveCount(0)

  await page.locator('[data-yaade-new-session-tab=""]').click()
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(1)).toContainText("New tab")
  await expect(tabs.nth(1).getByRole("button", { name: "Close New tab" })).toBeVisible()
  await expect(tabs.nth(1)).toBeVisible()

  await tabs.nth(1).getByRole("button", { name: "Close New tab" }).click()
  await expect(tabs).toHaveCount(1)
  await expect(tabs.first()).toContainText("Window 1")
  await expect(tabs.first()).toBeVisible()
})
