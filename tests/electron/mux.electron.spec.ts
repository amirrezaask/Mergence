import { expect, test } from "@playwright/test"
import {
  expectLocatorVisible,
  expectSelectorVisible,
} from "../shell/assert.js"
import {
  execCommand,
  launchJet,
  pressMod,
  pressMuxPrefix,
  waitForMux,
  waitForTerminalText,
} from "./_launch.js"

test.describe("mux shell", () => {
  test("boots the Terminals surface with an instance sidebar", async () => {
    const { app, page } = await launchJet({ withTerminal: false })
    try {
      await waitForMux(page)
      await expectSelectorVisible(page, "[data-yaade-mux]")
      await expect
        .poll(async () => page.locator("[data-yaade-mux-tab-strip]").count())
        .toBe(0)
      await expect
        .poll(async () => page.locator("[data-yaade-mux-tab]").count())
        .toBe(0)
      await expectSelectorVisible(
        page,
        '[data-yaade-mux] [data-yaade-instance-sidebar="running"]',
      )
      await expectSelectorVisible(
        page,
        '[data-yaade-list-panel="project-running"]',
      )
      await page
        .locator(
          '[data-yaade-mux] [data-yaade-instance-sidebar="running"] [data-yaade-instance-sidebar-new]',
        )
        .click()
      await expect
        .poll(async () => page.locator("[data-yaade-terminal-panel]").count())
        .toBe(1)
      await expect
        .poll(async () =>
          page
            .locator(
              '[data-yaade-list-panel="project-running"] [data-yaade-list-item]',
            )
            .count(),
        )
        .toBeGreaterThanOrEqual(1)
    } finally {
      await app.close()
    }
  })

  test("Terminals surface renders only shell panes", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)

      const surface = page.locator(
        '[data-yaade-project-surface="running"]',
      )
      await expectSelectorVisible(
        page,
        '[data-yaade-project-surface="running"]',
      )
      await expectSelectorVisible(
        page,
        '[data-yaade-mux] [data-yaade-instance-sidebar="running"]',
      )
      await expect
        .poll(async () => surface.locator('[data-yaade-mux-pane-kind="terminal"]').count())
        .toBe(1)
      await expect
        .poll(async () => surface.locator('[data-yaade-mux-pane-kind="git"]').count())
        .toBe(0)
      await expect
        .poll(async () => surface.locator('[data-yaade-mux-pane-kind="editor"]').count())
        .toBe(0)
      await expect
        .poll(async () => surface.locator("[data-yaade-git-root]").count())
        .toBe(0)
      await expect
        .poll(async () => surface.locator("[data-yaade-monaco-editor]").count())
        .toBe(0)
    } finally {
      await app.close()
    }
  })

  test("context menu opens on the focused terminal", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)

      await page.locator("[data-yaade-terminal-panel]").first().click({
        button: "right",
      })
      await expectSelectorVisible(page, "[data-yaade-mux-terminal-context-menu]")
      await page.keyboard.press("Escape")
    } finally {
      await app.close()
    }
  })

  test("caps a workspace at six live terminal panes", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      const sidebarItems = page.locator(
        '[data-yaade-list-panel="project-running"] [data-yaade-list-item]',
      )
      for (let expected = 2; expected <= 6; expected += 1) {
        await execCommand(page, "terminal.new")
        await expect.poll(async () => sidebarItems.count(), { timeout: 15_000 }).toBe(expected)
      }

      await execCommand(page, "terminal.new")
      await expect.poll(async () => sidebarItems.count()).toBe(6)
      await expectLocatorVisible(
        page.getByText("Terminal pane limit reached (6). Close a terminal or use another session."),
      )
    } finally {
      await app.close()
    }
  })
})

test.describe("mux keyboard", () => {
  // Regression: a global Escape binding (mux unzoom) used to preventDefault +
  // stopPropagation on a window capture listener, so Escape never reached the
  // PTY and every TUI — vim, less, fzf — was unusable inside a pane.
  test("Escape reaches the terminal", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await page.locator("[data-yaade-terminal-panel]").first().click()

      // readline: type a word, then Escape-b (move back one word) and insert a
      // marker. The marker only lands mid-word if Escape got through.
      await page.keyboard.type("echo yaadeESC")
      await page.keyboard.press("Escape")
      await page.keyboard.press("KeyB")
      await page.keyboard.type("XX")
      await page.keyboard.press("Enter")

      await waitForTerminalText(page, "XXyaadeESC")
    } finally {
      await app.close()
    }
  })

  test("prefix shows the which-key panel and splits the pane", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await page.locator("[data-yaade-terminal-panel]").first().click()
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBe(1)

      await page.keyboard.press("Control+KeyA")
      const whichKey = page.getByText("waiting for key")
      await expectLocatorVisible(whichKey)

      await page.keyboard.press("KeyD")
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count(), {
          timeout: 15_000,
        })
        .toBeGreaterThanOrEqual(2)
      await expect
        .poll(async () => page.getByText("waiting for key").count())
        .toBe(0)
    } finally {
      await app.close()
    }
  })

  test("the prefix key itself never leaks to the shell", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await page.locator("[data-yaade-terminal-panel]").first().click()

      // Ctrl-a is readline beginning-of-line. If the prefix leaked through, the
      // suffix would land before `echo` and the command would not run.
      await page.keyboard.type("echo yaade-prefix")
      await page.keyboard.press("Control+KeyA")
      // The which-key hint appears while the prefix is pending; poll for it to
      // disappear (the chord lapsing) instead of sleeping a fixed interval.
      await expect
        .poll(async () => page.getByText("waiting for key").count())
        .toBeGreaterThan(0)
      await expect
        .poll(async () => page.getByText("waiting for key").count(), {
          timeout: 15_000,
        })
        .toBe(0)
      await page.keyboard.type("-tail")
      await page.keyboard.press("Enter")

      await waitForTerminalText(page, "yaade-prefix-tail")
    } finally {
      await app.close()
    }
  })

  test("double-tapping the prefix sends it to the shell", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await page.locator("[data-yaade-terminal-panel]").first().click()

      await page.keyboard.type("yaade-tail echo")
      // Ctrl-a Ctrl-a → literal ^A → readline jumps to the start of the line.
      await page.keyboard.press("Control+KeyA")
      await expect
        .poll(async () => page.getByText("waiting for key").count())
        .toBeGreaterThan(0)
      await page.keyboard.press("Control+KeyA")
      // The second prefix clears the chord synchronously, while the footer
      // leaves on React's next commit. Wait for that commit before typing so
      // CDP cannot race the next `e` into the still-visible prefix namespace.
      await expect
        .poll(async () => page.getByText("waiting for key").count())
        .toBe(0)
      await page.keyboard.type("echo yaade-head ")
      await page.keyboard.press("Enter")

      await waitForTerminalText(page, "yaade-head")
    } finally {
      await app.close()
    }
  })
})

test.describe("mux tiling", () => {
  test("split right creates a second pane", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBe(1)
      await page.locator("[data-yaade-mux-split=right]").first().click()
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count(), {
          timeout: 15_000,
        })
        .toBeGreaterThanOrEqual(2)
      await expect
        .poll(async () => page.locator("[data-yaade-terminal-panel]").count())
        .toBeGreaterThanOrEqual(2)
    } finally {
      await app.close()
    }
  })

  test("focus neighbor moves between split panes", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await page.locator("[data-yaade-mux-split=right]").first().click()
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBeGreaterThanOrEqual(2)

      const focusedBefore = await page
        .locator("[data-yaade-mux-pane][data-focused]")
        .getAttribute("data-yaade-mux-pane")
      expect(focusedBefore).toBeTruthy()

      await execCommand(page, "mux.focusLeft")
      await expect
        .poll(async () => {
          const focused = await page
            .locator("[data-yaade-mux-pane][data-focused]")
            .getAttribute("data-yaade-mux-pane")
          return focused && focused !== focusedBefore ? focused : null
        })
        .toBeTruthy()
    } finally {
      await app.close()
    }
  })

  test("git button opens Git workspace in a new split", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBe(1)
      await expectSelectorVisible(page, "[data-yaade-mux-open-git]")
      await page.locator("[data-yaade-mux-open-git]").first().click()
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count(), {
          timeout: 15_000,
        })
        .toBeGreaterThanOrEqual(2)
      await expectSelectorVisible(page, "[data-yaade-mux-pane-kind=git]")
      await expectSelectorVisible(
        page,
        "[data-yaade-mux-pane-kind=git] [data-yaade-git-workspace]",
      )
      // Terminal pane remains; git is an additional split.
      await expectSelectorVisible(page, "[data-yaade-terminal-panel]")
    } finally {
      await app.close()
    }
  })

  test("prefix n opens neovim; prefix g opens git", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await page.locator("[data-yaade-terminal-panel]").first().click()
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBe(1)

      await pressMuxPrefix(page, "KeyN")
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count(), {
          timeout: 15_000,
        })
        .toBeGreaterThanOrEqual(2)
      await expect
        .poll(async () =>
          page.locator('[data-yaade-mux-pane-title][aria-label="Neovim"]').count(),
        )
        .toBeGreaterThanOrEqual(1)

      await pressMuxPrefix(page, "KeyG")
      await expectSelectorVisible(page, "[data-yaade-mux-pane-kind=git]", {
        timeout: 15_000,
      })
      await expectSelectorVisible(
        page,
        "[data-yaade-mux-pane-kind=git] [data-yaade-git-workspace]",
      )
      await expectSelectorVisible(page, "[data-yaade-terminal-panel]")
    } finally {
      await app.close()
    }
  })

  test("prefix d shell split inherits the source pane cwd", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await expectSelectorVisible(page, "[data-yaade-terminal-panel]")

      const shellPaneId = await page
        .locator("[data-yaade-mux-pane-kind=terminal]")
        .first()
        .getAttribute("data-yaade-mux-pane")
      expect(shellPaneId).toBeTruthy()

      let shellPtyId: string | null = null
      await expect
        .poll(
          async () => {
            shellPtyId = await page.evaluate(paneId => {
              const host = document.querySelector(
                `[data-yaade-mux-terminal-host="${paneId}"] [data-yaade-terminal-panel]`,
              )
              const id = host?.getAttribute("data-yaade-terminal-pty-id") || ""
              return id.length > 0 ? id : null
            }, shellPaneId!)
            return shellPtyId
          },
          { timeout: 15_000 },
        )
        .toBeTruthy()

      const nestedName = `cwd-modd-${Date.now().toString(36)}`
      await page.evaluate(
        async ({ id, dir }) => {
          const terminal = (
            window as Window & {
              yaade?: {
                terminal?: {
                  write: (ptyId: string, data: string) => Promise<unknown>
                  getCwd: (ptyId: string) => Promise<string | null>
                }
              }
            }
          ).yaade?.terminal
          if (!terminal?.write || !terminal.getCwd) {
            throw new Error("terminal write/getCwd unavailable")
          }
          await terminal.write(id, `mkdir -p ${dir} && cd ${dir}\n`)
          const deadline = Date.now() + 10_000
          while (Date.now() < deadline) {
            const live = await terminal.getCwd(id)
            if (live && (live.includes(`/${dir}`) || live.includes(`%2F${dir}`))) {
              return
            }
            await new Promise(r => setTimeout(r, 50))
          }
          throw new Error(`shell did not cd into ${dir}`)
        },
        { id: shellPtyId!, dir: nestedName },
      )

      await page
        .locator(`[data-yaade-mux-pane="${shellPaneId}"] [data-yaade-mux-pane-drag]`)
        .click()
      await execCommand(page, "mux.splitRight")
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane-kind=terminal]").count())
        .toBeGreaterThanOrEqual(2)

      await expect
        .poll(
          async () => {
            const panes = page.locator("[data-yaade-mux-pane-kind=terminal]")
            const count = await panes.count()
            for (let i = 0; i < count; i++) {
              const paneId = await panes.nth(i).getAttribute("data-yaade-mux-pane")
              if (!paneId || paneId === shellPaneId) continue
              const cwdLeaf = await page.evaluate(async id => {
                const host = document.querySelector(
                  `[data-yaade-mux-terminal-host="${id}"] [data-yaade-terminal-panel]`,
                )
                const ptyId = host?.getAttribute("data-yaade-terminal-pty-id") || ""
                if (!ptyId) return null
                const terminal = (
                  window as Window & {
                    yaade?: {
                      terminal?: { getCwd: (ptyId: string) => Promise<string | null> }
                    }
                  }
                ).yaade?.terminal
                const cwd = await terminal?.getCwd?.(ptyId)
                if (!cwd) return null
                const path = decodeURIComponent(cwd.replace(/^file:\/\//, ""))
                return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? null
              }, paneId)
              if (cwdLeaf === nestedName) return cwdLeaf
            }
            return null
          },
          { timeout: 15_000 },
        )
        .toBe(nestedName)
    } finally {
      await app.close()
    }
  })

  test("git and neovim splits use the shell process cwd", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await expectSelectorVisible(page, "[data-yaade-terminal-panel]")

      const shellPaneId = await page
        .locator("[data-yaade-mux-pane-kind=terminal]")
        .first()
        .getAttribute("data-yaade-mux-pane")
      expect(shellPaneId).toBeTruthy()

      let shellPtyId: string | null = null
      await expect
        .poll(
          async () => {
            shellPtyId = await page.evaluate(paneId => {
              const host = document.querySelector(
                `[data-yaade-mux-terminal-host="${paneId}"] [data-yaade-terminal-panel]`,
              )
              const id = host?.getAttribute("data-yaade-terminal-pty-id") || ""
              return id.length > 0 ? id : null
            }, shellPaneId!)
            return shellPtyId
          },
          { timeout: 15_000 },
        )
        .toBeTruthy()

      const nestedName = `cwd-split-${Date.now().toString(36)}`
      await page.evaluate(
        async ({ id, dir }) => {
          const terminal = (
            window as Window & {
              yaade?: {
                terminal?: {
                  write: (ptyId: string, data: string) => Promise<unknown>
                  getCwd: (ptyId: string) => Promise<string | null>
                }
              }
            }
          ).yaade?.terminal
          if (!terminal?.write || !terminal.getCwd) {
            throw new Error("terminal write/getCwd unavailable")
          }
          if (!(await terminal.getCwd(id))) throw new Error("missing spawn cwd")
          await terminal.write(id, `mkdir -p ${dir} && cd ${dir}\n`)
          const deadline = Date.now() + 10_000
          while (Date.now() < deadline) {
            const live = await terminal.getCwd(id)
            if (live && (live.includes(`/${dir}`) || live.includes(`%2F${dir}`))) {
              return
            }
            await new Promise(r => setTimeout(r, 50))
          }
          throw new Error(`shell did not cd into ${dir}`)
        },
        { id: shellPtyId!, dir: nestedName },
      )

      await page.locator("[data-yaade-mux-open-git]").first().click()
      await expectSelectorVisible(page, "[data-yaade-mux-pane-kind=git]")
      await expect
        .poll(async () => {
          const root = await page
            .locator("[data-yaade-mux-pane-kind=git] [data-yaade-git-root]")
            .getAttribute("data-yaade-git-root")
          return root?.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? null
        }, { timeout: 10_000 })
        .toBe(nestedName)

      await page.locator("[data-yaade-mux-pane-kind=git] [data-yaade-mux-close-pane]").click()
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane-kind=git]").count())
        .toBe(0)

      await page
        .locator(`[data-yaade-mux-pane="${shellPaneId}"] [data-yaade-mux-pane-drag]`)
        .click()
      await page.locator("[data-yaade-mux-open-nvim]").first().click()
      await expect
        .poll(async () =>
          page.locator('[data-yaade-mux-pane-title][aria-label="Neovim"]').count(),
        )
        .toBeGreaterThanOrEqual(1)

      const nvimPaneId = await page
        .locator('[data-yaade-mux-pane-title][aria-label="Neovim"]')
        .first()
        .evaluate(el => el.closest("[data-yaade-mux-pane]")?.getAttribute("data-yaade-mux-pane") ?? null)
      expect(nvimPaneId).toBeTruthy()

      await expect
        .poll(async () => {
          const nvimPty = await page.evaluate(paneId => {
            const host = document.querySelector(
              `[data-yaade-mux-terminal-host="${paneId}"] [data-yaade-terminal-panel]`,
            )
            const id = host?.getAttribute("data-yaade-terminal-pty-id") || ""
            return id.length > 0 ? id : null
          }, nvimPaneId!)
          if (!nvimPty) return null
          return page.evaluate(async id => {
            const terminal = (
              window as Window & {
                yaade?: {
                  terminal?: { getCwd: (ptyId: string) => Promise<string | null> }
                }
              }
            ).yaade?.terminal
            const cwd = await terminal?.getCwd?.(id)
            if (!cwd) return null
            const path = decodeURIComponent(cwd.replace(/^file:\/\//, ""))
            return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? null
          }, nvimPty)
        }, { timeout: 15_000 })
        .toBe(nestedName)
    } finally {
      await app.close()
    }
  })

  test("neovim button opens nvim in a new terminal split", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBe(1)
      await expectSelectorVisible(page, "[data-yaade-mux-open-nvim]")
      await page.locator("[data-yaade-mux-open-nvim]").first().click()
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count(), {
          timeout: 15_000,
        })
        .toBeGreaterThanOrEqual(2)
      await expect
        .poll(async () =>
          page.locator('[data-yaade-mux-pane-title][aria-label="Neovim"]').count(),
        )
        .toBeGreaterThanOrEqual(1)
      await expect
        .poll(async () => page.locator("[data-yaade-terminal-panel]").count())
        .toBeGreaterThanOrEqual(2)
    } finally {
      await app.close()
    }
  })

  test("quitting neovim closes its pane", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await page.locator("[data-yaade-mux-open-nvim]").first().click()
      await expect
        .poll(async () =>
          page.locator('[data-yaade-mux-pane-title][aria-label="Neovim"]').count(),
        )
        .toBeGreaterThanOrEqual(1)

      const nvimPaneId = await page
        .locator('[data-yaade-mux-pane-title][aria-label="Neovim"]')
        .first()
        .evaluate(el => el.closest("[data-yaade-mux-pane]")?.getAttribute("data-yaade-mux-pane"))
      expect(nvimPaneId).toBeTruthy()

      let ptyId: string | null = null
      await expect
        .poll(async () => {
          ptyId = await page.evaluate(paneId => {
            const host = document.querySelector(
              `[data-yaade-mux-terminal-host="${paneId}"] [data-yaade-terminal-panel]`,
            )
            const id = host?.getAttribute("data-yaade-terminal-pty-id") || ""
            return id.length > 0 ? id : null
          }, nvimPaneId!)
          return ptyId
        }, { timeout: 15_000 })
        .toBeTruthy()

      // Force-quit neovim (:qa!) so the PTY exits and the pane auto-closes.
      await page.evaluate(async id => {
        const api = (
          window as Window & {
            yaade?: { terminal?: { write: (ptyId: string, data: string) => Promise<unknown> } }
          }
        ).yaade?.terminal
        if (!api?.write) throw new Error("terminal.write unavailable")
        await api.write(id, "\x1b:qa!\r")
      }, ptyId!)

      await expect
        .poll(
          async () =>
            page.locator('[data-yaade-mux-pane-title][aria-label="Neovim"]').count(),
          { timeout: 15_000 },
        )
        .toBe(0)
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBe(1)
      await expect
        .poll(async () => page.locator("[data-yaade-confirm=accept]").count())
        .toBe(0)
    } finally {
      await app.close()
    }
  })

  test("closing the last pane keeps the Terminals surface ready", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBe(1)

      await page.locator("[data-yaade-terminal-panel]").first().click()
      await page.keyboard.type("echo yaade-last-pane")
      const tabId = await page
        .locator(
          '[data-yaade-list-panel="project-running"] [data-yaade-instance-sidebar-item]',
        )
        .first()
        .getAttribute("data-yaade-instance-sidebar-item")
      expect(tabId).toBeTruthy()
      await page.locator(`[data-yaade-instance-sidebar-close="${tabId}"]`).click()
      await page.getByRole("button", { name: "Close Pane" }).click()

      // Empty terminals surface keeps New available.
      await expectSelectorVisible(
        page,
        '[data-yaade-mux] [data-yaade-instance-sidebar="running"] [data-yaade-instance-sidebar-new]',
      )
      await expect
        .poll(async () =>
          page
            .locator(
              '[data-yaade-list-panel="project-running"] [data-yaade-list-item]',
            )
            .count(),
        )
        .toBe(0)
      await page
        .locator('[data-yaade-project-surface="running"]')
        .getByRole("button", { name: "New terminal" })
        .click()
      await expectSelectorVisible(page, "[data-yaade-terminal-panel]")
    } finally {
      await app.close()
    }
  })

  test("split down creates a stacked pane", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await execCommand(page, "mux.splitDown")
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count(), {
          timeout: 15_000,
        })
        .toBeGreaterThanOrEqual(2)
    } finally {
      await app.close()
    }
  })
})

test.describe("mux zoom", () => {
  test("zoom fills the window and restore returns the split", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await execCommand(page, "mux.splitRight")
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBeGreaterThanOrEqual(2)

      await page.locator("[data-yaade-mux-zoom]").first().click()
      await expectSelectorVisible(page, "[data-yaade-mux-window][data-zoomed]")
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBe(1)

      await page.locator("[data-yaade-mux-zoom]").first().click()
      await expect
        .poll(async () => page.locator("[data-yaade-mux-window][data-zoomed]").count())
        .toBe(0)
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBeGreaterThanOrEqual(2)
    } finally {
      await app.close()
    }
  })

  test("prefix z toggles pane zoom", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await execCommand(page, "mux.splitRight")
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBeGreaterThanOrEqual(2)

      await page.locator("[data-yaade-terminal-panel]").first().click()
      await pressMuxPrefix(page, "KeyZ")
      await expectSelectorVisible(page, "[data-yaade-mux-window][data-zoomed]")
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBe(1)

      await pressMuxPrefix(page, "KeyZ")
      await expect
        .poll(async () => page.locator("[data-yaade-mux-window][data-zoomed]").count())
        .toBe(0)
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBeGreaterThanOrEqual(2)
    } finally {
      await app.close()
    }
  })
})

test.describe("mux switcher", () => {
  test("command palette opens via Mod-Shift-p with selectable commands", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)

      // Click the terminal host (pane chrome center is covered by the terminal layer).
      await page.locator("[data-yaade-terminal-panel]").first().click()
      await page.keyboard.press("Meta+Shift+KeyP")
      await expect
        .poll(async () => page.locator("[data-yaade-palette]").count(), {
          timeout: 10_000,
        })
        .toBeGreaterThan(0)
      await expectSelectorVisible(page, "[data-yaade-palette]")
      await expect
        .poll(
          async () =>
            page.locator('[data-yaade-list-panel="yaade:palette"] [data-yaade-list-item]').count(),
        )
        .toBeGreaterThan(0)

      await page.keyboard.type("Split Right")
      await page.keyboard.press("Enter")
      await expect
        .poll(async () => page.locator("[data-yaade-palette]").count())
        .toBe(0)
    } finally {
      await app.close()
    }
  })

  test("prefix w opens terminal switcher and Enter selects", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await page.locator("[data-yaade-terminal-panel]").first().click()
      await pressMuxPrefix(page, "KeyW")
      await expect
        .poll(async () => page.locator("[data-yaade-palette]").count(), {
          timeout: 10_000,
        })
        .toBeGreaterThan(0)
      await expectSelectorVisible(page, "[data-yaade-palette]")
      await expect
        .poll(
          async () =>
            page.locator("[data-yaade-palette] [data-slot=row-label]").count(),
        )
        .toBeGreaterThan(0)
      await page.keyboard.press("Enter")
      await expect
        .poll(async () => page.locator("[data-yaade-palette]").count())
        .toBe(0)
    } finally {
      await app.close()
    }
  })

  test("terminal.list lists panes and selecting focuses the pane", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await execCommand(page, "mux.splitRight")
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBeGreaterThanOrEqual(2)

      const hasCommand = await page.evaluate(() =>
        Boolean(
          (
            window as Window & {
              __yaadeAgent?: { executeCommand: (id: string) => Promise<void> }
            }
          ).__yaadeAgent,
        ),
      )
      expect(hasCommand).toBe(true)

      await execCommand(page, "terminal.list")
      await expect
        .poll(async () => page.locator("[data-yaade-palette]").count(), {
          timeout: 10_000,
        })
        .toBeGreaterThan(0)

      const row = page.locator("[data-yaade-palette] [data-slot=row-label]").first()
      await expectLocatorVisible(row)
      const label = (await row.textContent()) ?? ""
      expect(label.length).toBeGreaterThan(0)
      expect(label.toLowerCase()).not.toBe("switch terminal…")

      await row.click()
      await expect
        .poll(async () => page.locator("[data-yaade-palette]").count(), {
          timeout: 10_000,
        })
        .toBe(0)
      await expectSelectorVisible(page, "[data-yaade-mux-window]")
      await expectSelectorVisible(page, "[data-yaade-terminal-panel]")
    } finally {
      await app.close()
    }
  })
})

async function pointerDrag(
  page: import("@playwright/test").Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  // Activate PointerSensor (distance: 6) and let TabDndRoot snapshot overlays.
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 4 })
  await page.waitForTimeout(50)
  await page.mouse.move(to.x, to.y, { steps: 20 })
  await page.waitForTimeout(30)
  await page.mouse.up()
}

test.describe("mux drag dock", () => {
  test("pane chrome exposes drag handles", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await execCommand(page, "mux.splitRight")
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBeGreaterThanOrEqual(2)
      await expectSelectorVisible(page, "[data-yaade-mux-pane-drag]")
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane-drag]").count())
        .toBeGreaterThanOrEqual(2)
    } finally {
      await app.close()
    }
  })

  test("dragging a pane onto another pane edge retile", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await execCommand(page, "mux.splitRight")
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBeGreaterThanOrEqual(2)

      const panes = page.locator("[data-yaade-mux-pane]")
      const leftId = await panes.nth(0).getAttribute("data-yaade-mux-pane")
      const rightId = await panes.nth(1).getAttribute("data-yaade-mux-pane")
      expect(leftId).toBeTruthy()
      expect(rightId).toBeTruthy()
      expect(leftId).not.toBe(rightId)

      const leftPtyBefore = await page.evaluate(id => {
        const host = document.querySelector(
          `[data-yaade-mux-terminal-host="${id}"] [data-yaade-terminal-panel]`,
        )
        return host?.getAttribute("data-yaade-terminal-pty-id") ?? null
      }, leftId!)

      const source = page.locator(
        `[data-yaade-mux-pane="${leftId}"] [data-yaade-mux-pane-drag]`,
      )
      const target = panes.nth(1)
      const srcBox = await source.boundingBox()
      const tgtBox = await target.boundingBox()
      expect(srcBox).toBeTruthy()
      expect(tgtBox).toBeTruthy()

      await pointerDrag(
        page,
        {
          x: srcBox!.x + srcBox!.width / 2,
          y: srcBox!.y + srcBox!.height / 2,
        },
        {
          // Bottom edge zone of the right pane → stacked retile
          x: tgtBox!.x + tgtBox!.width / 2,
          y: tgtBox!.y + tgtBox!.height * 0.9,
        },
      )

      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBe(2)
      await expectSelectorVisible(
        page,
        `[data-yaade-mux-pane="${leftId}"]`,
      )
      await expectSelectorVisible(
        page,
        `[data-yaade-mux-pane="${rightId}"]`,
      )

      // Persistent terminal hosts — same PTY after retile (no shell reset).
      if (leftPtyBefore) {
        await expect
          .poll(async () =>
            page.evaluate(id => {
              const host = document.querySelector(
                `[data-yaade-mux-terminal-host="${id}"] [data-yaade-terminal-panel]`,
              )
              return host?.getAttribute("data-yaade-terminal-pty-id") ?? null
            }, leftId!),
          )
          .toBe(leftPtyBefore)
      }
      await expectSelectorVisible(
        page,
        `[data-yaade-mux-terminal-host="${leftId}"]`,
      )
    } finally {
      await app.close()
    }
  })

  test("dragging a git pane onto a terminal pane edge retile", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await expectSelectorVisible(page, "[data-yaade-mux-open-git]")
      await page.locator("[data-yaade-mux-open-git]").first().click()
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count(), {
          timeout: 15_000,
        })
        .toBeGreaterThanOrEqual(2)
      await expectSelectorVisible(page, "[data-yaade-mux-pane-kind=git]")

      const gitPane = page.locator("[data-yaade-mux-pane-kind=git]")
      const gitId = await gitPane.getAttribute("data-yaade-mux-pane")
      expect(gitId).toBeTruthy()

      const termPane = page.locator(
        "[data-yaade-mux-pane-kind=terminal]",
      ).first()
      const termId = await termPane.getAttribute("data-yaade-mux-pane")
      expect(termId).toBeTruthy()
      expect(termId).not.toBe(gitId)

      const source = page.locator(
        `[data-yaade-mux-pane="${gitId}"] [data-yaade-mux-pane-drag]`,
      )
      const srcBox = await source.boundingBox()
      const tgtBox = await termPane.boundingBox()
      expect(srcBox).toBeTruthy()
      expect(tgtBox).toBeTruthy()

      await pointerDrag(
        page,
        {
          x: srcBox!.x + srcBox!.width / 2,
          y: srcBox!.y + srcBox!.height / 2,
        },
        {
          // Bottom edge of the terminal pane → stack git under it
          x: tgtBox!.x + tgtBox!.width / 2,
          y: tgtBox!.y + tgtBox!.height * 0.9,
        },
      )

      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBe(2)
      await expectSelectorVisible(
        page,
        `[data-yaade-mux-pane="${gitId}"][data-yaade-mux-pane-kind=git]`,
      )
      await expectSelectorVisible(
        page,
        `[data-yaade-mux-pane="${termId}"][data-yaade-mux-pane-kind=terminal]`,
      )
      await expectSelectorVisible(
        page,
        "[data-yaade-mux-pane-kind=git] [data-yaade-git-workspace]",
      )
    } finally {
      await app.close()
    }
  })
})

test.describe("mux persistence", () => {
  test("reload restores tiled layout from the server", async () => {
    const { app, page } = await launchJet()
    try {
      await waitForMux(page)
      await expectSelectorVisible(page, "[data-yaade-terminal-panel]")
      // Wait for the layout write to actually reach the server rather than
      // sleeping a fixed interval for the debounced writer.
      const layoutSaved = page
        .waitForResponse(
          r =>
            r.url().includes("/api/v1/workspace-session") &&
            r.request().method() === "PUT",
          { timeout: 15_000 },
        )
        .catch(() => null)
      await execCommand(page, "mux.splitRight")
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count(), {
          timeout: 15_000,
        })
        .toBeGreaterThanOrEqual(2)

      await layoutSaved
      await page.reload({ waitUntil: "domcontentloaded" })
      await waitForMux(page)

      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count(), {
          timeout: 15_000,
        })
        .toBeGreaterThanOrEqual(2)
      await expect
        .poll(async () => page.locator("[data-yaade-mux-tab]").count())
        .toBe(0)
    } finally {
      await app.close()
    }
  })
})
