import { expect } from "@playwright/test"
import { test } from "../../fixtures/e2e.js"

const ptyAvailable = process.platform !== "win32"
test.describe("terminal compatibility", () => {
  test.skip(!ptyAvailable, "node-pty cannot spawn a shell on this machine")

  test("typing does not reconnect the host socket", async ({ launchApp }) => {
    const { page } = await launchApp()
    await page.evaluate(() => {
      history.pushState(null, "", "/")
      window.dispatchEvent(new Event("popstate"))
    })
    await expect(page.locator('[data-yaade-shell="terminal-multiplexer"]')).toBeVisible()
    await page.evaluate(() => window.__yaadeTest!.waitForReady())
    const muxTerminalId = await page.evaluate(async () => {
      const terminals = window.yaade?.mux
      const state = window.__yaadeTest?.getState()
      const sessionId = state?.activeSessionId
      if (!terminals || !sessionId) throw new Error("terminal API or session missing")
      const created = await terminals.createTerminal({
        _tag: "CreateTerminal",
        sessionId,
        kind: "terminal",
        input: { _tag: "TerminalInput", kind: "terminal" },
      })
      await window.__yaadeTest?.selectMuxTerminal?.(created.id)
      return created.id
    })
    const surface = page.locator(
      `[data-yaade-terminal-tile="${muxTerminalId}"] [data-ghostty-terminal-canvas], [data-yaade-terminal-tile="${muxTerminalId}"] [data-yaade-terminal-semantic]`,
    )
    await expect(surface).toBeVisible({ timeout: 30_000 })
    await surface.click()
    await page.keyboard.type("echo reconnect-probe")
    await page.keyboard.press("Enter")
    await expect(page.locator("[data-yaade-connection]")).toHaveCount(0)
    await expect
      .poll(
        () =>
          page.evaluate(
            id => window.__yaadeTest?.getTerminalText?.(id) ?? "",
            muxTerminalId,
          ),
        { timeout: 10_000 },
      )
      .toMatch(/reconnect-probe|echo/)
  })
})
