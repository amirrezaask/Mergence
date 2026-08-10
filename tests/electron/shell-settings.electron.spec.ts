import { expect, test } from "@playwright/test"
import {
  expectLocatorCount,
  expectLocatorVisible,
} from "../shell/assert.js"

import {
  execCommand,
  ensureSidebarLayout,
  launchJet,
  openSettings,
  openThemePicker,
} from "./_launch.js"

test.describe("shell settings", () => {
  test("Default Dark and Light keep readable semantic colors and visible focus", async ({}, testInfo) => {
    const { app, page } = await launchJet()
    try {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.evaluate(async () => window.__yaadeAgent!.waitForReady())
      await ensureSidebarLayout(page)

      for (const theme of [
        { id: "default-dark", scheme: "dark" },
        { id: "default-light", scheme: "light" },
      ] as const) {
        await execCommand(page, `ui.setTheme.${theme.id}`)
        await expect
          .poll(() =>
            page.evaluate(() => ({
              scheme: getComputedStyle(document.documentElement).colorScheme,
              themeId: localStorage.getItem("jet-theme-id"),
            })),
          )
          .toEqual({ scheme: theme.scheme, themeId: theme.id })

        const contrast = await page.evaluate(() => {
          const canvas = document.createElement("canvas")
          canvas.width = 1
          canvas.height = 1
          const context = canvas.getContext("2d", { willReadFrequently: true })!
          const probe = document.createElement("span")
          probe.style.position = "fixed"
          probe.style.left = "-100px"
          document.body.append(probe)

          function rgb(variable: string): readonly [number, number, number] {
            probe.style.color = `var(${variable})`
            const color = getComputedStyle(probe).color
            context.clearRect(0, 0, 1, 1)
            context.fillStyle = color
            context.fillRect(0, 0, 1, 1)
            const pixels = context.getImageData(0, 0, 1, 1).data
            return [pixels[0]!, pixels[1]!, pixels[2]!]
          }

          function luminance(value: readonly [number, number, number]): number {
            const [red, green, blue] = value.map(channel => {
              const normalized = channel / 255
              return normalized <= 0.04045
                ? normalized / 12.92
                : ((normalized + 0.055) / 1.055) ** 2.4
            })
            return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
          }

          function ratio(foreground: string, background: string): number {
            const foregroundLuminance = luminance(rgb(foreground))
            const backgroundLuminance = luminance(rgb(background))
            return (
              (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
              (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
            )
          }

          const rootStyle = getComputedStyle(document.documentElement)
          const report = {
            foreground: ratio("--foreground", "--background"),
            muted: ratio("--muted-foreground", "--background"),
            primary: ratio("--primary-foreground", "--primary"),
            destructive: ratio(
              "--destructive-foreground",
              "--destructive",
            ),
            input: ratio("--input", "--background"),
            focus: ratio("--ring", "--background"),
            sidebar: ratio("--sidebar-foreground", "--sidebar"),
            primaryMatchesSidebar:
              rootStyle.getPropertyValue("--primary").trim() ===
              rootStyle.getPropertyValue("--sidebar-primary").trim(),
          }
          probe.remove()
          return report
        })

        expect(contrast.foreground).toBeGreaterThanOrEqual(7)
        expect(contrast.muted).toBeGreaterThanOrEqual(4.5)
        expect(contrast.primary).toBeGreaterThanOrEqual(4.5)
        expect(contrast.destructive).toBeGreaterThanOrEqual(4.5)
        expect(contrast.input).toBeGreaterThanOrEqual(3)
        expect(contrast.focus).toBeGreaterThanOrEqual(3)
        expect(contrast.sidebar).toBeGreaterThanOrEqual(7)
        expect(contrast.primaryMatchesSidebar).toBe(true)

        // Mux has no sidebar search; probe focus ring on a status-strip control.
        // Use focusVisible so :focus-visible rings apply (programmatic focus alone does not).
        await page.evaluate(() => {
          const btn = document.querySelector(
            "[data-yaade-mux-status-strip] button",
          ) as HTMLElement | null
          btn?.focus({ focusVisible: true })
        })
        const chromeBtn = page.locator("[data-yaade-mux-status-strip] button").first()
        await expect
          .poll(() =>
            chromeBtn.evaluate(element => getComputedStyle(element).boxShadow),
          )
          .not.toBe("none")
        await testInfo.attach(`${theme.id}.png`, {
          body: Buffer.from(await page.screenshot(), "base64"),
          contentType: "image/png",
        })
      }
    } finally {
      await app.close()
    }
  })

  test("settings overlay lists themes and reset restores appearance", async ({}, testInfo) => {
    const { app, page } = await launchJet()
    try {
      await page.evaluate(() => localStorage.clear())
      await page.evaluate(async () => window.__yaadeAgent!.waitForReady())
      await openSettings(page)
      await page
        .locator("[data-yaade-settings-category='appearance']")
        .click()
      await expectLocatorCount(page.locator("[data-yaade-theme-option]"), 2)
      await expectLocatorCount(page.locator("[data-yaade-color-mode-option]"), 3)
      await expectLocatorCount(page.locator("[data-yaade-preferred-editor]"), 2)

      await page.locator("[data-yaade-preferred-editor='neovim']").click()
      await expect
        .poll(() =>
          page.evaluate(() => {
            const value = localStorage.getItem("jet-appearance-settings")
            return value ? JSON.parse(value).preferredEditor : null
          }),
        )
        .toBe("neovim")
      await page.locator("[data-yaade-preferred-editor='monaco']").click()
      await expect
        .poll(() =>
          page.evaluate(() => {
            const value = localStorage.getItem("jet-appearance-settings")
            return value ? JSON.parse(value).preferredEditor : null
          }),
        )
        .toBe("monaco")

      await page.locator("[data-yaade-theme-option='default-dark']").click()
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("jet-theme-id")))
        .toBe("default-dark")

      await page.locator("[data-yaade-theme-option='default-light']").click()
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("jet-theme-id")))
        .toBe("default-light")

      await page.getByRole("radio", { name: "Auto color mode" }).click()
      await expect
        .poll(() =>
          page.evaluate(() => {
            const value = localStorage.getItem("jet-appearance-settings")
            return value ? JSON.parse(value).colorSchemeMode : null
          }),
        )
        .toBe("system")
      await page.emulateMedia({ colorScheme: "light" })
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.documentElement.classList.contains("dark"),
          ),
        )
        .toBe(false)
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("jet-theme-id")))
        .toBe("default-light")
      await expect
        .poll(() =>
          page
            .locator("[data-yaade-theme-option='default-light']")
            .getAttribute("aria-pressed"),
        )
        .toBe("true")
      await testInfo.attach("auto-light.png", {
        body: Buffer.from(await page.screenshot(), "base64"),
        contentType: "image/png",
      })
      await page.emulateMedia({ colorScheme: "dark" })
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.documentElement.classList.contains("dark"),
          ),
        )
        .toBe(true)
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("jet-theme-id")))
        .toBe("default-dark")
      await expect
        .poll(() =>
          page
            .locator("[data-yaade-theme-option='default-dark']")
            .getAttribute("aria-pressed"),
        )
        .toBe("true")
      await testInfo.attach("auto-dark.png", {
        body: Buffer.from(await page.screenshot(), "base64"),
        contentType: "image/png",
      })

      await page.getByRole("button", { name: "Reset appearance" }).click()
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("jet-theme-id")))
        .toBe("default-dark")
      await expect
        .poll(() =>
          page.evaluate(() =>
            getComputedStyle(document.documentElement)
              .getPropertyValue("--font-mono")
              .trim(),
          ),
        )
        .toContain("Commit Mono")
    } finally {
      await app.close()
    }
  })

  test("monospace font picker is available in appearance settings", async () => {
    const { app, page } = await launchJet()
    try {
      await page.evaluate(async () => window.__yaadeAgent!.waitForReady())
      await openSettings(page)
      await page
        .locator("[data-yaade-settings-category='appearance']")
        .click()
      await expectLocatorVisible(page.locator("[data-yaade-mono-font-picker]"))
    } finally {
      await app.close()
    }
  })

  test("theme picker command opens settings overlay", async () => {
    const { app, page } = await launchJet()
    try {
      await openThemePicker(page)
    } finally {
      await app.close()
    }
  })

  test("settings categories support keyboard navigation and appearance persists", async () => {
    const { app, page } = await launchJet()
    try {
      await page.evaluate(() => localStorage.clear())
      await page.evaluate(async () => window.__yaadeAgent!.waitForReady())
      await openSettings(page)

      const appearance = page.locator(
        "[data-yaade-settings-category='appearance']",
      )
      const notifications = page.locator(
        "[data-yaade-settings-category='notifications']",
      )
      await expect.poll(() => appearance.getAttribute("aria-selected")).toBe("true")
      await appearance.focus()
      await page.keyboard.press("ArrowDown")
      await expect
        .poll(() => notifications.getAttribute("aria-selected"))
        .toBe("true")
      await page
        .locator("[data-yaade-settings-panel='notifications']")
        .waitFor({ state: "visible" })

      await appearance.click()
      await expectLocatorCount(
        page.locator("[data-yaade-session-layout-option]"),
        0,
      )
      await expect
        .poll(() =>
          page.evaluate(() => {
            const raw = localStorage.getItem("jet-appearance-settings")
            if (!raw) return "sidebar"
            return JSON.parse(raw).sessionLayout ?? "sidebar"
          }),
        )
        .toBe("sidebar")

      await page.getByRole("button", { name: "Close settings" }).click()
      await openSettings(page)
      await expect
        .poll(() => appearance.getAttribute("aria-selected"))
        .toBe("true")
    } finally {
      await app.close()
    }
  })

  test("notification sound preference follows desktop delivery and persists", async () => {
    const { app, page } = await launchJet()
    try {
      await page.evaluate(async () => {
        await window.yaade?.notifications?.setPreferences({
          desktopEnabled: false,
          soundEnabled: false,
        })
      })
      await openSettings(page)
      await page
        .locator("[data-yaade-settings-category='notifications']")
        .click()

      const desktop = page.locator(
        "[data-yaade-notification-pref='desktopEnabled']",
      )
      const sound = page.locator(
        "[data-yaade-notification-pref='soundEnabled']",
      )
      const soundDisabled = () =>
        page.evaluate(() => {
          const control = document.querySelector(
            "[data-yaade-notification-pref='soundEnabled']",
          )
          return control instanceof HTMLButtonElement && control.disabled
        })
      await expect.poll(soundDisabled).toBe(true)

      await desktop.click()
      await expect.poll(soundDisabled).toBe(false)
      await sound.click()
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const prefs =
              await window.yaade?.notifications?.getPreferences()
            return prefs?.soundEnabled ?? null
          }),
        )
        .toBe(true)
    } finally {
      await app.close()
    }
  })
})
