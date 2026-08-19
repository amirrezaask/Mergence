import { expect } from "@playwright/test"
import path from "node:path"
import { test } from "../fixtures/e2e.js"
import { REPO_ROOT } from "./_launch.js"

const ptyAvailable = process.platform !== "win32"
const probeShell = path.join(
  REPO_ROOT,
  "tests/fixtures/terminal-primary-device-attributes.mjs",
)

test.describe("terminal compatibility", () => {
  test.skip(!ptyAvailable, "node-pty cannot spawn a shell on this machine")

  test("answers a startup Primary Device Attributes query", async ({ launchApp }) => {
    const { page } = await launchApp({ env: { SHELL: probeShell } })
    await page.evaluate(() => {
      history.pushState(null, "", "/")
      window.dispatchEvent(new Event("popstate"))
    })
    await expect(page.locator('[data-yaade-shell="tool-session"]')).toBeVisible()
    await page.evaluate(() => window.__yaadeAgent!.waitForReady())

    const unknownTerminalWrite = await page.evaluate(async () => {
      const terminal = window.yaade?.terminal
      if (!terminal) throw new Error("terminal API missing")
      await terminal.write("", "x")
      return "ignored"
    })
    // Unknown terminal ids are an idempotent no-op so stale UI cleanup cannot
    // turn a late write into an unhandled browser error.
    expect(unknownTerminalWrite).toBe("ignored")

    const toolUseId = await page.evaluate(async () => {
      const tools = window.yaade?.tools
      const state = window.__yaadeAgent?.getState()
      const sessionId = state?.activeSessionId
      if (!tools || !sessionId) throw new Error("tools API or session missing")
      const project = (await tools.listProjects())[0]
      if (!project) throw new Error("no project")
      const created = await tools.createUse({
        _tag: "CreateToolUse",
        sessionId,
        kind: "terminal",
        project,
        checkout: { _tag: "MainCheckout", kind: "main" },
        input: { _tag: "TerminalToolInput", kind: "terminal" },
      })
      await window.__yaadeAgent?.selectToolUse?.(created.id)
      return created.id
    })

    await expect(
      page.locator(
        `[data-yaade-tool-tile="${toolUseId}"] [data-ghostty-terminal-canvas]`,
      ),
    ).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(
        () =>
          page.evaluate(
            id => window.__yaadeAgent?.getTerminalText?.(id) ?? "",
            toolUseId,
          ),
        { timeout: 10_000 },
      )
      .toContain("DA1-PROBE-OK")
    await expect
      .poll(
        () =>
          page.evaluate(
            id => window.__yaadeAgent?.getTerminalText?.(id) ?? "",
            toolUseId,
          ),
        { timeout: 1_000 },
      )
      .not.toContain("DA1-PROBE-TIMEOUT")
  })
})
