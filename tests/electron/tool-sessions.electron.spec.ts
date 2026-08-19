import fs from "node:fs"
import path from "node:path"
import { expect } from "@playwright/test"
import { test } from "../fixtures/e2e.js"
import { focusTerminal, pressShellPrefix } from "./_launch.js"

test("Session shell exposes only Terminal and Git tools", async ({ launchApp }) => {
  const { page } = await launchApp()
  await expect(page.locator('[data-yaade-shell="tool-session"]')).toBeVisible()
  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible()
  await expect(page.locator('[data-yaade-session-empty=""]')).toHaveCount(0)
  await expect(page.locator('[data-yaade-running-agent-count]')).toHaveCount(0)
  const topBar = page.locator('[data-yaade-top-tabbar]')
  await expect(topBar).toBeVisible()
  await expect(topBar.getByRole("button", { name: "Switch tool" })).toHaveCount(0)
  await expect(
    topBar.getByRole("button", { name: /Switch session/ }),
  ).toBeVisible()
  await expect(topBar.locator('[data-yaade-session-settings=""]')).toBeVisible()
  await expect(topBar.getByRole("button", { name: "Settings" })).toBeVisible()

  const runningAgentsSidebar = page.getByRole("complementary", {
    name: "Running agents",
  })
  await expect(runningAgentsSidebar).toHaveCount(0)

  await pressShellPrefix(page)
  const hud = page.locator("[data-yaade-which-key]")
  await expect(hud).toContainText("New Terminal")
  await expect(hud).toContainText("New Git")
  await expect(hud).not.toContainText("Toggle sidebar")
  await expect(hud).not.toContainText("Search")
  await expect(hud).not.toContainText("Neovim")
})

test("closing a new Window during automatic terminal creation stays quiet", async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
    // The intentionally delayed create races tab archival; the host rejects
    // that stale command while the UI must treat it as an expected close.
    expectedHttpErrors: [{ method: "POST", path: "/api/v1/rpc", status: 400 }],
  })
  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible()

  await page.evaluate(() => {
    const tools = window.yaade?.tools
    if (!tools?.createUse) throw new Error("tool API is not ready")
    const selectTab = tools.selectTab
    tools.selectTab = async command => {
      document.documentElement.dataset.yaadeTestSelectState = "started"
      try {
        return await selectTab(command)
      } finally {
        document.documentElement.dataset.yaadeTestSelectState = "settled"
      }
    }
    const createUse = tools.createUse
    tools.createUse = async command => {
      const released = new Promise<void>(resolve => {
        window.addEventListener("yaade:test-release-create", () => resolve(), {
          once: true,
        })
      })
      document.documentElement.dataset.yaadeTestCreateState = "started"
      await released
      try {
        return await createUse(command)
      } finally {
        document.documentElement.dataset.yaadeTestCreateState = "settled"
      }
    }
  })

  const windowTabs = page.locator("[data-yaade-window-tabs] [data-yaade-session-tab]")
  await expect(windowTabs).toHaveCount(1)
  await page.getByRole("button", { name: "New tab" }).click()
  await expect(windowTabs).toHaveCount(2)
  await expect
    .poll(() => page.locator("html").getAttribute("data-yaade-test-create-state"))
    .toBe("started")
  await expect
    .poll(() => page.locator("html").getAttribute("data-yaade-test-select-state"))
    .toBe("settled")

  const newTab = windowTabs.filter({ hasText: "New tab" })
  await newTab.getByRole("button", { name: "Close New tab" }).click()
  await expect(windowTabs).toHaveCount(1)
  await page.evaluate(() => window.dispatchEvent(new Event("yaade:test-release-create")))
  await expect
    .poll(() => page.locator("html").getAttribute("data-yaade-test-create-state"))
    .toBe("settled")
  await expect(page.getByRole("alert").filter({ hasText: "Action failed" })).toHaveCount(0)
})

test("tool context adds a project with folder-path completion", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  })
  const projectPath = await page.evaluate(async () => {
    const project = (await window.yaade?.tools?.listProjects?.())?.[0]
    if (!project) throw new Error("no project available")
    return project.projectPath
  })
  const addedPath = path.join(projectPath, "nested-project")
  fs.mkdirSync(addedPath)

  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible()
  await page.locator('[data-yaade-mux-context-trigger=""]').click()
  const context = page.locator("[data-yaade-tool-context-popover]").last()
  await expect(context).toBeVisible()
  await context.locator("[data-yaade-add-project]").click()

  const pathPicker = page.locator('[data-yaade-file-lister=""]')
  const pathInput = pathPicker.getByPlaceholder("Path to folder…")
  await expect(pathInput).toBeVisible()
  await expect(pathPicker).toContainText("Add project")
  await pathInput.fill(addedPath)
  await pathPicker.getByRole("button", { name: /Add project/ }).click()
  await expect(pathInput).toBeHidden()
  await expect
    .poll(async () =>
      page.evaluate(async target => {
        const projects = (await window.yaade?.tools?.listProjects?.()) ?? []
        return projects.some(project => project.projectPath === target)
      }, addedPath),
    )
    .toBe(true)
})

test("terminal cwd offers to remember an unknown project", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  })
  const projectPath = await page.evaluate(async () => {
    const project = (await window.yaade?.tools?.listProjects?.())?.[0]
    if (!project) throw new Error("no project available")
    return project.projectPath
  })
  const addedPath = path.join(path.dirname(projectPath), "terminal-project")
  fs.mkdirSync(addedPath)

  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible()
  await focusTerminal(page)
  await page.keyboard.type(`cd "${addedPath}"`)
  await page.keyboard.press("Enter")

  const prompt = page.locator("[data-yaade-project-discovery-prompt]")
  await expect(prompt).toBeVisible()
  await prompt.locator("[data-yaade-add-discovered-project]").click()
  await expect(prompt).toBeHidden()
  await expect
    .poll(async () =>
      page.evaluate(async target => {
        const projects = (await window.yaade?.tools?.listProjects?.()) ?? []
        return projects.some(project => project.projectPath === target)
      }, addedPath),
    )
    .toBe(true)
})

test("agent sidebar selection focuses its tool pane", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  })
  const created = await page.evaluate(async () => {
    const tools = window.yaade?.tools
    const state = window.__yaadeAgent?.getState()
    if (!tools || !state?.activeSessionId) throw new Error("tools are not ready")
    const project = (await tools.listProjects())[0]
    if (!project) throw new Error("no project available")
    const input = {
      _tag: "TerminalToolInput" as const,
      kind: "terminal" as const,
    }
    const checkout = { _tag: "MainCheckout" as const, kind: "main" as const }
    const first = await tools.createUse({
      _tag: "CreateToolUse",
      sessionId: state.activeSessionId,
      kind: "terminal",
      project,
      checkout,
      input,
    })
    const _second = await tools.createUse({
      _tag: "CreateToolUse",
      sessionId: state.activeSessionId,
      kind: "terminal",
      project,
      checkout,
      input,
    })
    return {
      firstId: first.id,
      sessionId: state.activeSessionId,
      projectId: project.projectId,
      projectPath: project.projectPath,
    }
  })

  await page.evaluate((agent) => {
    const api = window.yaade?.agents
    if (!api) throw new Error("agent API is not available")
    api.listLive = async () => [
      {
        runId: "e2e-agent",
        launchRequestId: "e2e-agent",
        generation: 1,
        provider: "claude",
        projectId: agent.projectId,
        workspaceId: agent.sessionId,
        checkoutKey: "main",
        checkoutPath: agent.projectPath,
        title: "Claude",
        toolUseId: agent.firstId,
        ptyId: null,
        nativeSessionId: null,
        processState: "running",
        activityState: "working",
        telemetryState: "process_only",
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        endedAt: null,
        exitCode: null,
        endReason: null,
        telemetryError: null,
        revision: 1,
      },
    ]
    window.dispatchEvent(new Event("focus"))
  }, created)

  const agent = page.locator('[data-yaade-running-agent="e2e-agent"]')
  await expect(agent).toBeVisible({ timeout: 30_000 })
  await agent.getByRole("button", { name: "Claude, Working" }).click()
  await expect
    .poll(() => page.evaluate(() => window.__yaadeAgent?.getState().activeToolUseId))
    .toBe(created.firstId)
  await expect(
    page.locator(`[data-yaade-tool-tile="${created.firstId}"][data-focused]`),
  ).toBeVisible()
})

test("split shortcuts split the focused pane in both directions", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  })
  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible()
  await expect(page.locator("[data-yaade-tool-tile]")).toHaveCount(1, {
    timeout: 30_000,
  })

  await expect(
    page.locator('[data-yaade-mux-split="right"]').first(),
  ).toHaveAttribute("title", /Split right \(.*D\)/)
  await expect(
    page.locator('[data-yaade-mux-split="down"]').first(),
  ).toHaveAttribute("title", /Split down \(.*D\)/)

  await focusTerminal(page)
  const modifier = process.platform === "darwin" ? "Meta" : "Control"
  await page.keyboard.press(`${modifier}+d`)
  await expect(page.locator("[data-yaade-mux-pane-chrome]")).toHaveCount(2)

  await page.keyboard.press(`${modifier}+Shift+d`)
  await expect(page.locator("[data-yaade-mux-pane-chrome]")).toHaveCount(3)
})

test("split controls open Terminal by default and the picker with a modifier", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  })
  await expect(page.locator('[data-yaade-shell="tool-session"]')).toBeVisible()

  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible()
  await expect(page.locator("[data-yaade-tool-tile]")).toHaveCount(1, {
    timeout: 30_000,
  })

  const paneChrome = page.locator("[data-yaade-mux-pane-chrome]").first()
  await expect(paneChrome.locator('[data-yaade-mux-split="right"]')).toBeVisible()
  await expect(paneChrome.locator('[data-yaade-mux-split="down"]')).toBeVisible()
  await expect(paneChrome.locator('[data-yaade-mux-close-pane=""]')).toBeVisible()

  await paneChrome.locator('[data-yaade-mux-split="right"]').click()
  await expect(page.locator("[data-yaade-tool-tile]")).toHaveCount(2, {
    timeout: 30_000,
  })
  await expect(page.locator('[data-yaade-empty-tool-tile]')).toHaveCount(0)
  await expect(page.locator("[data-yaade-pane-tool-menu]")).toBeHidden()

  const modifier = process.platform === "darwin" ? "Meta" : "Control"
  await paneChrome
    .locator('[data-yaade-mux-split="down"]')
    .click({ modifiers: [modifier] })
  const picker = page.locator("[data-yaade-pane-tool-menu]")
  await expect(picker).toBeVisible()
  await expect(picker).not.toContainText("New tool")

  await picker.locator('[data-yaade-pane-new-tool-kind="terminal"]').click({ force: true })
  await expect(page.locator("[data-yaade-tool-tile]")).toHaveCount(3, {
    timeout: 30_000,
  })
  await expect(page.locator('[data-yaade-empty-tool-tile]')).toHaveCount(0)
  await expect(page.locator('[data-yaade-mux-zoom=""]').first()).toBeVisible()
  await expect(page.locator('[data-yaade-mux-close-pane=""]').first()).toBeVisible()
  await expect(page.locator('[data-yaade-mux-split="right"]').first()).toBeVisible()
  await expect(page.locator('[data-yaade-mux-split="down"]').first()).toBeVisible()
})
