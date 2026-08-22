import { expect } from "@playwright/test"
import { test } from "../../fixtures/e2e.js"
import { focusTerminal } from "./_launch.js"

test("Session shell exposes only Terminal", async ({ launchApp }) => {
  const { page } = await launchApp()
  await expect(page.locator('[data-yaade-shell="terminal-multiplexer"]')).toBeVisible()
  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible()
  await expect(page.locator('[data-yaade-session-empty=""]')).toHaveCount(0)
  const topBar = page.locator('[data-yaade-top-tabbar]')
  await expect(topBar).toBeVisible()
  await expect(topBar.getByRole("button", { name: "Switch terminal" })).toHaveCount(0)
  await expect(
    topBar.getByRole("button", { name: /Switch session/ }),
  ).toBeVisible()
  await expect(topBar.locator('[data-yaade-session-settings=""]')).toBeVisible()
  await expect(topBar.getByRole("button", { name: "Settings" })).toBeVisible()

  await expect(page.locator("[data-yaade-which-key]")).toHaveCount(0)
})

test("session switcher creates and archives a session", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  })
  const switcher = page.getByRole("button", { name: /Switch session/ })
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(1, {
    timeout: 30_000,
  })

  await switcher.click()
  const popover = page.locator('[data-yaade-session-switcher-popover=""]')
  await expect(popover).toBeVisible()
  const newSessionButton = popover.locator('[data-yaade-new-session=""]')
  await expect(newSessionButton).toBeVisible()
  await newSessionButton.focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("button", { name: "Switch session, current New session" }),
  ).toBeVisible({ timeout: 30_000 })

  await page.getByRole("button", { name: /Switch session/ }).click()
  await popover.getByRole("button", { name: "Close New session" }).click()
  await expect(page.getByRole("dialog", { name: "Close session?" })).toBeVisible()
  await page.getByRole("button", { name: "Stop terminals and archive" }).click()
  await expect(
    page.getByRole("button", { name: "Switch session, current Session 1" }),
  ).toBeVisible({ timeout: 30_000 })
})

test("terminal output is replayed after a browser reload", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  })
  const marker = "YAADE_DURABLE_REPLAY"

  await focusTerminal(page)
  await page.keyboard.type(`printf '${marker}\\n'`)
  await page.keyboard.press("Enter")

  const terminalText = () =>
    page.evaluate(() => {
      const id = window.__yaadeTest?.getState().activeMuxTerminalId
      return id ? window.__yaadeTest?.getTerminalText?.(id) ?? "" : ""
    })
  await expect.poll(terminalText, { timeout: 15_000 }).toContain(marker)

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator('[data-yaade-shell="terminal-multiplexer"]')).toBeVisible()
  await page.evaluate(() => window.__yaadeTest!.waitForReady())
  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible()
  await expect.poll(terminalText, { timeout: 15_000 }).toContain(marker)
})

test("Windows and pane state survive a browser reload", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  })
  const windowTabs = page.locator("[data-yaade-window-tabs] [data-yaade-session-tab]")

  await expect(windowTabs).toHaveCount(1)
  await page.getByRole("button", { name: "New tab" }).click()
  await expect(windowTabs).toHaveCount(2)
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(1, {
    timeout: 30_000,
  })

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator('[data-yaade-shell="terminal-multiplexer"]')).toBeVisible()
  await page.evaluate(() => window.__yaadeTest!.waitForReady())
  await expect(windowTabs).toHaveCount(2)
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(1, {
    timeout: 30_000,
  })
})

test("closing a new Window during automatic terminal creation stays quiet", async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
    // The intentionally delayed create races tab archival; the host rejects
    // that stale command while the UI must treat it as an expected close.
    expectedHttpErrors: [{ method: "POST", path: "/api/v1/rpc", status: 400 }],
  })
  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible()

  await page.evaluate(() => {
    const terminals = window.yaade?.mux
    if (!terminals?.createTerminal) throw new Error("terminal API is not ready")
    const selectTab = terminals.selectTab
    terminals.selectTab = async command => {
      document.documentElement.dataset.yaadeTestSelectState = "started"
      try {
        return await selectTab(command)
      } finally {
        document.documentElement.dataset.yaadeTestSelectState = "settled"
      }
    }
    const createTerminal = terminals.createTerminal
    terminals.createTerminal = async command => {
      const released = new Promise<void>(resolve => {
        window.addEventListener("yaade:test-release-create", () => resolve(), {
          once: true,
        })
      })
      document.documentElement.dataset.yaadeTestCreateState = "started"
      await released
      try {
        return await createTerminal(command)
      } finally {
        document.documentElement.dataset.yaadeTestCreateState = "settled"
      }
    }
  })

  const windowTabs = page.locator("[data-yaade-window-tabs] [data-yaade-session-tab]")
  await expect(windowTabs).toHaveCount(1)
  await page.getByRole("button", { name: "New tab" }).click()
  await expect(windowTabs).toHaveCount(2)
  await expect
    .poll(() => page.locator("html").getAttribute("data-yaade-test-create-state"))
    .toBe("started")
  await expect
    .poll(() => page.locator("html").getAttribute("data-yaade-test-select-state"))
    .toBe("settled")

  const newTab = windowTabs.filter({ hasText: "New tab" })
  await newTab.getByRole("button", { name: "Close New tab" }).click()
  await expect(windowTabs).toHaveCount(1)
  await page.evaluate(() => window.dispatchEvent(new Event("yaade:test-release-create")))
  await expect
    .poll(() => page.locator("html").getAttribute("data-yaade-test-create-state"))
    .toBe("settled")
  await expect(page.getByRole("alert").filter({ hasText: "Action failed" })).toHaveCount(0)
})

test("mobile Terminal exposes accessory keys and keeps its surface mounted", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
    mobile: true,
  })
  await expect(page.locator("[data-yaade-terminal-panel]").first()).toBeVisible({
    timeout: 30_000,
  })
  await page.evaluate(() => {
    localStorage.removeItem("yaade:last-terminal-multiplexer-route")
    history.pushState(null, "", "/")
    window.dispatchEvent(new Event("popstate"))
  })
  const session = page.locator("[data-yaade-mobile-session-group]").first()
  await expect(session).toBeVisible()

  await session.locator("[data-yaade-mobile-new-terminal]").first().click()
  await page.locator('[data-yaade-mobile-new-terminal-kind="terminal"]').click()
  await expect(page.locator('[data-yaade-mobile-terminal-detail=""]')).toBeVisible({
    timeout: 30_000,
  })
  await expect(
    page.locator(
      '[data-yaade-mobile-retained-terminal][data-active="true"] [data-yaade-terminal-panel]',
    ),
  ).toBeVisible({ timeout: 30_000 })

  const keys = page.locator("[data-yaade-mobile-terminal-keys]")
  await expect(keys).toBeVisible()
  const ctrl = keys.getByRole("button", { name: "Ctrl", exact: true })
  await ctrl.click()
  await expect(ctrl).toHaveAttribute("aria-pressed", "true")
  await keys.getByRole("button", { name: "Arrow left", exact: true }).click()
  await expect(ctrl).toHaveAttribute("aria-pressed", "false")

  await page.getByRole("button", { name: "Back to terminals" }).click()
  await expect(page.locator('[data-yaade-mobile-shell][data-yaade-mobile-view="terminals"]')).toBeVisible()
  await expect(
    page.locator(`[data-yaade-mobile-terminal][data-terminal-kind="terminal"]`),
  ).toHaveCount(2)
})

test("split shortcuts split the focused pane in both directions", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  })
  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible()
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(1, {
    timeout: 30_000,
  })

  await expect(
    page.locator('[data-yaade-mux-split="right"]').first(),
  ).toHaveAttribute("aria-label", "Split right")
  await expect(
    page.locator('[data-yaade-mux-split="down"]').first(),
  ).toHaveAttribute("aria-label", "Split down")

  await focusTerminal(page)
  const modifier = process.platform === "darwin" ? "Meta" : "Control"
  await page.keyboard.press(`${modifier}+d`)
  await expect(page.locator("[data-yaade-mux-pane-chrome]")).toHaveCount(2)

  await page.keyboard.press(`${modifier}+Shift+d`)
  await expect(page.locator("[data-yaade-mux-pane-chrome]")).toHaveCount(3)
})

test("split controls open Terminal by default and the picker with a modifier", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  })
  await expect(page.locator('[data-yaade-shell="terminal-multiplexer"]')).toBeVisible()

  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible()
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(1, {
    timeout: 30_000,
  })

  const paneChrome = page.locator("[data-yaade-mux-pane-chrome]").first()
  await expect(paneChrome.locator('[data-yaade-mux-split="right"]')).toBeVisible()
  await expect(paneChrome.locator('[data-yaade-mux-split="down"]')).toBeVisible()
  await expect(paneChrome.locator('[data-yaade-mux-close-pane=""]')).toBeVisible()

  await paneChrome.locator('[data-yaade-mux-split="right"]').click()
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(2, {
    timeout: 30_000,
  })
  await expect(page.locator('[data-yaade-empty-terminal-tile]')).toHaveCount(0)
  await expect(page.locator("[data-yaade-pane-terminal-menu]")).toBeHidden()

  const modifier = process.platform === "darwin" ? "Meta" : "Control"
  await paneChrome
    .locator('[data-yaade-mux-split="down"]')
    .click({ modifiers: [modifier] })
  const picker = page.locator("[data-yaade-pane-terminal-menu]")
  await expect(picker).toBeVisible()
  await expect(picker).not.toContainText("New terminal")

  await picker.locator('[data-yaade-pane-new-terminal-kind="terminal"]').click({ force: true })
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(3, {
    timeout: 30_000,
  })
  await expect(page.locator('[data-yaade-empty-terminal-tile]')).toHaveCount(0)
  await expect(page.locator('[data-yaade-mux-zoom=""]').first()).toBeVisible()
  await expect(page.locator('[data-yaade-mux-close-pane=""]').first()).toBeVisible()
  await expect(page.locator('[data-yaade-mux-split="right"]').first()).toBeVisible()
  await expect(page.locator('[data-yaade-mux-split="down"]').first()).toBeVisible()
})

test("closing Settings returns keyboard focus to the terminal", async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  })
  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible()
  await focusTerminal(page)
  await page.getByRole("button", { name: "Settings" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          document.activeElement?.closest("[data-ghostty-terminal-input]"),
        ),
      ),
    )
    .toBe(true)
})
