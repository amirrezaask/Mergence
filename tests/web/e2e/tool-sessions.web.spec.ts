import fs from "node:fs"
import path from "node:path"
import { expect } from "@playwright/test"
import { test } from "../../fixtures/e2e.js"
import { focusTerminal } from "./_launch.js"

test("Session shell exposes only Terminal", async ({ launchApp }) => {
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

  await expect(page.getByText("New Git", { exact: true })).toHaveCount(0)
  await expect(page.locator("[data-yaade-which-key]")).toHaveCount(0)
})

test("session switcher creates and archives a session", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  })
  const switcher = page.getByRole("button", { name: /Switch session/ })
  await expect(page.locator("[data-yaade-tool-tile]")).toHaveCount(1, {
    timeout: 30_000,
  })

  await switcher.click()
  const popover = page.locator('[data-yaade-session-switcher-popover=""]')
  await expect(popover).toBeVisible()
  const newSessionButton = popover.locator('[data-yaade-new-session=""]')
  await expect(newSessionButton).toBeVisible()
  await newSessionButton.focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("button", { name: "Switch session, current New session" }),
  ).toBeVisible({ timeout: 30_000 })

  await page.getByRole("button", { name: /Switch session/ }).click()
  await popover.getByRole("button", { name: "Close New session" }).click()
  await expect(page.getByRole("dialog", { name: "Close session?" })).toBeVisible()
  await page.getByRole("button", { name: "Stop tools and archive" }).click()
  await expect(
    page.getByRole("button", { name: "Switch session, current Session 1" }),
  ).toBeVisible({ timeout: 30_000 })
})

test("terminal output is replayed after a browser reload", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  })
  const marker = "YAADE_DURABLE_REPLAY"

  await focusTerminal(page)
  await page.keyboard.type(`printf '${marker}\\n'`)
  await page.keyboard.press("Enter")

  const terminalText = () =>
    page.evaluate(() => {
      const id = window.__yaadeAgent?.getState().activeToolUseId
      return id ? window.__yaadeAgent?.getTerminalText?.(id) ?? "" : ""
    })
  await expect.poll(terminalText, { timeout: 15_000 }).toContain(marker)

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator('[data-yaade-shell="tool-session"]')).toBeVisible()
  await page.evaluate(() => window.__yaadeAgent!.waitForReady())
  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible()
  await expect.poll(terminalText, { timeout: 15_000 }).toContain(marker)
})

test("Windows and pane state survive a browser reload", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  })
  const windowTabs = page.locator("[data-yaade-window-tabs] [data-yaade-session-tab]")

  await expect(windowTabs).toHaveCount(1)
  await page.getByRole("button", { name: "New tab" }).click()
  await expect(windowTabs).toHaveCount(2)
  await expect(page.locator("[data-yaade-tool-tile]")).toHaveCount(1, {
    timeout: 30_000,
  })

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator('[data-yaade-shell="tool-session"]')).toBeVisible()
  await page.evaluate(() => window.__yaadeAgent!.waitForReady())
  await expect(windowTabs).toHaveCount(2)
  await expect(page.locator("[data-yaade-tool-tile]")).toHaveCount(1, {
    timeout: 30_000,
  })
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

test("mobile Terminal exposes accessory keys and keeps its surface mounted", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
    mobile: true,
  })
  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible({
    timeout: 30_000,
  })
  await page.evaluate(() => {
    localStorage.removeItem("yaade:last-tool-session-route")
    history.pushState(null, "", "/")
    window.dispatchEvent(new Event("popstate"))
  })
  const session = page.locator("[data-yaade-mobile-session-group]").first()
  await expect(session).toBeVisible()

  await session.locator("[data-yaade-mobile-new-tool]").first().click()
  await page.locator('[data-yaade-mobile-new-tool-kind="terminal"]').click()
  await expect(page.locator('[data-yaade-mobile-tool-detail=""]')).toBeVisible({
    timeout: 30_000,
  })
  await expect(
    page.locator(
      '[data-yaade-mobile-retained-terminal][data-active="true"] [data-yaade-terminal-panel]',
    ),
  ).toBeVisible({ timeout: 30_000 })

  const keys = page.locator("[data-yaade-mobile-terminal-keys]")
  await expect(keys).toBeVisible()
  const ctrl = keys.getByRole("button", { name: "Ctrl", exact: true })
  await ctrl.click()
  await expect(ctrl).toHaveAttribute("aria-pressed", "true")
  await keys.getByRole("button", { name: "Arrow left", exact: true }).click()
  await expect(ctrl).toHaveAttribute("aria-pressed", "false")

  await page.getByRole("button", { name: "Back to tools" }).click()
  await expect(page.locator('[data-yaade-mobile-shell][data-yaade-mobile-view="tools"]')).toBeVisible()
  await expect(
    page.locator(`[data-yaade-mobile-tool][data-tool-kind="terminal"]`),
  ).toHaveCount(2)
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

test("closing Settings returns keyboard focus to the terminal", async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  })
  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible()
  await focusTerminal(page)
  await page.getByRole("button", { name: "Settings" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          document.activeElement?.closest("[data-ghostty-terminal-input]"),
        ),
      ),
    )
    .toBe(true)
})
