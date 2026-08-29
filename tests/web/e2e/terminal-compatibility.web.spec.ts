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

  test("forced WebGL2 and Canvas backends render the same retained text", async ({
    launchApp,
  }) => {
    const backends: readonly ("webgl2" | "canvas2d")[] = ["webgl2", "canvas2d"]
    for (const backend of backends) {
      const { page } = await launchApp()
      await page.evaluate(value => localStorage.setItem("yaade:terminal-renderer", value), backend)
      await page.reload({ waitUntil: "domcontentloaded" })
      await focusTerminal(page)
      const panel = page.locator(
        '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
      ).filter({ visible: true }).first()
      await expect(panel).toHaveAttribute("data-yaade-terminal-renderer", "ghostty")
      await expect(panel).toHaveAttribute("data-yaade-terminal-render-backend", backend)
      await page.keyboard.type("printf '\\033cASCII wide:界 combining:é emoji:🙂 underline'")
      await page.keyboard.press("Enter")
      await expect.poll(
        () => page.evaluate(() => window.__yaadeTest?.getTerminalText?.() ?? ""),
        { timeout: 15_000 },
      ).toContain("ASCII wide:界 combining:é emoji:🙂 underline")
      const differingPixels = await panel.locator("[data-ghostty-terminal-canvas]").evaluate(
        (element, renderer) => {
          if (!(element instanceof HTMLCanvasElement)) return 0
          let pixels: Uint8Array | Uint8ClampedArray
          if (renderer === "webgl2") {
            const gl = element.getContext("webgl2")
            if (gl === null) return 0
            pixels = new Uint8Array(element.width * element.height * 4)
            gl.readPixels(0, 0, element.width, element.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
          } else {
            const context = element.getContext("2d")
            if (context === null) return 0
            pixels = context.getImageData(0, 0, element.width, element.height).data
          }
          const red = pixels[0] ?? 0
          const green = pixels[1] ?? 0
          const blue = pixels[2] ?? 0
          let count = 0
          for (let index = 0; index < pixels.length; index += 4) {
            if (
              pixels[index] !== red ||
              pixels[index + 1] !== green ||
              pixels[index + 2] !== blue
            ) count += 1
          }
          return count
        },
        backend,
      )
      expect(differingPixels).toBeGreaterThan(100)
    }
  })

  test("renderer context loss recovers without replacing the PTY or retained text", async ({
    launchApp,
  }) => {
    const { page } = await launchApp()
    await page.evaluate(() => localStorage.setItem("yaade:terminal-renderer", "webgl2"))
    await page.reload({ waitUntil: "domcontentloaded" })
    await focusTerminal(page)
    const panel = page.locator(
      '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
    ).filter({ visible: true }).first()
    await expect(panel).toHaveAttribute("data-yaade-terminal-render-backend", "webgl2")
    const ptyId = await panel.getAttribute("data-yaade-terminal-pty-id")
    await page.keyboard.type("printf 'before-loss\\n'")
    await page.keyboard.press("Enter")
    await expect.poll(
      () => page.evaluate(() => window.__yaadeTest?.getTerminalText?.() ?? ""),
    ).toContain("before-loss")
    await panel.locator("[data-ghostty-terminal-canvas]").evaluate(element => {
      element.dispatchEvent(new Event("webglcontextlost", { cancelable: true }))
    })
    await expect(panel.locator("[data-ghostty-terminal]")).toHaveAttribute(
      "data-ghostty-terminal-renderer-generation",
      "2",
    )
    await page.keyboard.type("printf 'after-loss\\n'")
    await page.keyboard.press("Enter")
    await expect.poll(
      () => page.evaluate(() => window.__yaadeTest?.getTerminalText?.() ?? ""),
      { timeout: 15_000 },
    ).toContain("after-loss")
    await expect(panel).toHaveAttribute("data-yaade-terminal-pty-id", ptyId ?? "")
    await expect(page.locator("[data-yaade-connection]")).toHaveCount(0)
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
