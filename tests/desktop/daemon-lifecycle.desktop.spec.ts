import { expect, test } from "@playwright/test"
import path from "node:path"
import { isProcessAlive } from "../../packages/yaade-node-host/src/process-identity.js"
import { attachTerminal, waitForAttach } from "../runtime/harness/index.js"
import { waitUntil } from "../runtime/harness/wait.js"
import {
  attachBrowserToOrigin,
  closeDesktop,
  desktopDisplayAvailable,
  launchDesktop,
  launchMockAgentOnHost,
  openToolInWindow,
  runtimeManifest,
  stopOwnedRuntime,
  waitForSecondInstanceExit,
} from "./_launch.js"

test.describe("D — Electron and daemon lifecycle", { tag: "@p0" }, () => {
  test.skip(!desktopDisplayAvailable(), "Electron desktop E2E needs a display")

  test("D01 closing and reopening the real Electron window preserves the local agent", async ({}, testInfo) => {
    const first = await launchDesktop()
    const controlFile = path.join(first.workspace, "d01-control.json")
    try {
      const launched = await launchMockAgentOnHost(first.origin, first.workspace, controlFile, "D01")
      await openToolInWindow(first.window, first.origin, launched.sessionId, launched.toolUseId, launched.tabId)
      await expect(first.window.locator("[data-yaade-terminal-panel]")).toBeVisible({ timeout: 30_000 })
      const daemonPid = first.daemonPid
      expect(isProcessAlive(launched.agent.pid)).toBe(true)
      await closeDesktop(first, { keepDaemon: true })
      expect(isProcessAlive(daemonPid)).toBe(true)
      expect(isProcessAlive(launched.agent.pid)).toBe(true)
      const second = await launchDesktop({
        userDataDir: first.userDataDir,
        workspace: first.workspace,
      })
      try {
        expect(second.daemonPid).toBe(daemonPid)
        await openToolInWindow(second.window, second.origin, launched.sessionId, launched.toolUseId, launched.tabId)
        await expect(second.window.locator("[data-yaade-terminal-panel]")).toBeVisible({ timeout: 30_000 })
        const attached = await waitForAttach(second.origin, launched.ptyId)
        expect(attached.status).toBe("running")
        expect(attached.id).toBe(launched.ptyId)
      } finally {
        await closeDesktop(second)
      }
    } catch (error) {
      await closeDesktop(first, { keepDaemon: true }).catch(() => undefined)
      await stopOwnedRuntime(first.userDataDir)
      throw error
    }
  })

  test("D02 Electron renderer crash does not stop the daemon or agent", async ({}, testInfo) => {
    const desktop = await launchDesktop()
    const controlFile = path.join(desktop.workspace, "d02-control.json")
    try {
      const launched = await launchMockAgentOnHost(desktop.origin, desktop.workspace, controlFile, "D02")
      const daemonPid = desktop.daemonPid
      const recovered = desktop.app.waitForEvent("window")
      await desktop.app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (!window) throw new Error("no desktop window to crash")
        window.webContents.forcefullyCrashRenderer()
      })
      const nextWindow = await recovered
      await nextWindow.waitForLoadState("domcontentloaded")
      await nextWindow.waitForFunction(() => window.__yaadeAgent != null, null, { timeout: 30_000 })
      expect(isProcessAlive(daemonPid)).toBe(true)
      expect(isProcessAlive(launched.agent.pid)).toBe(true)
      await openToolInWindow(nextWindow, desktop.origin, launched.sessionId, launched.toolUseId, launched.tabId)
      await expect(nextWindow.locator("[data-yaade-terminal-panel]")).toBeVisible({ timeout: 30_000 })
      const attached = await waitForAttach(desktop.origin, launched.ptyId)
      expect(attached.status).toBe("running")
    } finally {
      await closeDesktop(desktop)
    }
  })

  test("D03 explicit Electron application quit still detaches from the daemon", async ({}, testInfo) => {
    const desktop = await launchDesktop()
    const controlFile = path.join(desktop.workspace, "d03-control.json")
    try {
      const launched = await launchMockAgentOnHost(desktop.origin, desktop.workspace, controlFile, "D03")
      const origin = desktop.origin
      const daemonPid = desktop.daemonPid
      await desktop.app.close()
      expect(isProcessAlive(daemonPid)).toBe(true)
      expect(isProcessAlive(launched.agent.pid)).toBe(true)
      const startPath = `/?s=${encodeURIComponent(launched.sessionId)}&u=${encodeURIComponent(launched.toolUseId)}`
      const browser = await attachBrowserToOrigin(origin, startPath)
      try {
        const attached = await waitForAttach(origin, launched.ptyId)
        expect(attached.status).toBe("running")
      } finally {
        await browser.close()
      }
    } finally {
      await stopOwnedRuntime(desktop.userDataDir)
    }
  })

  test("D04 explicit Stop daemon is separately confirmed and destructive", async ({}, testInfo) => {
    const desktop = await launchDesktop()
    const controlFile = path.join(desktop.workspace, "d04-control.json")
    try {
      const launched = await launchMockAgentOnHost(desktop.origin, desktop.workspace, controlFile, "D04")
      await openToolInWindow(desktop.window, desktop.origin, launched.sessionId, launched.toolUseId, launched.tabId)
      await expect(desktop.window.locator("[data-yaade-stop-daemon]")).toBeVisible({ timeout: 30_000 })
      await desktop.window.locator("[data-yaade-stop-daemon]").click()
      const confirm = desktop.window.locator("[data-yaade-stop-daemon-confirm]")
      await expect(confirm).toBeVisible()
      await expect(confirm).toContainText(/terminate \d+ running terminals?/)
      await desktop.window.locator('[data-yaade-confirm="cancel"]').click()
      await expect(confirm).toHaveCount(0)
      expect(isProcessAlive(launched.agent.pid)).toBe(true)
      expect(isProcessAlive(desktop.daemonPid)).toBe(true)
      await desktop.window.locator("[data-yaade-stop-daemon]").click()
      await expect(confirm).toBeVisible()
      await desktop.window.locator('[data-yaade-confirm="accept"]').click()
      await waitUntil(() => !isProcessAlive(launched.agent.pid), 10_000, "PTY exit after stop daemon")
      await waitUntil(() => !isProcessAlive(desktop.daemonPid), 10_000, "daemon exit after stop")
      await expect(desktop.window.locator('[data-yaade-connection="offline"]')).toBeVisible({
        timeout: 30_000,
      })
      await expect(desktop.window.getByText("Host offline")).toBeVisible()
    } finally {
      await closeDesktop(desktop)
    }
  })

  test("D05 a second Electron instance reuses the existing daemon", async ({}, testInfo) => {
    const first = await launchDesktop()
    const controlFile = path.join(first.workspace, "d05-control.json")
    try {
      const launched = await launchMockAgentOnHost(first.origin, first.workspace, controlFile, "D05")
      const serverId = runtimeManifest(first.userDataDir)?.serverId
      const secondCode = await waitForSecondInstanceExit(first.userDataDir, first.workspace)
      expect(secondCode).toBe(0)
      expect(first.app.windows().length).toBeGreaterThanOrEqual(1)
      expect(isProcessAlive(first.daemonPid)).toBe(true)
      expect(isProcessAlive(launched.agent.pid)).toBe(true)
      expect(runtimeManifest(first.userDataDir)?.serverId).toBe(serverId)
      const attached = await attachTerminal(first.origin, launched.ptyId)
      expect(attached?.status).toBe("running")
    } finally {
      await closeDesktop(first)
    }
  })

  test("D07 Electron relaunch discovers the existing daemon and preserves PTYs", async ({}, testInfo) => {
    const first = await launchDesktop()
    const controlFile = path.join(first.workspace, "d07-control.json")
    try {
      const launched = await launchMockAgentOnHost(first.origin, first.workspace, controlFile, "D07")
      const serverId = runtimeManifest(first.userDataDir)?.serverId
      const daemonPid = first.daemonPid
      await closeDesktop(first, { keepDaemon: true })
      const second = await launchDesktop({
        userDataDir: first.userDataDir,
        workspace: first.workspace,
      })
      try {
        expect(second.daemonPid).toBe(daemonPid)
        expect(runtimeManifest(second.userDataDir)?.serverId).toBe(serverId)
        const attached = await waitForAttach(second.origin, launched.ptyId)
        expect(attached.status).toBe("running")
        expect(isProcessAlive(launched.agent.pid)).toBe(true)
      } finally {
        await closeDesktop(second)
      }
    } catch (error) {
      await stopOwnedRuntime(first.userDataDir)
      throw error
    }
  })
})
