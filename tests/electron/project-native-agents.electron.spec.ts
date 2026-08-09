import { expect, test } from "@playwright/test"
import { expectListRows } from "../helpers/list.js"
import { expectLocatorContainsText } from "../shell/assert.js"
import { execCommand, launchJet, waitForTerminalText } from "./_launch.js"

test.describe("project native agents", () => {
  test("lists exact drivers and runs a protocol-backed mock thread", async () => {
    const { app, page } = await launchJet({
      projectPage: true,
      withTerminal: false,
      env: { YAADE_AGENT_MOCK_SCENARIO: "simple-stream" },
    })
    try {
      await page.locator('[data-yaade-project-tab="native-agents"]').click()

      const surface = page.locator(
        '[data-yaade-project-surface="native-agents"]',
      )
      await surface.waitFor({ state: "visible", timeout: 15_000 })
      await surface
        .getByText("Start an agent thread")
        .waitFor({ state: "visible", timeout: 15_000 })
      await expectListRows(page, {
        panel: "native-agent-drivers",
        minItems: 1,
        needle: "Canonical Mock Driver",
      })

      await surface
        .locator('[data-yaade-native-agent-driver="mock:canonical"]')
        .click()
      await surface
        .locator('[aria-label="Message agent"]')
        .waitFor({ state: "visible", timeout: 15_000 })

      const runtimeState = await page.evaluate(async () => {
        const sessionId = window.__yaadeAgent?.getState().sessionId
        const runtime = window.yaade?.agentRuntime
        if (!sessionId || !runtime) throw new Error("agent runtime unavailable")
        const threads = await runtime.listThreads(sessionId)
        return {
          sessionId,
          driverId: String(threads[0]?.state.driverId ?? ""),
          cwdUri: String(threads[0]?.state.cwdUri ?? ""),
        }
      })
      expect(runtimeState.driverId).toBe("mock:canonical")
      expect(runtimeState.cwdUri).toMatch(/\/sample-workspace$/)
      const route = await page.evaluate(() => ({
        view: new URL(location.href).searchParams.get("view"),
        sessionId: new URL(location.href).searchParams.get("s"),
      }))
      expect(route.view).toBe("native-agents")
      expect(route.sessionId).toBe(runtimeState.sessionId)

      await surface.locator('[aria-label="Message agent"]').fill("Show the native flow")
      await surface.getByRole("button", { name: "Send message" }).click()
      await expectLocatorContainsText(
        surface.locator("[data-yaade-agent-timeline]"),
        "Hello from mock.",
        { timeout: 15_000 },
      )

      await surface.locator("[data-yaade-native-agent-new]").click()
      await expectListRows(page, {
        panel: "native-agent-drivers",
        minItems: 1,
        needle: "Canonical Mock Driver",
      })
      await page.keyboard.press("Escape")
      await page.locator('[data-yaade-project-tab="terminals"]').click()
      const terminal = page.locator("[data-yaade-terminal-panel]")
      await terminal.waitFor({ state: "visible", timeout: 15_000 })
      await expect
        .poll(() => terminal.getAttribute("data-yaade-terminal-pty-id"))
        .toBeTruthy()
      const initialPtyId = await terminal.getAttribute(
        "data-yaade-terminal-pty-id",
      )
      expect(initialPtyId).toBeTruthy()
      await page.evaluate(async id => {
        if (!id) throw new Error("terminal id missing")
        await window.yaade?.terminal?.write(id, "printf 'native-pty-alive\\n'\n")
      }, initialPtyId)
      await waitForTerminalText(page, "native-pty-alive")

      await execCommand(page, "agentChat.focus")
      await expect
        .poll(() =>
          page
            .locator('[data-yaade-project-tab="native-agents"]')
            .getAttribute("aria-selected"),
        )
        .toBe("true")
      await expectLocatorContainsText(
        surface.locator("[data-yaade-agent-timeline]"),
        "Hello from mock.",
      )

      await page.reload()
      await surface.waitFor({ state: "visible", timeout: 15_000 })
      await expectLocatorContainsText(
        surface.locator("[data-yaade-agent-timeline]"),
        "Hello from mock.",
        { timeout: 15_000 },
      )

      await page.locator('[data-yaade-project-tab="terminals"]').click()
      await terminal.waitFor({ state: "visible", timeout: 15_000 })
      expect(await terminal.getAttribute("data-yaade-terminal-pty-id")).toBe(
        initialPtyId,
      )
      await waitForTerminalText(page, "native-pty-alive")

      await page.locator('[data-yaade-project-tab="native-agents"]').click()
      await surface.locator("[data-yaade-native-agent-close]").click()
      await expect
        .poll(async () =>
          page.evaluate(async sessionId => {
            const threads =
              (await window.yaade?.agentRuntime?.listThreads(sessionId)) ?? []
            return threads[0]?.state.status
          }, runtimeState.sessionId),
        )
        .toBe("closed")

      await surface.locator("[data-yaade-native-agent-delete]").click()
      await page.getByRole("button", { name: "Delete thread" }).click()
      await surface
        .getByText("Start an agent thread")
        .waitFor({ state: "visible", timeout: 15_000 })
      await expect
        .poll(async () =>
          page.evaluate(async sessionId =>
            (await window.yaade?.agentRuntime?.listThreads(sessionId))?.length,
          runtimeState.sessionId),
        )
        .toBe(0)
    } finally {
      await app.close()
    }
  })
})
