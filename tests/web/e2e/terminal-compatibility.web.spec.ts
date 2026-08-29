import { expect } from "@playwright/test"
import { test } from "../../fixtures/e2e.js"
import { focusTerminal } from "./_launch.js"

const ptyAvailable = process.platform !== "win32"
test.describe("terminal compatibility", () => {
  test.skip(!ptyAvailable, "node-pty cannot spawn a shell on this machine")

  test("terminal input preserves the host connection and browser zoom", async ({ launchApp }) => {
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
      if (state?.activeMuxTerminalId) return state.activeMuxTerminalId
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

    const terminalInput = page.locator(
      `[data-yaade-terminal-tile="${muxTerminalId}"] [data-ghostty-terminal-input]`,
    )
    await expect(terminalInput).toHaveCount(1)
    await expect(terminalInput).toBeFocused()
    await terminalInput.evaluate(element => {
      element.addEventListener("keydown", event => {
        if (
          event instanceof KeyboardEvent &&
          (event.metaKey || event.ctrlKey) &&
          (event.code === "Equal" || event.key === "+" || event.key === "=")
        ) {
          element.setAttribute(
            "data-yaade-test-zoom-default-prevented",
            String(event.defaultPrevented),
          )
        }
      })
    })
    const zoomModifier = process.platform === "darwin" ? "Meta" : "Control"
    await page.keyboard.down(zoomModifier)
    await page.keyboard.down("Shift")
    await page.keyboard.press("=")
    await page.keyboard.up("Shift")
    await page.keyboard.up(zoomModifier)
    await expect(terminalInput).toHaveAttribute(
      "data-yaade-test-zoom-default-prevented",
      "false",
    )

    const terminalCanvas = page.locator(
      `[data-yaade-terminal-tile="${muxTerminalId}"] [data-ghostty-terminal-canvas]`,
    )
    await terminalCanvas.evaluate(element => {
      element.addEventListener("wheel", event => {
        if (event instanceof WheelEvent && event.ctrlKey) {
          element.setAttribute(
            "data-yaade-test-zoom-default-prevented",
            String(event.defaultPrevented),
          )
        }
      })
    })
    await terminalCanvas.hover()
    await page.keyboard.down("Control")
    await page.mouse.wheel(0, -100)
    await page.keyboard.up("Control")
    await expect(terminalCanvas).toHaveAttribute(
      "data-yaade-test-zoom-default-prevented",
      "false",
    )
  })

  test("renders UTF-8 code points split across PTY reads", async ({ launchApp }) => {
    const { page } = await launchApp()
    await focusTerminal(page)
    await page.keyboard.type(
      `node -e "const b=Buffer.from([0xe2,0x94,0x80]);let i=0;const t=setInterval(()=>{process.stdout.write(b.subarray(i,i+1));if(++i===b.length){clearInterval(t);console.log(' YAADE_UTF8_OK')}},50)"`,
    )
    await page.keyboard.press("Enter")

    const terminalText = () =>
      page.evaluate(() => {
        const id = window.__yaadeTest?.getState().activeMuxTerminalId
        return id ? window.__yaadeTest?.getTerminalText?.(id) ?? "" : ""
      })
    await expect.poll(terminalText, { timeout: 15_000 }).toContain("─ YAADE_UTF8_OK")
    expect(await terminalText()).not.toContain("�")
  })

  test("flow control replays from the last parsed frame after a renderer stall", async ({
    launchApp,
  }) => {
    const { page } = await launchApp({
      workspaceRel: "fixtures/sample-workspace",
      env: {
        YAADE_TERMINAL_UNACKNOWLEDGED_BYTES: String(64 * 1024),
      },
    })
    await focusTerminal(page)
    await page.evaluate(() => {
      window.addEventListener("yaade:terminal-replay-required", () => {
        const current = Number(
          document.documentElement.dataset.yaadeTestReplayRequired ?? "0",
        )
        document.documentElement.dataset.yaadeTestReplayRequired = String(
          current + 1,
        )
      })
    })
    await page.keyboard.type(
      `node -e "process.stdout.write('x'.repeat(2*1024*1024));console.log('YAADE_FLOW_RECOVERED')"`,
    )
    await page.keyboard.press("Enter")

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const id = window.__yaadeTest?.getState().activeMuxTerminalId
            return id ? window.__yaadeTest?.getTerminalText?.(id) ?? "" : ""
          }),
        { timeout: 90_000, intervals: [250, 500, 1_000] },
      )
      .toContain("YAADE_FLOW_RECOVERED")
    await expect(page.locator("html")).toHaveAttribute(
      "data-yaade-test-replay-required",
      /[1-9]\d*/,
    )
    await expect(page.locator("[data-yaade-connection]")).toHaveCount(0)
  })
})
