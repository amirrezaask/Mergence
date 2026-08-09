import { expect, test } from "@playwright/test"
import {
  expectLocatorContainsText,
  expectLocatorVisible,
} from "../shell/assert.js"
import {
  hasCursorAgent,
  launchJet,
  waitForMux,
  type ShellDriver,
} from "./_launch.js"

const LIVE = process.env.YAADE_CURSOR_LIVE === "1"
const USAGE_WARNING = [
  "YAADE_CURSOR_LIVE=1: this test is about to submit a real Cursor prompt.",
  "It may use provider quota or incur cost. The fixture prompts prohibit destructive changes.",
].join(" ")

type LiveThreadState = {
  id: string
  status: string
  configurationCount: number
  tool?: { title: string; status: string }
  permission?: { title: string; rejectLabel: string }
}

async function openCursorStartView(page: ShellDriver) {
  await page.locator('[data-yaade-project-tab="native-agents"]').click()
  const pane = page.locator('[data-yaade-tool-pane="agentChat"]')
  await pane.waitFor({ state: "visible", timeout: 15_000 })
  await pane.locator("[data-yaade-agent-composer]").waitFor({
    state: "visible",
    timeout: 15_000,
  })
  await expectLocatorVisible(
    pane.locator('[data-chat-provider-model-picker="true"]'),
  )
  return pane
}

async function openCursorThread(page: ShellDriver) {
  const pane = await openCursorStartView(page)
  await pane.locator('[data-chat-provider-model-picker="true"]').click()
  const picker = page.locator("[data-model-picker-content]")
  await picker.waitFor({ state: "visible", timeout: 10_000 })
  const cursorSidebar = picker.locator('[data-model-picker-provider="cursor"]')
  if ((await cursorSidebar.count()) > 0) await cursorSidebar.click()
  await picker.locator("[data-model-slug]").first().click()
  const input = pane.locator('[aria-label="Message agent"]')
  await input.click()
  await page.keyboard.type("ping")
  await pane.getByRole("button", { name: "Send message" }).click()
  await pane.locator("[data-yaade-agent-timeline]").waitFor({
    state: "visible",
    timeout: 30_000,
  })
  await expectLocatorContainsText(pane, "Ready", { timeout: 30_000 })
  return pane
}

async function cursorThreadState(page: ShellDriver): Promise<LiveThreadState | null> {
  return page.evaluate(async () => {
    const runtime = window.yaade?.agentRuntime
    const sessionId = window.__yaadeAgent?.getState().sessionId
    if (!runtime || !sessionId) throw new Error("agent runtime unavailable")
    const thread = (await runtime.listThreads(sessionId)).find(
      candidate => String(candidate.state.providerId) === "cursor",
    )
    if (!thread) return null
    const tool = Object.values(thread.state.itemsById).find(
      item => item.type === "tool-call",
    )
    const permission = thread.state.pendingActions.find(
      action => action.type === "permission",
    )
    const reject = permission?.type === "permission"
      ? permission.options.find(option => option.decision.startsWith("reject"))
      : undefined
    return {
      id: String(thread.state.id),
      status: thread.state.status,
      configurationCount: thread.state.configuration.length,
      ...(tool?.type === "tool-call"
        ? { tool: { title: tool.title, status: tool.status } }
        : {}),
      ...(permission?.type === "permission" && reject
        ? { permission: { title: permission.title, rejectLabel: reject.label } }
        : {}),
    }
  })
}

async function submitLivePrompt(page: ShellDriver, prompt: string): Promise<void> {
  // Keep the warning immediately before the user-initiated provider side effect.
  console.warn(USAGE_WARNING)
  const pane = page.locator('[data-yaade-tool-pane="agentChat"]')
  await pane.locator('[aria-label="Message agent"]').fill(prompt)
  await pane.getByRole("button", { name: "Send message" }).click()
}

test.describe("Cursor ACP live compatibility", () => {
  test.skip(
    !LIVE,
    "Opt in with YAADE_CURSOR_LIVE=1; live prompts may consume Cursor provider usage.",
  )

  test.beforeEach(() => {
    test.skip(!hasCursorAgent(), "Cursor CLI was not found on PATH")
  })

  test("discovers an authenticated CLI and reports a real version in the generic start view", async () => {
    const { app, page } = await launchJet({ withTerminal: false })
    try {
      const pane = await openCursorStartView(page)
      const cursorButton = pane.getByRole("button", { name: /Cursor ACP/ })
      await expectLocatorVisible(cursorButton)
      expect(await cursorButton.getAttribute("disabled")).toBeNull()

      const discovery = await page.evaluate(async () => {
        const runtime = window.yaade?.agentRuntime
        const cwdPath = window.__yaadeAgent?.getState().sessionCwd
        if (!runtime || !cwdPath) throw new Error("agent runtime unavailable")
        const cwdUri = `file://${cwdPath.split("/").map((part, index) => index === 0 ? part : encodeURIComponent(part)).join("/")}`
        return (await runtime.listDrivers(cwdUri)).find(
          candidate => String(candidate.descriptor.id) === "cursor:acp",
        )
      })

      expect(discovery, "cursor:acp was not registered").toBeTruthy()
      expect(discovery?.available, discovery?.reason).toBe(true)
      expect(discovery?.version).toMatch(/\d+\.\d+/)
    } finally {
      await app.close()
    }
  })

  test("streams one exact response, survives reload, and closes through the generic UI/runtime", async () => {
    const { app, page } = await launchJet({ withTerminal: false })
    try {
      const pane = await openCursorThread(page)
      await page.evaluate(() => {
        const target = window as Window & { __yaadeCursorSawStreaming?: boolean }
        target.__yaadeCursorSawStreaming = false
        const observer = new MutationObserver(() => {
          if (
            document.querySelector('[aria-label="Streaming"]') ||
            document.querySelector('[data-yaade-tool-pane="agentChat"]')?.textContent?.includes("Working")
          ) {
            target.__yaadeCursorSawStreaming = true
          }
        })
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      })

      await submitLivePrompt(
        page,
        "Reply with exactly YAADE_CURSOR_LIVE_OK. Do not use tools and do not modify files.",
      )
      await expectLocatorContainsText(
        pane.locator('[data-yaade-agent-timeline]'),
        "YAADE_CURSOR_LIVE_OK",
        { timeout: 120_000 },
      )
      await expect.poll(() => page.evaluate(
        () => Boolean((window as Window & { __yaadeCursorSawStreaming?: boolean }).__yaadeCursorSawStreaming),
      )).toBe(true)
      await expectLocatorContainsText(pane, "Ready", { timeout: 30_000 })

      const beforeReload = await cursorThreadState(page)
      expect(beforeReload?.status).toBe("idle")
      if ((beforeReload?.configurationCount ?? 0) > 0) {
        await expectLocatorContainsText(pane, "Configuration")
      }

      await page.reload()
      await waitForMux(page)
      const restored = page.locator('[data-yaade-tool-pane="agentChat"]')
      await expectLocatorContainsText(
        restored.locator('[data-yaade-agent-timeline]'),
        "YAADE_CURSOR_LIVE_OK",
        { timeout: 30_000 },
      )
      await expectLocatorContainsText(restored, "Ready", { timeout: 30_000 })
      await expectLocatorVisible(restored.locator('[aria-label="Message agent"]'))

      const closed = await page.evaluate(async () => {
        const runtime = window.yaade?.agentRuntime
        const sessionId = window.__yaadeAgent?.getState().sessionId
        if (!runtime || !sessionId) throw new Error("agent runtime unavailable")
        const thread = (await runtime.listThreads(sessionId)).find(
          candidate => String(candidate.state.providerId) === "cursor",
        )
        if (!thread) throw new Error("Cursor thread unavailable")
        return runtime.closeThread(String(thread.state.id))
      })
      expect(closed.state.status).toBe("closed")
    } finally {
      await app.close()
    }
  })

  test("renders a safe read-only tool lifecycle with the generic tool card", async () => {
    const { app, page } = await launchJet({ withTerminal: false })
    try {
      const pane = await openCursorThread(page)
      await submitLivePrompt(
        page,
        "Read package.json with a read-only tool. Do not modify any file. Then reply with exactly YAADE_CURSOR_TOOL_OK.",
      )
      await expect.poll(() => cursorThreadState(page), {
        timeout: 120_000,
      }).toMatchObject({ tool: { status: "completed" } })
      const tool = await cursorThreadState(page)
      expect(tool?.tool?.title).toBeTruthy()
      await expectLocatorContainsText(
        pane.locator('[data-yaade-agent-timeline]'),
        tool!.tool!.title,
      )
      await expectLocatorContainsText(pane, "YAADE_CURSOR_TOOL_OK", { timeout: 120_000 })
    } finally {
      await app.close()
    }
  })

  test("rejects a requested write permission without changing the fixture", async () => {
    const { app, page } = await launchJet({ withTerminal: false })
    try {
      const pane = await openCursorThread(page)
      await submitLivePrompt(
        page,
        "Request permission before creating cursor-live-denied.txt. Do not create or modify anything unless permission is granted.",
      )
      await expect.poll(async () => (await cursorThreadState(page))?.permission ?? null, {
        timeout: 120_000,
      }).not.toBeNull()
      const permission = (await cursorThreadState(page))?.permission
      expect(permission).toBeTruthy()
      const dock = pane.locator('[data-yaade-agent-action-dock]')
      await expectLocatorContainsText(dock, permission!.title)
      const escapedLabel = permission!.rejectLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      await dock.getByRole("button", { name: new RegExp(`^${escapedLabel}$`) }).click()
      await expect.poll(() => dock.count()).toBe(0)
      await expect.poll(async () => (await cursorThreadState(page))?.status, {
        timeout: 120_000,
      }).toMatch(/idle|failed|interrupted/)
      const deniedFileExists = await page.evaluate(async () => {
        const runtime = window.yaade?.agentRuntime
        const filesystem = window.yaade?.fs
        const sessionId = window.__yaadeAgent?.getState().sessionId
        if (!runtime || !filesystem || !sessionId) throw new Error("host APIs unavailable")
        const thread = (await runtime.listThreads(sessionId)).find(
          candidate => String(candidate.state.providerId) === "cursor",
        )
        if (!thread) throw new Error("Cursor thread unavailable")
        const uri = `${thread.state.cwdUri.replace(/\/$/, "")}/cursor-live-denied.txt`
        return filesystem.exists ? filesystem.exists(uri) : filesystem.stat(uri).then(() => true, () => false)
      })
      expect(deniedFileExists).toBe(false)
    } finally {
      await app.close()
    }
  })

  test("interrupts a live turn through the generic composer control", async () => {
    const { app, page } = await launchJet({ withTerminal: false })
    try {
      const pane = await openCursorThread(page)
      await submitLivePrompt(
        page,
        "Without using tools, produce a very long numbered analysis so there is time to interrupt. Do not modify files.",
      )
      const interrupt = pane.getByRole("button", { name: "Interrupt agent" })
      await interrupt.waitFor({ state: "visible", timeout: 30_000 })
      await interrupt.click()
      await expect.poll(async () => (await cursorThreadState(page))?.status, {
        timeout: 30_000,
      }).toBe("interrupted")
      await expect.poll(() => interrupt.count()).toBe(0)
    } finally {
      await app.close()
    }
  })
})
