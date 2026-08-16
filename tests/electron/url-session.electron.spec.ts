import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { expectSelectorVisible } from "../shell/assert.js"
import { execCommand, launchJet, waitForMux, waitForTerminalText } from "./_launch.js"

// URL sessions for the retired compatibility mux are no longer active.
test.describe.configure({ mode: "skip" })

function createUrlSessionHome(): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-url-session-"))
  fs.mkdirSync(path.join(homeDir, "dev", "consultation"), { recursive: true })
  return homeDir
}

test.describe("browser URL workspace sessions", () => {
  test("pathname under home opens that project with no mux tab strip", async () => {
    const fixtureHome = createUrlSessionHome()
    const { app, page, homeDir } = await launchJet({
      homeDir: fixtureHome,
      launchWithoutWorkspace: true,
      startPath: "/dev/consultation",
    })
    try {
      expect(homeDir).toBeTruthy()
      await waitForMux(page)
      await expectSelectorVisible(page, "[data-yaade-mux]")
      await expect
        .poll(async () => page.locator("[data-yaade-mux-tab]").count())
        .toBe(0)
      await expectSelectorVisible(page, "[data-yaade-terminal-panel]")

      await expect
        .poll(async () =>
          page.evaluate(() => ({
            pathname: location.pathname,
            title: document.title,
            workspaces: window.__yaadeAgent?.listWorkspaces() ?? [],
          })),
        )
        .toMatchObject({
          pathname: "/dev/consultation",
        })

      const state = await page.evaluate(() => ({
        title: document.title,
        workspaces: window.__yaadeAgent?.listWorkspaces() ?? [],
      }))
      expect(state.title).toContain("consultation")
      expect(
        state.workspaces.some(
          w =>
            typeof w.path === "string" &&
            (w.path.includes("consultation") ||
              w.path.endsWith("/dev/consultation")),
        ),
      ).toBe(true)
    } finally {
      await app.close()
      fs.rmSync(fixtureHome, { recursive: true, force: true })
    }
  })

  test("reload restores split panes for the same URL", async () => {
    const fixtureHome = createUrlSessionHome()
    const { app, page } = await launchJet({
      homeDir: fixtureHome,
      launchWithoutWorkspace: true,
      startPath: "/dev/consultation",
    })
    try {
      await waitForMux(page)
      // Capture the persistence write triggered by the split so we can reload
      // only once the server has stored the new layout.
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

      await page.evaluate(() => {
        window.dispatchEvent(new Event("pagehide"))
      })
      await layoutSaved
      await page.reload({ waitUntil: "domcontentloaded" })
      await waitForMux(page)

      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count(), {
          timeout: 15_000,
        })
        .toBeGreaterThanOrEqual(2)
      await expect
        .poll(async () =>
          page.evaluate(() => location.pathname),
        )
        .toBe("/dev/consultation")
    } finally {
      await app.close()
      fs.rmSync(fixtureHome, { recursive: true, force: true })
    }
  })

  test("cd in the terminal does not change location.pathname", async () => {
    const fixtureHome = createUrlSessionHome()
    const { app, page } = await launchJet({
      homeDir: fixtureHome,
      launchWithoutWorkspace: true,
      startPath: "/dev/consultation",
    })
    try {
      await waitForMux(page)
      await expectSelectorVisible(page, "[data-yaade-terminal-panel]")

      let ptyId: string | null = null
      await expect
        .poll(async () => {
          ptyId = await page.evaluate(() => {
            const panel = document.querySelector(
              "[data-yaade-terminal-panel][data-yaade-terminal-pty-id]",
            )
            return panel?.getAttribute("data-yaade-terminal-pty-id") ?? null
          })
          return ptyId
        }, { timeout: 15_000 })
        .toBeTruthy()

      await page.evaluate(async id => {
        const terminal = window.yaade?.terminal
        if (!terminal?.write) throw new Error("terminal.write unavailable")
        await terminal.write(id, "cd /\n")
      }, ptyId!)

      // Wait until the PTY has actually processed the cd (its echo shows up)
      // before asserting the URL was unaffected, instead of a blind sleep.
      await waitForTerminalText(page, "cd /")
      await expect
        .poll(async () => page.evaluate(() => location.pathname))
        .toBe("/dev/consultation")
    } finally {
      await app.close()
      fs.rmSync(fixtureHome, { recursive: true, force: true })
    }
  })

  test("empty saved session still opens with a default terminal", async () => {
    const fixtureHome = createUrlSessionHome()
    const { app, page, homeDir } = await launchJet({
      homeDir: fixtureHome,
      launchWithoutWorkspace: true,
      startPath: "/dev/consultation",
    })
    try {
      const project = path.join(homeDir!, "dev", "consultation")
      fs.mkdirSync(project, { recursive: true })
      await waitForMux(page)
      await expectSelectorVisible(page, "[data-yaade-terminal-panel]")

      await page.evaluate(async rootPath => {
        const system = await fetch("/api/v1/system").then(r => r.json())
        const machine =
          typeof system?.machineHostname === "string"
            ? system.machineHostname
            : "localhost"
        const res = await fetch("/api/v1/workspace-session", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: 1,
            machine,
            rootPath,
            layout: { tree: { root: null }, focusedPaneId: null, zoomedPaneId: null },
            sessions: [],
          }),
        })
        if (!res.ok) throw new Error(`PUT workspace-session failed (${res.status})`)
      }, project)

      await page.reload({ waitUntil: "domcontentloaded" })
      await waitForMux(page)
      await expectSelectorVisible(page, "[data-yaade-terminal-panel]")
    } finally {
      await app.close()
      fs.rmSync(fixtureHome, { recursive: true, force: true })
    }
  })
})
