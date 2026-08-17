import { expect, test } from "@playwright/test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { launchJet, pressMuxPrefix, REPO_ROOT } from "./_launch.js"
import { expectSelectorVisible } from "../shell/assert.js"
import type { ShellDriver } from "../shell/driver.js"

const MOCK_ENV = {
  YAADE_NVIM_BIN: path.join(REPO_ROOT, "apps/host-server/mocks/mock-neovim-server.mjs"),
}

type StoredTool = { id: string; kind: string; output: { serverInstanceId?: string; generation?: number; processState?: string } }

async function createNeovim(page: ShellDriver): Promise<string> {
  return page.evaluate(async () => {
    const tools = window.yaade!.tools!
    const sessionId = window.__yaadeAgent!.getState().activeSessionId!
    const project = (await tools.listProjects())[0]!
    const created = await tools.createUse({
      _tag: "CreateToolUse",
      sessionId,
      kind: "neovim",
      project,
      checkout: { _tag: "MainCheckout", kind: "main" },
      input: { _tag: "NeovimToolInput", kind: "neovim" },
    })
    await window.__yaadeAgent!.selectToolUse?.(created.id)
    return created.id
  })
}

async function dispatchNeovimInput(page: ShellDriver, toolUseId: string, text: string): Promise<void> {
  const input = page.locator(`[data-yaade-neovim-tool-use="${toolUseId}"] [data-yaade-neovim-input]`)
  await input.evaluate((element, value) => {
    const textarea = element as HTMLTextAreaElement
    textarea.value = value
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }))
  }, text)
}

async function waitForNeovim(page: ShellDriver, toolUseId: string): Promise<void> {
  await page.waitForSelector(`[data-yaade-neovim-tool-use="${toolUseId}"]`, { state: "visible", timeout: 30_000 })
  await page.waitForFunction(
    id => document.querySelector(`[data-yaade-neovim-tool-use="${id}"]`)?.getAttribute("data-yaade-neovim-status") === "ready",
    toolUseId,
    { timeout: 30_000 },
  )
}

async function readTool(page: ShellDriver, toolUseId: string): Promise<StoredTool> {
  return page.evaluate(id => {
    const use = (window.__yaadeAgent!.getState().toolUses ?? []).find((candidate: { id: string }) => candidate.id === id) as StoredTool | undefined
    if (!use) throw new Error(`missing tool ${id}`)
    return use
  }, toolUseId)
}

test("creates a durable WebGL2 Neovim ToolUse and renders the line grid", async () => {
  const app = await launchJet({
    withTerminal: false,
    env: MOCK_ENV,
  })
  try {
    const page = app.page
    await pressMuxPrefix(page, "KeyE")
    await page.waitForFunction(
      () => window.__yaadeAgent?.getState().toolUses?.some((use: { kind: string }) => use.kind === "neovim") === true,
      null,
      { timeout: 30_000 },
    )
    const toolUseId = await page.evaluate(() => window.__yaadeAgent!.getState().activeToolUseId)
    expect(toolUseId).toMatch(/^use-/)
    const surface = page.locator(`[data-yaade-neovim-tool-use="${toolUseId}"]`)
    await expectSelectorVisible(page, `[data-yaade-neovim-tool-use="${toolUseId}"]`)
    expect(await surface.getAttribute("data-yaade-neovim-renderer")).toBe("webgl2")
    await surface.locator("canvas[data-yaade-neovim-canvas]").waitFor({ state: "visible", timeout: 30_000 })
    await page.waitForFunction(
      id => window.__yaadeAgent?.getNeovimText?.(id).includes("YAADE Neovim"),
      toolUseId,
      { timeout: 30_000 },
    )
    const dims = await page.evaluate(id => window.__yaadeAgent?.getNeovimDims?.(id), toolUseId)
    expect(dims?.cols).toBeGreaterThan(1)
    expect(dims?.rows).toBeGreaterThan(1)
    const canvasSize = await surface.locator("canvas").evaluate(canvas => ({ width: canvas.clientWidth, height: canvas.clientHeight }))
    expect(canvasSize.width).toBeGreaterThan(32)
    expect(canvasSize.height).toBeGreaterThan(32)
    await page.waitForFunction(
      id => {
        const diagnostics = window.__yaadeAgent!.getNeovimDiagnostics(id) as { frames?: number; atlasGlyphs?: number } | null
        return (diagnostics?.frames ?? 0) > 0 && (diagnostics?.atlasGlyphs ?? 0) > 0
      },
      toolUseId,
      { timeout: 30_000 },
    )
    const renderDiagnostics = await page.evaluate(id => window.__yaadeAgent!.getNeovimDiagnostics(id) as {
      frames: number
      atlasGlyphs: number
      lastFrameDrawCalls: number
      gpuTimeAvailable: boolean
    } | null, toolUseId)
    expect(renderDiagnostics?.frames).toBeGreaterThan(0)
    expect(renderDiagnostics?.atlasGlyphs).toBeGreaterThan(0)
    expect(renderDiagnostics?.lastFrameDrawCalls).toBeLessThanOrEqual(4)
    // The default framebuffer is intentionally not preserved; readPixels after
    // a browser composite is not a valid renderer assertion.
    expect(await surface.locator("canvas").evaluate(canvas => Boolean(canvas.getContext("webgl2")))).toBe(true)
    await page.evaluate(id => window.__yaadeAgent!.focusNeovim(id), toolUseId)
    const canvasShot = Buffer.from(await page.screenshot(), "base64")
    await test.info().attach("neovim-webgl-grid", {
      body: canvasShot,
      contentType: "image/png",
    })
    await writeFile(test.info().outputPath("neovim-webgl-grid.png"), canvasShot)
    await page.waitForFunction(
      id => document.querySelector(`[data-yaade-neovim-tool-use="${id}"]`)?.getAttribute("data-yaade-neovim-status") === "ready",
      toolUseId,
      { timeout: 30_000 },
    )
    const tabbarToPaneGap = await page.evaluate(() => {
      const tabbar = document.querySelector<HTMLElement>("[data-yaade-top-tabbar]")
      const pane = document.querySelector<HTMLElement>("[data-yaade-tool-workspace] [data-yaade-panel-leaf]")
      if (!tabbar || !pane) throw new Error("missing tabbar or pane")
      return pane.getBoundingClientRect().top - tabbar.getBoundingClientRect().bottom
    })
    expect(tabbarToPaneGap).toBeLessThanOrEqual(1)
  } finally {
    await app.app.close()
  }
})


test("routes ordinary keys, IME, paste, and literal prefix input to Neovim", async () => {
  const app = await launchJet({ withTerminal: false, env: MOCK_ENV })
  try {
    const page = app.page
    const toolUseId = await createNeovim(page)
    await waitForNeovim(page, toolUseId)
    expect(await page.evaluate(id => window.__yaadeAgent!.focusNeovim(id), toolUseId)).toBe(true)

    await page.keyboard.type("typed")
    await page.waitForFunction(id => window.__yaadeAgent!.getNeovimText(id).includes("input: typed"), toolUseId, { timeout: 10_000 })
    await page.keyboard.press("Escape")
    await page.waitForFunction(id => window.__yaadeAgent!.getNeovimText(id).includes("<Esc>"), toolUseId, { timeout: 10_000 })

    const input = page.locator(`[data-yaade-neovim-tool-use="${toolUseId}"] [data-yaade-neovim-input]`)
    await input.evaluate(element => {
      const textarea = element as HTMLTextAreaElement
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
      textarea.value = "漢"
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "漢" }))
      textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "漢" }))
    })
    await page.waitForFunction(id => window.__yaadeAgent!.getNeovimText(id).includes("漢"), toolUseId, { timeout: 10_000 })
    const composed = await page.evaluate(id => window.__yaadeAgent!.getNeovimText(id), toolUseId)
    expect((composed.match(/漢/gu) ?? []).length).toBe(1)

    await input.evaluate(element => {
      const data = new DataTransfer()
      data.setData("text/plain", "pasted")
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }))
    })
    await page.waitForFunction(id => window.__yaadeAgent!.getNeovimText(id).includes("paste:"), toolUseId)
    const pasted = await page.evaluate(id => window.__yaadeAgent!.getNeovimText(id), toolUseId)
    expect((pasted.match(/pasted/gu) ?? []).length).toBe(1)

    const canvas = page.locator(`[data-yaade-neovim-tool-use="${toolUseId}"] [data-yaade-neovim-canvas]`)
    const box = await canvas.boundingBox()
    expect(box).not.toBeNull()
    if (box) {
      await page.mouse.click(box.x + Math.min(24, box.width / 2), box.y + Math.min(24, box.height / 2))
      await page.waitForFunction(id => window.__yaadeAgent!.getNeovimText(id).includes("mouse:"), toolUseId)
      // A native browser context menu steals subsequent keyboard events even
      // though the hidden Neovim input remains the active element.
      await page.mouse.click(box.x + Math.min(24, box.width / 2), box.y + Math.min(24, box.height / 2), { button: "right" })
      await page.keyboard.type("after-right-click")
      await page.waitForFunction(id => window.__yaadeAgent!.getNeovimText(id).includes("after-right-click"), toolUseId)
    }

    await pressMuxPrefix(page, "KeyK")
    await page.waitForFunction(id => window.__yaadeAgent!.getNeovimText(id).includes("<C-K>"), toolUseId, { timeout: 10_000 })
  } finally {
    await app.app.close()
  }
})

test("keeps distinct host processes and resizes the native grid", async () => {
  const app = await launchJet({ withTerminal: false, env: MOCK_ENV })
  try {
    const page = app.page
    const firstId = await createNeovim(page)
    await waitForNeovim(page, firstId)
    const first = await readTool(page, firstId)
    const firstDims = await page.evaluate(id => window.__yaadeAgent!.getNeovimDims(id), firstId)
    const secondId = await createNeovim(page)
    await waitForNeovim(page, secondId)
    const second = await readTool(page, secondId)
    expect(first.output.serverInstanceId).toBeTruthy()
    expect(second.output.serverInstanceId).toBeTruthy()
    expect(second.output.serverInstanceId).not.toBe(first.output.serverInstanceId)
    expect(second.output.generation).toBe(1)

    await page.setViewportSize({ width: 900, height: 620 })
    await page.waitForFunction(
      ({ id, cols, rows }) => {
        const dims = window.__yaadeAgent!.getNeovimDims(id)
        return Boolean(dims && (dims.cols !== cols || dims.rows !== rows))
      },
      { id: secondId, cols: firstDims?.cols ?? 0, rows: firstDims?.rows ?? 0 },
      { timeout: 30_000 },
    )
  } finally {
    await app.app.close()
  }
})

test("opens Search results in a standalone Neovim ToolUse", async () => {
  const app = await launchJet({ workspaceRel: "fixtures/non-git-search", withTerminal: false, env: MOCK_ENV })
  try {
    const page = app.page
    const searchId = await page.evaluate(async () => {
      const tools = window.yaade!.tools!
      const sessionId = window.__yaadeAgent!.getState().activeSessionId!
      const project = (await tools.listProjects())[0]!
      const created = await tools.createUse({
        _tag: "CreateToolUse",
        sessionId,
        kind: "search",
        project,
        checkout: { _tag: "MainCheckout", kind: "main" },
        input: {
          _tag: "SearchToolInput",
          kind: "search",
          query: "nonGitSearchFixture",
          options: {},
        },
      })
      await window.__yaadeAgent!.selectToolUse?.(created.id)
      return created.id
    })
    await page.waitForSelector('[data-yaade-list-panel="project-search"]', { state: "visible", timeout: 30_000 })
    await page.waitForFunction(
      () => [...document.querySelectorAll('[data-yaade-project-search-hit]')].some(hit => (hit.textContent ?? "").includes("nonGitSearchFixture")),
      null,
      { timeout: 30_000 },
    )
    const hit = page.locator('[data-yaade-project-search-hit="src/index.ts:2"]')
    await hit.click()
    await page.waitForFunction(
      id => window.__yaadeAgent?.getState().toolUses?.some((use: { id: string; kind: string }) => use.id !== id && use.kind === "neovim") === true,
      searchId,
      { timeout: 30_000 },
    )
    const neovimId = await page.evaluate(id => {
      const use = (window.__yaadeAgent!.getState().toolUses ?? []).find((candidate: { id: string; kind: string }) => candidate.id !== id && candidate.kind === "neovim")
      return use?.id ?? null
    }, searchId)
    expect(neovimId).toMatch(/^use-/)
    await waitForNeovim(page, neovimId!)
    await page.waitForFunction(id => window.__yaadeAgent!.getNeovimText(id).includes("opened:"), neovimId, { timeout: 30_000 })
    const firstNeovim = await readTool(page, neovimId!)
    await hit.click()
    await page.waitForTimeout(100)
    const neovimUses = await page.evaluate(() => (window.__yaadeAgent!.getState().toolUses ?? []).filter((use: { kind: string }) => use.kind === "neovim"))
    expect(neovimUses).toHaveLength(1)
    expect((neovimUses[0] as StoredTool).output.serverInstanceId).toBe(firstNeovim.output.serverInstanceId)
    expect(await page.locator('[data-yaade-list-panel="project-search"]').count()).toBeGreaterThan(0)
    expect(await page.locator('[data-yaade-project-search-hit="src/index.ts:2"]').count()).toBeGreaterThan(0)
  } finally {
    await app.app.close()
  }
})

test("rebuilds the WebGL renderer after context loss without losing the model", async () => {
  const app = await launchJet({ withTerminal: false, env: MOCK_ENV })
  try {
    const page = app.page
    const toolUseId = await createNeovim(page)
    await waitForNeovim(page, toolUseId)
    await page.waitForFunction(id => window.__yaadeAgent!.getNeovimText(id).includes("YAADE Neovim"), toolUseId, { timeout: 30_000 })
    const canvas = page.locator(`[data-yaade-neovim-tool-use="${toolUseId}"] canvas[data-yaade-neovim-canvas]`)
    const contextLossSupported = await canvas.evaluate(element => {
      const gl = (element as HTMLCanvasElement).getContext("webgl2")
      const extension = gl?.getExtension("WEBGL_lose_context")
      if (!extension) return false
      extension.loseContext()
      window.setTimeout(() => extension.restoreContext(), 100)
      return true
    })
    expect(contextLossSupported).toBe(true)
    await page.waitForFunction(id => (window.__yaadeAgent!.getNeovimDiagnostics(id) as { contextLosses: number } | null)?.contextLosses === 1, toolUseId, { timeout: 30_000 })
    await page.waitForFunction(id => document.querySelector(`[data-yaade-neovim-tool-use="${id}"]`)?.getAttribute("data-yaade-neovim-status") === "ready", toolUseId, { timeout: 30_000 })
    await page.waitForFunction(id => ((window.__yaadeAgent!.getNeovimDiagnostics(id) as { frames: number } | null)?.frames ?? 0) > 0, toolUseId, { timeout: 30_000 })
    expect(await page.evaluate(id => window.__yaadeAgent!.getNeovimText(id), toolUseId)).toMatch(/YAADE Neovim|resize/u)
  } finally {
    await app.app.close()
  }
})

test("shows an actionable error instead of a Canvas fallback when WebGL2 is unavailable", async () => {
  const app = await launchJet({ withTerminal: false, env: MOCK_ENV })
  try {
    const page = app.page
    await page.evaluate(() => {
      const original = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
        if (type === "webgl2") return null
        return original.call(this, type, ...(args as [unknown]))
      } as typeof original
    })
    const toolUseId = await createNeovim(page)
    await page.waitForFunction(id => document.querySelector(`[data-yaade-neovim-tool-use="${id}"]`)?.getAttribute("data-yaade-neovim-status") === "failed", toolUseId, { timeout: 30_000 })
    await expectSelectorVisible(page, `[data-yaade-neovim-tool-use="${toolUseId}"] [data-yaade-neovim-overlay="failed"]`)
    expect(await page.getByText("WebGL2 renderer unavailable").count()).toBeGreaterThan(0)
    expect(await page.locator(`[data-yaade-neovim-tool-use="${toolUseId}"] [data-yaade-neovim-retry]`).count()).toBe(1)
  } finally {
    await app.app.close()
  }
})

test("shows process exit, restarts with a new generation, and cleans up on close", async () => {
  const app = await launchJet({ withTerminal: false, env: MOCK_ENV })
  try {
    const page = app.page
    const toolUseId = await createNeovim(page)
    await waitForNeovim(page, toolUseId)
    const before = await readTool(page, toolUseId)

    await dispatchNeovimInput(page, toolUseId, "__YAADE_EXIT__")
    await page.waitForFunction(
      id => document.querySelector(`[data-yaade-neovim-tool-use="${id}"]`)?.getAttribute("data-yaade-neovim-status") === "exited",
      toolUseId,
      { timeout: 30_000 },
    )
    await page.locator(`[data-yaade-neovim-tool-use="${toolUseId}"] [data-yaade-neovim-restart]`).click()
    await page.waitForFunction(
      id => {
        const use = (window.__yaadeAgent!.getState().toolUses ?? []).find((candidate: { id: string }) => candidate.id === id) as StoredTool | undefined
        return use?.output.generation === 2
      },
      toolUseId,
      { timeout: 30_000 },
    )
    await waitForNeovim(page, toolUseId)
    const restarted = await readTool(page, toolUseId)
    expect(restarted.output.serverInstanceId).not.toBe(before.output.serverInstanceId)

    await page.evaluate(id => window.__yaadeAgent!.closeToolUse?.(id), toolUseId)
    await page.waitForFunction(
      id => !(window.__yaadeAgent!.getState().toolUses ?? []).some((use: { id: string }) => use.id === id),
      toolUseId,
      { timeout: 30_000 },
    )
    expect(await page.locator(`[data-yaade-neovim-tool-use="${toolUseId}"]`).count()).toBe(0)
  } finally {
    await app.app.close()
  }
})

test("repaints across appearance changes and keeps Neovim alive while mobile hides unsupported tools", async () => {
  const app = await launchJet({ withTerminal: false, env: MOCK_ENV })
  try {
    const page = app.page
    const toolUseId = await createNeovim(page)
    await waitForNeovim(page, toolUseId)
    const before = await readTool(page, toolUseId)

    await page.locator("[data-yaade-session-settings]").click()
    await page.locator('[data-yaade-color-mode-option="light"]').click()
    await page.waitForFunction(
      id => (window.__yaadeAgent!.getNeovimDiagnostics(id) as { themeId?: string } | null)?.themeId?.includes("light") === true,
      toolUseId,
      { timeout: 30_000 },
    )
    await test.info().attach("neovim-light-desktop", {
      body: Buffer.from(await page.screenshot(), "base64"),
      contentType: "image/png",
    })

    await page.locator('[data-yaade-color-mode-option="dark"]').click()
    await page.waitForFunction(
      id => (window.__yaadeAgent!.getNeovimDiagnostics(id) as { themeId?: string } | null)?.themeId?.includes("dark") === true,
      toolUseId,
      { timeout: 30_000 },
    )
    await page.keyboard.press("Escape")
    await test.info().attach("neovim-dark-desktop", {
      body: Buffer.from(await page.screenshot(), "base64"),
      contentType: "image/png",
    })

    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForSelector("[data-yaade-mobile-tool-list]", {
      state: "visible",
      timeout: 30_000,
    })
    expect(await page.locator(`[data-yaade-neovim-tool-use="${toolUseId}"]`).count()).toBe(0)
    const whileMobile = await readTool(page, toolUseId)
    expect(whileMobile.output.serverInstanceId).toBe(before.output.serverInstanceId)
    expect(whileMobile.output.generation).toBe(before.output.generation)

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.evaluate(id => window.__yaadeAgent!.selectToolUse?.(id), toolUseId)
    await waitForNeovim(page, toolUseId)
    const after = await readTool(page, toolUseId)
    expect(after.output.serverInstanceId).toBe(before.output.serverInstanceId)
    expect(after.output.generation).toBe(before.output.generation)
  } finally {
    await app.app.close()
  }
})

test("reconnects after Session, Window, and browser switches without replacing the Neovim server", async () => {
  const app = await launchJet({ withTerminal: false, env: MOCK_ENV })
  try {
    const page = app.page
    const toolUseId = await createNeovim(page)
    await waitForNeovim(page, toolUseId)
    const before = await readTool(page, toolUseId)
    const originalSessionId = await page.evaluate(() => window.__yaadeAgent!.getState().activeSessionId)
    const originalTabId = await page.evaluate(() => window.__yaadeAgent!.getState().activeTabId)
    expect(originalSessionId).toBeTruthy()
    expect(originalTabId).toBeTruthy()

    await page.evaluate(() => window.__yaadeAgent!.createTab?.())
    await page.waitForFunction(id => window.__yaadeAgent!.getState().activeTabId !== id, originalTabId)
    await page.evaluate(id => window.__yaadeAgent!.selectTab?.(id), originalTabId!)
    await waitForNeovim(page, toolUseId)
    expect((await readTool(page, toolUseId)).output.serverInstanceId).toBe(before.output.serverInstanceId)

    await page.evaluate(() => window.__yaadeAgent!.createSession?.())
    await page.waitForFunction(id => window.__yaadeAgent!.getState().activeSessionId !== id, originalSessionId)
    await page.evaluate(id => window.__yaadeAgent!.selectSession?.(id), originalSessionId!)
    await waitForNeovim(page, toolUseId)
    expect((await readTool(page, toolUseId)).output.serverInstanceId).toBe(before.output.serverInstanceId)

    await page.reload({ waitUntil: "domcontentloaded" })
    await page.waitForSelector('[data-yaade-shell="tool-session"]', { state: "visible", timeout: 30_000 })
    await page.evaluate(() => window.__yaadeAgent!.waitForReady())
    await page.evaluate(id => window.__yaadeAgent!.selectTab?.(id), originalTabId!)
    await page.evaluate(id => window.__yaadeAgent!.selectToolUse?.(id), toolUseId)
    await page.waitForFunction(id => window.__yaadeAgent!.getState().activeToolUseId === id, toolUseId, { timeout: 30_000 })
    await waitForNeovim(page, toolUseId)
    await page.waitForFunction(id => window.__yaadeAgent!.getNeovimText(id).includes("YAADE Neovim"), toolUseId, { timeout: 30_000 })
    const after = await readTool(page, toolUseId)
    expect(after.output.serverInstanceId).toBe(before.output.serverInstanceId)
    expect(after.output.generation).toBe(before.output.generation)
  } finally {
    await app.app.close()
  }
})

