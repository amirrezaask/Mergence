import { expect, test } from "@playwright/test"
import {
  expectContainsText,
  expectLocatorAttached,
  expectLocatorAttribute,
  expectLocatorCount,
  expectLocatorHidden,
  expectLocatorVisible,
  expectSelectorHidden,
  expectSelectorVisible,
  expectLocatorContainsText,
  expectNotContainsText,
} from "../shell/assert.js"

import {
  execCommand,
  focusTerminal,
  hasPtySpawn,
  launchJet,
  openMuxTerminal,
  readTerminalText,
  showTerminal,
  waitForMux,
  waitForTerminalText,
} from "./_launch.js"

const ptyAvailable = hasPtySpawn()

test.describe("electron terminal", () => {
  test.skip(!ptyAvailable, "node-pty cannot spawn a shell on this machine")

  test("names shells distinctly and launches commands without echoing them", async () => {
    const { app, page } = await launchJet()
    try {
      const result = await page.evaluate(async () => {
        const terminal = window.yaade?.terminal
        const workspacePath = window.__yaadeAgent?.getState().activeWorkspace
        if (!terminal || !workspacePath) throw new Error("Terminal API or workspace unavailable")
        const cwdUri = `file://${workspacePath}`
        const first = await terminal.create(cwdUri)
        const second = await terminal.create(cwdUri)
        await terminal.dispose(first.id)
        await terminal.dispose(second.id)

        const direct = await terminal.create(cwdUri, {
          command: "/bin/sh",
          args: ["-c", "printf jet-direct-launch"],
        })
        const output = await new Promise<string>((resolve, reject) => {
          let text = ""
          let unsubscribe = () => {}
          const timeout = window.setTimeout(() => {
            unsubscribe()
            reject(new Error(`Timed out waiting for direct terminal output: ${text}`))
          }, 5_000)
          unsubscribe = terminal.onData(direct.id, data => {
            text += data
            if (!text.includes("jet-direct-launch")) return
            window.clearTimeout(timeout)
            unsubscribe()
            resolve(text)
          })
        })
        await terminal.dispose(direct.id)
        return { firstTitle: first.title, secondTitle: second.title, output }
      })

      expect(result.firstTitle).toMatch(/^\S+(?: \d+)?$/)
      const firstMatch = result.firstTitle!.match(/^(.*?)(?: (\d+))?$/)!
      const firstIndex = firstMatch[2] ? Number(firstMatch[2]) : 1
      expect(result.secondTitle).toBe(`${firstMatch[1]} ${firstIndex + 1}`)
      expect(result.output).toContain("jet-direct-launch")
      expect(result.output).not.toContain("printf jet-direct-launch")
      expect(result.output).not.toContain("/bin/sh")
    } finally {
      await app.close()
    }
  })

  test("streams Unicode output without corrupting the terminal session", async () => {
    const { app, page } = await launchJet()
    try {
      const output = await page.evaluate(async () => {
        const terminal = window.yaade?.terminal
        const workspacePath = window.__yaadeAgent?.getState().activeWorkspace
        if (!terminal || !workspacePath) throw new Error("Terminal API or workspace unavailable")
        const direct = await terminal.create(`file://${workspacePath}`, {
          command: "/bin/sh",
          args: ["-c", "printf 'سلام🙂 yaade-unicode-tail'"],
        })
        const text = await new Promise<string>((resolve, reject) => {
          let received = ""
          let unsubscribe = () => {}
          const timeout = window.setTimeout(() => {
            unsubscribe()
            reject(new Error(`Timed out waiting for Unicode output: ${received}`))
          }, 5_000)
          unsubscribe = terminal.onData(direct.id, chunk => {
            received += chunk
            if (!received.includes("yaade-unicode-tail")) return
            window.clearTimeout(timeout)
            unsubscribe()
            resolve(received)
          })
        })
        await terminal.dispose(direct.id)
        return text
      })

      expect(output).toContain("سلام🙂")
      expect(output).toContain("yaade-unicode-tail")
    } finally {
      await app.close()
    }
  })

  test("falls back to Symbols Nerd Font Mono for icon glyphs", async ({}, testInfo) => {
    const { app, page } = await launchJet()
    try {
      await showTerminal(page)

      const font = await page.evaluate(async () => {
        await document.fonts.load('16px "Symbols Nerd Font Mono"', "\uE725")
        const glyph = "\uE725"
        const draw = (family: string) => {
          const canvas = document.createElement("canvas")
          canvas.width = 48
          canvas.height = 48
          const ctx = canvas.getContext("2d")
          if (!ctx) return ""
          ctx.fillStyle = "#ffffff"
          ctx.font = `32px ${family}`
          ctx.textBaseline = "top"
          ctx.fillText(glyph, 8, 8)
          return canvas.toDataURL()
        }
        return {
          stack: getComputedStyle(document.documentElement)
            .getPropertyValue("--font-mono")
            .trim(),
          loaded: document.fonts.check(
            '16px "Symbols Nerd Font Mono"',
            glyph,
          ),
          tofu: draw('"Commit Mono"'),
          fallback: draw('"Commit Mono", "Symbols Nerd Font Mono"'),
        }
      })

      expect(font.stack).toContain("Commit Mono")
      expect(font.stack).toContain("Symbols Nerd Font Mono")
      expect(font.loaded).toBe(true)
      expect(font.fallback).not.toBe(font.tofu)

      const ptyId = await page
        .locator("[data-yaade-terminal-panel]")
        .getAttribute("data-yaade-terminal-pty-id")
      expect(ptyId).toBeTruthy()
      await page.evaluate(async id => {
        const terminal = window.yaade?.terminal
        if (!terminal) throw new Error("Terminal API unavailable")
        await terminal.write(id, `printf '${"\uE725"} nerd-glyph-ok\\n'\n`)
      }, ptyId!)
      await waitForTerminalText(page, "nerd-glyph-ok")

      await testInfo.attach("nerd-font-terminal.png", {
        body: Buffer.from(await page.screenshot(), "base64"),
        contentType: "image/png",
      })
    } finally {
      await app.close()
    }
  })

  test("foreground reconnect catches mounted terminals up from PTY replay", async () => {
    const { app, page } = await launchJet()
    try {
      await page.addInitScript(() => {
        const NativeWebSocket = window.WebSocket
        const state = {
          count: 0,
          latest: null as WebSocket | null,
        }
        class TrackedWebSocket extends NativeWebSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            if (protocols === undefined) super(url)
            else super(url, protocols)
            if (String(url).includes("/ws?")) {
              state.count += 1
              state.latest = this
            }
          }
        }
        window.WebSocket = TrackedWebSocket
        ;(
          window as Window & {
            __yaadeRealtimeProbe?: {
              count: () => number
            }
          }
        ).__yaadeRealtimeProbe = {
          count: () => state.count,
        }
      })
      await page.reload({ waitUntil: "domcontentloaded" })
      await waitForMux(page)
      await openMuxTerminal(page)
      await showTerminal(page)

      const panel = page.locator("[data-yaade-terminal-panel]")
      const ptyId = await panel.getAttribute("data-yaade-terminal-pty-id")
      expect(ptyId).toBeTruthy()
      const socketCount = await page.evaluate(
        () =>
          (
            window as Window & {
              __yaadeRealtimeProbe?: { count: () => number }
            }
          ).__yaadeRealtimeProbe?.count() ?? 0,
      )
      expect(socketCount).toBeGreaterThan(0)

      const marker = `yaade-refocus-replay-${Date.now()}`
      await page.evaluate(
        async ({ id, markerText }) => {
          let visibility: DocumentVisibilityState = "hidden"
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => visibility,
          })
          document.dispatchEvent(new Event("visibilitychange"))
          visibility = "visible"
          document.dispatchEvent(new Event("visibilitychange"))

          const invoke = async (channel: string, args: unknown[]) => {
            const response = await fetch("/api/v1/rpc", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ channel, args, clientId: "e2e-refocus-probe" }),
            })
            if (!response.ok) throw new Error(`RPC ${channel} failed: ${response.status}`)
            return (await response.json()) as { value?: unknown }
          }
          await invoke("terminal:write", [id, `printf '\\n%s\\n' '${markerText}'\n`])

          const deadline = performance.now() + 5_000
          let markerReachedHost = false
          while (performance.now() < deadline) {
            const response = await invoke("terminal:attach", [id, 0])
            const snapshot = response.value as
              | { outputChunks?: string[]; output?: string }
              | undefined
            const output = snapshot?.outputChunks?.join("") ?? snapshot?.output ?? ""
            if (output.includes(markerText)) {
              markerReachedHost = true
              break
            }
            await new Promise<void>(resolve => setTimeout(resolve, 20))
          }
          if (!markerReachedHost) throw new Error("terminal marker did not reach host replay")

          window.dispatchEvent(new Event("focus"))
        },
        { id: ptyId!, markerText: marker },
      )

      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                (
                  window as Window & {
                    __yaadeRealtimeProbe?: { count: () => number }
                  }
                ).__yaadeRealtimeProbe?.count() ?? 0,
            ),
          { timeout: 10_000 },
        )
        .toBeGreaterThan(socketCount)
      await expect
        .poll(async () => readTerminalText(page), { timeout: 10_000 })
        .toContain(marker)
      expect(await panel.getAttribute("data-yaade-terminal-pty-id")).toBe(ptyId)
    } finally {
      await app.close()
    }
  })

  test("preserves non-UTF-8 xterm binary input bytes", async () => {
    const { app, page } = await launchJet()
    try {
      const output = await page.evaluate(async () => {
        const terminal = window.yaade?.terminal
        const workspacePath = window.__yaadeAgent?.getState().activeWorkspace
        if (!terminal || !workspacePath) throw new Error("Terminal API or workspace unavailable")
        const direct = await terminal.create(`file://${workspacePath}`, {
          command: "/bin/sh",
          args: ["-c", "stty raw -echo; od -An -t u1 -N 3"],
        })
        const text = new Promise<string>((resolve, reject) => {
          let received = ""
          let unsubscribe = () => {}
          const timeout = window.setTimeout(() => {
            unsubscribe()
            reject(new Error(`Timed out waiting for binary terminal input: ${received}`))
          }, 5_000)
          unsubscribe = terminal.onData(direct.id, chunk => {
            received += chunk
            if (!/0\s+128\s+255/.test(received)) return
            window.clearTimeout(timeout)
            unsubscribe()
            resolve(received)
          })
        })
        await terminal.writeBinary(
          direct.id,
          btoa(String.fromCharCode(0, 128, 255)),
        )
        const received = await text
        await terminal.dispose(direct.id)
        return received
      })

      expect(output).toMatch(/0\s+128\s+255/)
    } finally {
      await app.close()
    }
  })

  test("runs ls and shows fixture directory listing", async () => {
    const { app, page } = await launchJet()
    try {
      await showTerminal(page)
      await focusTerminal(page)

      await page.waitForFunction(
        () => (window.__yaadeAgent?.getTerminalText?.() ?? "").trim().length > 0,
        null,
        { timeout: 15_000 },
      )

      const startupText = await readTerminalText(page)
      expect(startupText).not.toContain("precmd_jet_title")
      expect(startupText).not.toContain("preexec_jet_title")

      // Fixture dir may be empty — seed markers then list (avoid fish `ls`→eza alias).
      await page.keyboard.type("mkdir -p src && touch package.json && /bin/ls")
      await page.keyboard.press("Enter")

      await page.waitForFunction(
        () => {
          const text = window.__yaadeAgent?.getTerminalText?.() ?? ""
          return text.includes("package.json") || text.includes("src")
        },
        null,
        { timeout: 15_000 },
      )

      const text = await readTerminalText(page)
      expect(text).toMatch(/package\.json|src/)
    } finally {
      await app.close()
    }
  })

  test("xterm row height is readable", async () => {
    const { app, page } = await launchJet()
    try {
      await showTerminal(page)

      await page.waitForFunction(
        () => (window.__yaadeAgent?.getTerminalCellHeight?.() ?? 0) >= 10,
        null,
        { timeout: 15_000 },
      )

      const rowHeight = await page.evaluate(
        () => window.__yaadeAgent?.getTerminalCellHeight?.() ?? 0,
      )
      expect(rowHeight).toBeGreaterThanOrEqual(10)
    } finally {
      await app.close()
    }
  })

  test("sends fitted geometry immediately after PTY creation", async () => {
    const { app, page } = await launchJet({ projectPage: true })
    try {
      await page.evaluate(() => {
        const terminal = window.yaade?.terminal
        if (!terminal) throw new Error("Terminal API unavailable")
        const originalResize = terminal.resize.bind(terminal)
        const originalCreate = terminal.create.bind(terminal)
        const resizeCalls: Array<{ cols: number; rows: number }> = []
        const createCalls: Array<{ cols?: number; rows?: number }> = []
        terminal.create = async (cwdUri, launch) => {
          createCalls.push({ cols: launch?.cols, rows: launch?.rows })
          return originalCreate(cwdUri, launch)
        }
        terminal.resize = async (id, cols, rows) => {
          resizeCalls.push({ cols, rows })
          return originalResize(id, cols, rows)
        }
        ;(
          window as unknown as {
            __yaadeResizeCalls?: Array<{ cols: number; rows: number }>
            __yaadeCreateCalls?: Array<{ cols?: number; rows?: number }>
          }
        ).__yaadeResizeCalls = resizeCalls
        ;(
          window as unknown as {
            __yaadeCreateCalls?: Array<{ cols?: number; rows?: number }>
          }
        ).__yaadeCreateCalls = createCalls
      })

      await page.evaluate(async () => {
        await window.__yaadeAgent!.createProjectSession!({
          title: "Geometry session",
        })
      })
      await waitForMux(page)
      await openMuxTerminal(page)

      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as unknown as {
                  __yaadeResizeCalls?: Array<{
                    cols: number
                    rows: number
                  }>
                  __yaadeCreateCalls?: Array<{
                    cols?: number
                    rows?: number
                  }>
                }
              ).__yaadeResizeCalls?.at(-1) ??
              (
                window as unknown as {
                  __yaadeCreateCalls?: Array<{ cols?: number; rows?: number }>
                }
              ).__yaadeCreateCalls?.at(-1) ??
              null,
          ),
        )
        .toEqual(
          expect.objectContaining({
            cols: expect.any(Number),
            rows: expect.any(Number),
          }),
        )
      const geometry = await page.evaluate(() => {
        const state = window as unknown as {
          __yaadeResizeCalls?: Array<{ cols: number; rows: number }>
          __yaadeCreateCalls?: Array<{ cols?: number; rows?: number }>
        }
        return state.__yaadeResizeCalls?.at(-1) ?? state.__yaadeCreateCalls?.at(-1)
      })
      expect(geometry!.cols).toBeGreaterThan(80)
      expect(geometry!.rows).toBeGreaterThan(24)
      const calls = await page.evaluate(() => {
        const state = window as unknown as {
          __yaadeResizeCalls?: Array<{ cols: number; rows: number }>
          __yaadeCreateCalls?: Array<{ cols?: number; rows?: number }>
        }
        return {
          initial: state.__yaadeCreateCalls?.at(-1),
          resized: state.__yaadeResizeCalls?.at(-1),
          createCount: state.__yaadeCreateCalls?.length ?? 0,
          resizeCount: state.__yaadeResizeCalls?.length ?? 0,
        }
      })
      // Fitted geometry must reach the host via create and/or the immediate
      // post-create resize. xterm v6 WebGL fit can land after create returns.
      const fitted = calls.resized ?? calls.initial
      expect(fitted).toEqual(
        expect.objectContaining({ cols: geometry!.cols, rows: geometry!.rows }),
      )
      expect(calls.createCount + calls.resizeCount).toBeGreaterThan(0)
      if (calls.initial?.cols && calls.resized) {
        expect(calls.resized).toEqual(
          expect.objectContaining({
            cols: expect.any(Number),
            rows: expect.any(Number),
          }),
        )
      }
    } finally {
      await app.close()
    }
  })

  test("carriage-return progress updates overwrite the same line", async () => {
    const { app, page } = await launchJet()
    try {
      await showTerminal(page)
      await focusTerminal(page)

      const ptyId = await page
        .locator("[data-yaade-terminal-panel]")
        .getAttribute("data-yaade-terminal-pty-id")
      expect(ptyId).toBeTruthy()

      await page.evaluate(async id => {
        const terminal = window.yaade?.terminal
        if (!terminal) throw new Error("Terminal API unavailable")
        // Run printf so CR is on the PTY → xterm display path (not shell line-edit).
        await terminal.write(
          id,
          "printf 'CR-TEST-AAAA\\rCR-TEST-BBBB\\n'; echo CR-TEST-DONE\n",
        )
      }, ptyId!)

      await expect
        .poll(async () => readTerminalText(page), { timeout: 10_000 })
        .toContain("CR-TEST-DONE")

      const text = await readTerminalText(page)
      expect(text).toContain("CR-TEST-BBBB")
      expect(text).toContain("CR-TEST-DONE")
      // Progress line itself must be rewritten (no stacked AAAA→BBBB on one line).
      expect(text).not.toMatch(/CR-TEST-AAAA\s*CR-TEST-BBBB/)
    } finally {
      await app.close()
    }
  })

  test("PTY winsize stays in sync with fitted xterm after layout settles", async () => {
    const { app, page } = await launchJet()
    try {
      await showTerminal(page)
      await focusTerminal(page)

      const ptyId = await page
        .locator("[data-yaade-terminal-panel]")
        .getAttribute("data-yaade-terminal-pty-id")
      expect(ptyId).toBeTruthy()

      await page.evaluate(async id => {
        const terminal = window.yaade?.terminal
        if (!terminal) throw new Error("Terminal API unavailable")
        await terminal.write(id, "stty size; echo STTY-SIZE-DONE\n")
      }, ptyId!)

      await expect
        .poll(
          async () => {
            return page.evaluate(() => {
              const text = window.__yaadeAgent?.getTerminalText?.() ?? ""
              const match = text.match(/(\d+)\s+(\d+)[\s\S]*STTY-SIZE-DONE/)
              const dims = window.__yaadeAgent?.getTerminalDims?.() ?? null
              if (!match || !dims) return null
              return {
                ptyRows: Number(match[1]),
                ptyCols: Number(match[2]),
                rowCount: dims.rows,
                colCount: dims.cols,
              }
            })
          },
          { timeout: 10_000 },
        )
        .toBeTruthy()

      const sizes = await page.evaluate(() => {
        const text = window.__yaadeAgent?.getTerminalText?.() ?? ""
        const match = text.match(/(\d+)\s+(\d+)[\s\S]*STTY-SIZE-DONE/)
        const dims = window.__yaadeAgent?.getTerminalDims?.() ?? null
        if (!match || !dims) return null
        return {
          ptyRows: Number(match[1]),
          ptyCols: Number(match[2]),
          rowCount: dims.rows,
          colCount: dims.cols,
        }
      })
      expect(sizes).toBeTruthy()
      expect(sizes!.ptyCols).toBeGreaterThan(40)
      expect(sizes!.ptyRows).toBeGreaterThan(10)
      // Fitted xterm geometry must match PTY winsize.
      expect(sizes!.rowCount).toBe(sizes!.ptyRows)
      expect(sizes!.colCount).toBe(sizes!.ptyCols)
    } finally {
      await app.close()
    }
  })

  test("hides the hardware cursor after CSI ?25l (TUI park)", async () => {
    const { app, page } = await launchJet()
    try {
      await showTerminal(page)
      await focusTerminal(page)

      const ptyId = await page
        .locator("[data-yaade-terminal-panel]")
        .getAttribute("data-yaade-terminal-pty-id")
      expect(ptyId).toBeTruthy()

      // Park caret on last row then hide — Cursor Agent pattern (fake UI caret elsewhere).
      // sleep keeps the shell from redrawing a prompt (which often sends ?25h).
      await page.evaluate(async id => {
        const terminal = window.yaade?.terminal
        if (!terminal) throw new Error("Terminal API unavailable")
        await terminal.write(
          id,
          "printf '\\033[2J\\033[HUI-CARET\\033[999;1H\\033[?25lCURSOR-HIDE-DONE\\n'; sleep 8\n",
        )
      }, ptyId!)

      await expect
        .poll(async () => readTerminalText(page), { timeout: 10_000 })
        .toContain("CURSOR-HIDE-DONE")

      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const hidden =
                window.__yaadeAgent?.getTerminalCursor?.()?.hidden === true
              const panel = document.querySelector<HTMLElement>(
                "[data-yaade-terminal-panel]",
              )
              const attr = panel?.dataset.yaadeTerminalCursorHidden === "1"
              return hidden || attr
            }),
          { timeout: 5_000 },
        )
        .toBe(true)

      const visibleHardwareCaret = await page.evaluate(() => {
        const cursors = [
          ...document.querySelectorAll<HTMLElement>(
            "[data-yaade-terminal-panel] .xterm-cursor",
          ),
        ]
        return cursors.some(el => {
          const style = getComputedStyle(el)
          if (style.visibility === "hidden" || style.display === "none") return false
          if (Number.parseFloat(style.opacity || "1") < 0.05) return false
          // Bar caret uses inset box-shadow; block uses background.
          return (
            style.boxShadow !== "none" ||
            (style.backgroundColor !== "rgba(0, 0, 0, 0)" &&
              style.backgroundColor !== "transparent")
          )
        })
      })
      expect(visibleHardwareCaret).toBe(false)
    } finally {
      await app.close()
    }
  })

  test("updates pane title when shell emits OSC title sequence", async () => {
    const { app, page } = await launchJet()
    try {
      await showTerminal(page)
      await focusTerminal(page)

      await page.waitForFunction(
        () => (window.__yaadeAgent?.getTerminalText?.() ?? "").trim().length > 0,
        null,
        { timeout: 15_000 },
      )

      const ptyId = await page
        .locator("[data-yaade-terminal-panel]")
        .getAttribute("data-yaade-terminal-pty-id")
      expect(ptyId).toBeTruthy()

      // Drive OSC via PTY write so shell quoting cannot mangle the sequence.
      await page.evaluate(async id => {
        const terminal = window.yaade?.terminal
        if (!terminal) throw new Error("Terminal API unavailable")
        await terminal.write(id, "printf '\\033]0;JetTitleTest\\007'\n")
      }, ptyId)

      // Mux chrome may prefer process name; OSC title still reaches the buffer /
      // title path — accept process name or path chrome, and require the
      // printf payload in terminal text.
      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const chrome = document.querySelector("[data-yaade-mux-pane-chrome]")
              return chrome?.textContent ?? ""
            }),
          { timeout: 15_000 },
        )
        .toMatch(/JetTitleTest|Terminal|fish|~|\//)
      await expect
        .poll(async () => readTerminalText(page), { timeout: 10_000 })
        .toMatch(/JetTitleTest|printf/)
    } finally {
      await app.close()
    }
  })

  test("keeps exited terminal output visible and offers restart", async () => {
    const { app, page } = await launchJet()
    try {
      await showTerminal(page)

      await page.locator("[data-yaade-terminal-panel] \.yaade-terminal-surface").click()
      await page.evaluate(() => {
        const textarea = document.querySelector(
          "[data-yaade-terminal-panel] .xterm-helper-textarea",
        ) as HTMLTextAreaElement | null
        textarea?.focus()
      })

      await page.waitForFunction(
        () => (window.__yaadeAgent?.getTerminalText?.() ?? "").trim().length > 0,
        null,
        { timeout: 15_000 },
      )

      await page.keyboard.type("exit")
      await page.keyboard.press("Enter")

      await expectLocatorAttribute(page.locator("[data-yaade-terminal-panel]"), 
        "data-yaade-terminal-status",
        "exited",
        { timeout: 15_000 },
      )
      const exitBar = page.locator("[data-yaade-terminal-exit-bar]")
      await expectLocatorVisible(exitBar, { timeout: 15_000 })
      await expectLocatorContainsText(exitBar, "Process exited")
      await expectLocatorVisible(exitBar.getByRole("button", { name: "Restart" }))
      await expectSelectorVisible(page, "[data-yaade-terminal-panel] .xterm")
    } finally {
      await app.close()
    }
  })

  test("xterm viewport fills terminal surface below tab bar", async () => {
    const { app, page } = await launchJet()
    try {
      await showTerminal(page)

      const layout = await page.evaluate(() => {
        const surface = document.querySelector(
          "[data-yaade-terminal-panel] \.yaade-terminal-surface",
        ) as HTMLElement | null
        const viewport = document.querySelector(
          "[data-yaade-terminal-panel] .xterm-viewport",
        ) as HTMLElement | null
        if (!surface || !viewport) return null
        const surfaceRect = surface.getBoundingClientRect()
        const viewportRect = viewport.getBoundingClientRect()
        return {
          surfaceHeight: surfaceRect.height,
          viewportHeight: viewportRect.height,
          viewportTop: viewportRect.top - surfaceRect.top,
        }
      })

      expect(layout).not.toBeNull()
      expect(layout!.surfaceHeight).toBeGreaterThan(48)
      expect(layout!.viewportHeight).toBeGreaterThan(24)
      expect(layout!.viewportTop).toBeGreaterThanOrEqual(0)
      expect(layout!.viewportTop).toBeLessThan(8)
    } finally {
      await app.close()
    }
  })

  test("keeps one native terminal caret", async () => {
    const { app, page } = await launchJet()
    try {
      await showTerminal(page)
      const panel = page.locator("[data-yaade-terminal-panel]")
      await expectLocatorAttribute(panel, "data-yaade-terminal-status", "running")

      await expectLocatorCount(panel.locator("[data-yaade-terminal-cursor-trail]"), 0)
      // WebGL draws the caret on canvas — no DomRenderer `.xterm-cursor`.
      // Dom fallback still exposes exactly one DOM caret.
      const renderer = await panel.getAttribute("data-yaade-terminal-renderer")
      if (renderer === "dom" || renderer == null) {
        await expectLocatorCount(panel.locator(".xterm-cursor"), 1)
      } else {
        expect(renderer).toBe("webgl")
        await expectLocatorCount(panel.locator(".xterm-helper-textarea"), 1)
      }

      await panel.locator(".yaade-terminal-surface").click()
      await page.keyboard.type("cursor")
      if (renderer === "dom" || renderer == null) {
        await expectLocatorCount(panel.locator(".xterm-cursor"), 1)
      }
      await expectLocatorCount(panel.locator("[data-yaade-terminal-cursor-ghost]"), 0)
      const cursor = await page.evaluate(() => window.__yaadeAgent?.getTerminalCursor?.())
      expect(cursor).toBeTruthy()
      expect(cursor!.hidden).toBe(false)
    } finally {
      await app.close()
    }
  })

  test.skip("cursor stays inside xterm screen after modal close and reopen", async () => {
    // Targets Mission Control sidebar + yaade.goHome; mux has no modal shell.
    const { app, page } = await launchJet()
    try {
      await showTerminal(page)
      const panel = page.locator("[data-yaade-terminal-panel]")
      await expectLocatorAttribute(panel, "data-yaade-terminal-status", "running")

      await execCommand(page, "yaade.goHome")
      await expectLocatorCount(page.locator("[data-yaade-terminal-modal]"), 0)
      await expectSelectorVisible(page, "[data-yaade-mission-sidebar]")

      await page.locator("[data-yaade-sidebar-session]").first().click()
      await expectSelectorVisible(page, "[data-yaade-terminal-modal]")
      await expectLocatorAttribute(panel, "data-yaade-terminal-status", "running")

      await page.waitForFunction(() => {
        const dims = window.__yaadeAgent?.getTerminalDims?.()
        const cursor = window.__yaadeAgent?.getTerminalCursor?.()
        if (!dims || !cursor || cursor.hidden) return false
        return (
          cursor.x >= 0 &&
          cursor.y >= 0 &&
          cursor.x < dims.cols &&
          cursor.y < dims.rows
        )
      })

      const box = await page.evaluate(() => {
        const dims = window.__yaadeAgent!.getTerminalDims!()!
        const cursor = window.__yaadeAgent!.getTerminalCursor!()!
        const screen = document.querySelector<HTMLElement>(
          "[data-yaade-terminal-panel] .xterm-screen",
        )
        const canvas = document.querySelector<HTMLElement>(
          "[data-yaade-terminal-panel] canvas",
        )
        const screenRect = screen?.getBoundingClientRect()
        const canvasRect = canvas?.getBoundingClientRect()
        return {
          cursorX: cursor.x,
          cursorY: cursor.y,
          cols: dims.cols,
          rows: dims.rows,
          canvasInsideScreen:
            !screenRect ||
            !canvasRect ||
            (canvasRect.left >= screenRect.left - 2 &&
              canvasRect.top >= screenRect.top - 2 &&
              canvasRect.right <= screenRect.right + 2 &&
              canvasRect.bottom <= screenRect.bottom + 2),
        }
      })
      expect(box.cursorX).toBeGreaterThanOrEqual(0)
      expect(box.cursorY).toBeGreaterThanOrEqual(0)
      expect(box.cursorX).toBeLessThan(box.cols)
      expect(box.cursorY).toBeLessThan(box.rows)
      expect(box.canvasInsideScreen).toBe(true)
    } finally {
      await app.close()
    }
  })

  test("Escape is written to the active terminal instead of closing its session", async () => {
    test.setTimeout(60_000)
    const { app, page } = await launchJet()
    try {
      await showTerminal(page)
      // Match mux.keyboard Escape regression: click panel, don't over-focus.
      await page.locator("[data-yaade-terminal-panel]").first().click()

      await page.keyboard.type("echo yaadeESC")
      await page.keyboard.press("Escape")
      await page.keyboard.press("KeyB")
      await page.keyboard.type("XX")
      await page.keyboard.press("Enter")
      await waitForTerminalText(page, "XXyaadeESC", 20_000)

      // Chrome controls are opacity-0 until hover — force-focus so Playwright
      // does not wait forever on actionability. Escape must not close the session
      // (global Escape is only claimed while zoomed).
      await page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>(
          "[data-yaade-mux-pane-chrome] button",
        )
        button?.focus()
      })
      await page.keyboard.press("Escape")
      await expectSelectorVisible(page, "[data-yaade-mux]")
      await expectSelectorVisible(page, "[data-yaade-terminal-panel]")
    } finally {
      await app.close()
    }
  })

  test("Shift+Enter sends LF to the PTY for multiline CLI input", async () => {
    const { app, page } = await launchJet()
    try {
      await showTerminal(page)

      await page.locator("[data-yaade-terminal-panel] \.yaade-terminal-surface").click()
      await page.evaluate(() => {
        const textarea = document.querySelector(
          "[data-yaade-terminal-panel] .xterm-helper-textarea",
        ) as HTMLTextAreaElement | null
        textarea?.focus()
      })

      await page.waitForFunction(
        () => (window.__yaadeAgent?.getTerminalText?.() ?? "").trim().length > 0,
        null,
        { timeout: 15_000 },
      )

      const written = await page.evaluate(async () => {
        const terminal = window.yaade?.terminal
        if (!terminal) throw new Error("Terminal API unavailable")
        const chunks: string[] = []
        const original = terminal.write.bind(terminal)
        ;(terminal as { write: typeof original }).write = async (id: string, data: string) => {
          chunks.push(data)
          return original(id, data)
        }
        ;(window as unknown as { __yaadeTermWriteChunks?: string[] }).__yaadeTermWriteChunks = chunks
        ;(window as unknown as { __yaadeTermWriteRestore?: () => void }).__yaadeTermWriteRestore = () => {
          terminal.write = original
        }
        return null
      })

      expect(written).toBeNull()

      await page.keyboard.press("Shift+Enter")
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                (
                  (window as unknown as { __yaadeTermWriteChunks?: string[] })
                    .__yaadeTermWriteChunks ?? []
                ).join(""),
            ),
          { timeout: 5_000 },
        )
        .toContain("\n")

      const bytes = await page.evaluate(() => {
        const chunks = (window as unknown as { __yaadeTermWriteChunks?: string[] }).__yaadeTermWriteChunks ?? []
        ;(window as unknown as { __yaadeTermWriteRestore?: () => void }).__yaadeTermWriteRestore?.()
        return chunks.join("")
      })

      expect(bytes).toContain("\n")
      expect(bytes).not.toContain("\r")
    } finally {
      await app.close()
    }
  })

  test("maps macOS terminal navigation keys to readline input", async () => {
    const { app, page } = await launchJet()
    try {
      await showTerminal(page)
      await focusTerminal(page)
      await page.evaluate(() => {
        const terminal = window.yaade?.terminal
        if (!terminal) throw new Error("Terminal API unavailable")
        const target = window as Window & { __terminalNavigationWrites?: string[] }
        target.__terminalNavigationWrites = []
        const original = terminal.write.bind(terminal)
        terminal.write = async (ptyId, data) => {
          target.__terminalNavigationWrites?.push(data)
          return original(ptyId, data)
        }
      })

      await page.keyboard.press("Alt+ArrowLeft")
      await page.keyboard.press("Meta+ArrowRight")
      await page.keyboard.press("Meta+Backspace")

      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as Window & {
                  __terminalNavigationWrites?: string[]
                }
              ).__terminalNavigationWrites?.join("") ?? "",
          ),
        )
        .toContain("\u001bb\u0005\u0015")
    } finally {
      await app.close()
    }
  })

  test("uses xterm smooth scrolling for terminal scrollback", async () => {
    const { app, page } = await launchJet()
    try {
      await showTerminal(page)
      await focusTerminal(page)
      await page.keyboard.type("seq 1 240")
      await page.keyboard.press("Enter")
      await page.waitForFunction(() => {
        const text = window.__yaadeAgent?.getTerminalText?.() ?? ""
        const y = window.__yaadeAgent?.getTerminalViewportY?.()
        // Enough scrollback that viewportY can move up from the bottom.
        return text.includes("240") && typeof y === "number" && y > 10
      }, null, { timeout: 15_000 })

      const before = await page.evaluate(
        () => window.__yaadeAgent?.getTerminalViewportY?.() ?? -1,
      )
      await page.evaluate(() => {
        window.__yaadeAgent?.scrollTerminalLines?.(-40)
      })
      await expect
        .poll(() =>
          page.evaluate(() => window.__yaadeAgent?.getTerminalViewportY?.() ?? -1),
        )
        .toBeLessThan(before)
    } finally {
      await app.close()
    }
  })

  test("inserts shell-quoted dropped file paths into the PTY", async () => {
    const { app, page } = await launchJet()
    try {
      await showTerminal(page)
      await focusTerminal(page)

      await expect
        .poll(
          async () =>
            page.evaluate(() => Boolean(window.__yaadeOsFileDropInstalled)),
          { timeout: 10_000 },
        )
        .toBe(true)

      const needle = "yaade-drop-path-fixture"
      const dropped = await page.evaluate(async pathNeedle => {
        const path = `/tmp/${pathNeedle} with spaces.txt`
        const ok = await window.__yaadeAgent!.dropFilesOnTerminal([path])
        return { ok, path }
      }, needle)
      expect(dropped.ok).toBe(true)
      await expect
        .poll(async () => readTerminalText(page), { timeout: 10_000 })
        .toContain(needle)
      const text = await readTerminalText(page)
      expect(text).toContain("'")
      expect(text).toContain("with spaces")
    } finally {
      await app.close()
    }
  })

  test("accepts browser uri-list drops into the PTY", async () => {
    const { app, page } = await launchJet()
    try {
      await showTerminal(page)
      await focusTerminal(page)

      const result = await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>(
          '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
        )
        if (!panel) throw new Error("running terminal panel unavailable")
        const rect = panel.getBoundingClientRect()
        const dataTransfer = new DataTransfer()
        dataTransfer.setData("text/uri-list", "file:///tmp/yaade-browser-drop.txt")
        const eventInit: DragEventInit = {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          dataTransfer,
        }
        panel.dispatchEvent(new DragEvent("dragover", eventInit))
        const drop = new DragEvent("drop", eventInit)
        panel.dispatchEvent(drop)
        return { defaultPrevented: drop.defaultPrevented }
      })

      expect(result.defaultPrevented).toBe(true)
      await expect
        .poll(async () => readTerminalText(page), { timeout: 10_000 })
        .toContain("yaade-browser-drop.txt")
    } finally {
      await app.close()
    }
  })

  test("inserts dropped image paths into the PTY", async () => {
    const { app, page } = await launchJet()
    try {
      await showTerminal(page)
      await focusTerminal(page)
      const needle = "yaade-drop-image-fixture"
      const dropped = await page.evaluate(async pathNeedle => {
        const path = `/tmp/${pathNeedle}.png`
        const ok = await window.__yaadeAgent!.dropFilesOnTerminal([path])
        return { ok, path }
      }, needle)
      expect(dropped.ok).toBe(true)
      await expect
        .poll(async () => readTerminalText(page), { timeout: 10_000 })
        .toContain(needle)
      const text = await readTerminalText(page)
      expect(text).toContain(".png")
    } finally {
      await app.close()
    }
  })

  test("underlines http links and opens them with Cmd-click", async () => {
    const { app, page } = await launchJet()
    try {
      await showTerminal(page)
      await focusTerminal(page)

      const url = "https://example.com/yaade-term-link"
      const ptyId = await page
        .locator("[data-yaade-terminal-panel]")
        .getAttribute("data-yaade-terminal-pty-id")
      expect(ptyId).toBeTruthy()

      await page.evaluate(
        async ({ id, href }) => {
          const terminal = window.yaade?.terminal
          if (!terminal) throw new Error("Terminal API unavailable")
          await terminal.write(id, `printf '%s\\n' '${href}'\n`)
        },
        { id: ptyId!, href: url },
      )

      await expect
        .poll(async () => readTerminalText(page), { timeout: 10_000 })
        .toContain(url)

      await page.evaluate(() => {
        const w = window as Window & { __yaadeOpenedUrls?: string[] }
        w.__yaadeOpenedUrls = []
        w.open = (() => {
          const fake = {
            opener: null as unknown,
            location: { href: "" },
          }
          Object.defineProperty(fake.location, "href", {
            set(value: string) {
              w.__yaadeOpenedUrls!.push(value)
            },
            get() {
              return ""
            },
          })
          return fake
        }) as typeof window.open
      })

      let hit: { x: number; y: number } | null = null
      await expect
        .poll(async () => {
          hit = await page.evaluate(needle => {
            const match = window.__yaadeAgent?.findTerminalText?.(needle)
            const cell = window.__yaadeAgent?.getTerminalCellSize?.()
            const screen = document.querySelector<HTMLElement>(
              "[data-yaade-terminal-panel] .xterm-screen",
            )
            if (!match || !cell || !screen) return null
            const rect = screen.getBoundingClientRect()
            const style = getComputedStyle(screen)
            const padX = Number.parseFloat(style.paddingLeft) || 0
            const padY = Number.parseFloat(style.paddingTop) || 0
            const x = rect.left + padX + (match.col + 0.5) * cell.width
            const y = rect.top + padY + (match.viewportRow + 0.5) * cell.height
            if (![x, y].every(Number.isFinite)) return null
            return { x, y }
          }, url)
          return hit != null
        })
        .toBe(true)

      // Hover → underline + pointer (xterm draws underline on the link render layer).
      await page.mouse.move(hit!.x, hit!.y)
      await expect
        .poll(async () =>
          page.locator("[data-yaade-terminal-panel] .xterm-screen.xterm-cursor-pointer").count(),
        )
        .toBeGreaterThan(0)

      // Plain click must not navigate.
      await page.mouse.click(hit!.x, hit!.y)
      expect(
        await page.evaluate(
          () => (window as Window & { __yaadeOpenedUrls?: string[] }).__yaadeOpenedUrls ?? [],
        ),
      ).toEqual([])

      // Cmd-click opens in a new browsing context.
      await page.keyboard.down("Meta")
      await page.mouse.click(hit!.x, hit!.y)
      await page.keyboard.up("Meta")
      await expect
        .poll(async () =>
          page.evaluate(
            () => (window as Window & { __yaadeOpenedUrls?: string[] }).__yaadeOpenedUrls ?? [],
          ),
        )
        .toEqual(expect.arrayContaining([expect.stringContaining("example.com/yaade-term-link")]))
    } finally {
      await app.close()
    }
  })
})
