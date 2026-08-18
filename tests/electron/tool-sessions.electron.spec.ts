import fs from "node:fs"
import path from "node:path"
import { expect } from "@playwright/test"
import { test } from "../fixtures/e2e.js"
import { focusTerminal, pressMuxPrefix, pressShellPrefix } from "./_launch.js"

test("Session shell exposes only Terminal and Git tools", async ({ launchApp }) => {
  const { page } = await launchApp()
  await expect(page.locator('[data-yaade-shell="tool-session"]')).toBeVisible()
  await expect(page.locator('[data-yaade-running-agent-count]')).toHaveCount(0)
  const runningAgentsSidebar = page.getByRole("complementary", {
    name: "Running agents",
  })
  await expect(runningAgentsSidebar).toBeVisible()
  await expect(
    page.locator('[data-yaade-top-tabbar]').getByRole("button", {
      name: /Switch session/,
    }),
  ).toBeVisible()
  await expect(runningAgentsSidebar).not.toContainText("Agents")
  const agentSidebarResize = page.getByRole("separator", { name: "Resize agent sidebar" })
  await expect(agentSidebarResize).toHaveAttribute("aria-valuenow", "256")
  await agentSidebarResize.press("ArrowRight")
  await expect(agentSidebarResize).toHaveAttribute("aria-valuenow", "266")

  const sidebarToggle = page.getByRole("button", { name: "Hide sidebar" })
  await expect(sidebarToggle).toBeVisible()
  await sidebarToggle.click()
  await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible()
  await expect(runningAgentsSidebar).toBeHidden()
  await page.getByRole("button", { name: "Show sidebar" }).click()
  await expect(runningAgentsSidebar).toBeVisible()

  await pressMuxPrefix(page, "b")
  await expect(runningAgentsSidebar).toBeHidden()
  await pressMuxPrefix(page, "b")
  await expect(runningAgentsSidebar).toBeVisible()

  await pressShellPrefix(page)
  const hud = page.locator("[data-yaade-which-key]")
  await expect(hud).toContainText("New Terminal")
  await expect(hud).toContainText("New Git")
  await expect(hud).toContainText("Toggle sidebar")
  await expect(hud).not.toContainText("Search")
  await expect(hud).not.toContainText("Neovim")
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

  await page.locator('[data-yaade-empty-tool="terminal"]').click()
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

  await page.locator('[data-yaade-empty-tool="terminal"]').click()
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

test("split controls open the tool picker and place the selected tool", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  })
  await expect(page.locator('[data-yaade-shell="tool-session"]')).toBeVisible()

  await page.locator('[data-yaade-empty-tool="terminal"]').click()
  await expect(page.locator("[data-yaade-tool-tile]")).toHaveCount(1, {
    timeout: 30_000,
  })

  await page.locator('[data-yaade-mux-split="right"]').click()
  const picker = page.locator("[data-yaade-pane-tool-menu]")
  await expect(picker).toBeVisible()
  await expect(picker).not.toContainText("New tool")

  await picker.locator('[data-yaade-pane-new-tool-kind="terminal"]').click({ force: true })
  await expect(page.locator("[data-yaade-tool-tile]")).toHaveCount(2, {
    timeout: 30_000,
  })
  await expect(page.locator('[data-yaade-empty-tool-tile]')).toHaveCount(0)
})
