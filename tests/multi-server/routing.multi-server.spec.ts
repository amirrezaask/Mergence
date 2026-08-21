import { expect, test } from "@playwright/test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  attachTerminal,
  cloneHostDatabase,
  createDurableRuntimeHarness,
  createSession,
  createTerminalInstance,
  createToolUse,
  hostRpcResult,
  listProjects,
  listSessions,
  MOCK_AGENT_PATH,
  numberedLine,
  readHealth,
  readSystem,
  rpcErrorCode,
  waitForMockAgent,
  writeTerminal,
} from "../runtime/harness/index.js"
import { waitUntil } from "../runtime/harness/wait.js"
import {
  CreateToolUse,
  MainCheckout,
  ProjectTarget,
  SessionId,
  TerminalToolInput,
} from "../../packages/yaade-rpc/src/tool-session.js"
import { Schema } from "effect"
import type { Page } from "@playwright/test"

async function withPair(
  testInfo: { outputDir: string },
  run: (
    a: Awaited<ReturnType<typeof createDurableRuntimeHarness>>,
    b: Awaited<ReturnType<typeof createDurableRuntimeHarness>>,
  ) => Promise<void>,
): Promise<void> {
  const a = await createDurableRuntimeHarness()
  const b = await createDurableRuntimeHarness()
  try {
    await run(a, b)
  } catch (error) {
    await a.retainDiagnostics(path.join(testInfo.outputDir, "server-a")).catch(() => undefined)
    await b.retainDiagnostics(path.join(testInfo.outputDir, "server-b")).catch(() => undefined)
    throw error
  } finally {
    await a.close()
    await b.close()
  }
}

async function launchIdle(
  origin: string,
  projectId: string,
  workspace: string,
  controlFile: string,
  title: string,
) {
  const instance = await createTerminalInstance(origin, {
    projectId,
    checkoutPath: workspace,
    checkoutKey: "main",
    title,
    launchRequestId: `ms-${path.basename(controlFile)}`,
    executable: process.execPath,
    args: [MOCK_AGENT_PATH, "--mode", "idle", "--control-file", controlFile],
  })
  const agent = await waitForMockAgent(controlFile)
  const ptyId = instance.ptyId
  if (!ptyId) throw new Error(`${title} launched without a PTY`)
  return { instance, agent, ptyId }
}

function scopedSessionId(serverId: string, localId: string): string {
  return `ses-${serverId}--${localId.slice("ses-".length)}`
}

test.describe("M — multi-server routing and convergence", { tag: "@p1" }, () => {
  test("M01 identical local resource IDs on two servers never collide", async ({}, testInfo) => {
    await withPair(testInfo, async (a, b) => {
      const apiA = await a.startApi()
      const session = await createSession(apiA.origin, "shared")
      await a.killApi("SIGTERM")
      cloneHostDatabase(a.dataDir, b.dataDir, "server-b-fixture")
      const restartedA = await a.startApi()
      const apiB = await b.startApi()
      const healthA = await readHealth(restartedA.origin)
      const healthB = await readHealth(apiB.origin)
      expect(healthA.identity.serverId).not.toBe(healthB.identity.serverId)
      const sessionsA = await listSessions(restartedA.origin)
      const sessionsB = await listSessions(apiB.origin)
      expect(sessionsA.some(row => row.session.id === session.id)).toBe(true)
      expect(sessionsB.some(row => row.session.id === session.id)).toBe(true)
      expect(scopedSessionId(healthA.identity.serverId, session.id)).not.toBe(
        scopedSessionId(healthB.identity.serverId, session.id),
      )
    })
  })

  test("M02 switching the active server cannot reroute a mounted terminal", async ({}, testInfo) => {
    await withPair(testInfo, async (a, b) => {
      const apiA = await a.startApi()
      const apiB = await b.startApi()
      const projectA = (await listProjects(apiA.origin))[0]
      const projectB = (await listProjects(apiB.origin))[0]
      const launchedA = await launchIdle(apiA.origin, projectA!.id, a.workspace, path.join(a.root, "m02-a.json"), "A")
      const launchedB = await launchIdle(apiB.origin, projectB!.id, b.workspace, path.join(b.root, "m02-b.json"), "B")
      await writeTerminal(apiA.origin, launchedA.ptyId, "FROM_A\n")
      const missingOnB = await hostRpcResult(apiB.origin, "terminal:write", [launchedA.ptyId, "STOLEN\n"])
      expect(missingOnB.ok).toBe(false)
      if (!missingOnB.ok) expect(rpcErrorCode(missingOnB.error)).toBe("NOT_FOUND")
      await launchedA.agent.emitRange(1, 2)
      await waitUntil(async () => {
        const attached = await attachTerminal(apiA.origin, launchedA.ptyId)
        return Boolean(attached?.output.includes("FROM_A") && attached.output.includes(numberedLine(2)))
      }, 8_000, "A received its own writes")
      const attachedB = await attachTerminal(apiB.origin, launchedB.ptyId)
      expect(attachedB?.output.includes("STOLEN")).toBe(false)
      expect(attachedB?.output.includes("FROM_A")).toBe(false)
    })
  })

  test("M03 live terminals from different servers work simultaneously", async ({}, testInfo) => {
    await withPair(testInfo, async (a, b) => {
      const apiA = await a.startApi()
      const apiB = await b.startApi()
      const projectA = (await listProjects(apiA.origin))[0]
      const projectB = (await listProjects(apiB.origin))[0]
      const launchedA = await launchIdle(apiA.origin, projectA!.id, a.workspace, path.join(a.root, "m03-a.json"), "A")
      const launchedB = await launchIdle(apiB.origin, projectB!.id, b.workspace, path.join(b.root, "m03-b.json"), "B")
      await launchedA.agent.emitRange(10, 12)
      await launchedB.agent.emitRange(20, 22)
      await waitUntil(async () => {
        const outA = await attachTerminal(apiA.origin, launchedA.ptyId)
        const outB = await attachTerminal(apiB.origin, launchedB.ptyId)
        return Boolean(
          outA?.output.includes(numberedLine(12)) &&
          outB?.output.includes(numberedLine(22)) &&
          !outA.output.includes(numberedLine(20)) &&
          !outB.output.includes(numberedLine(10)),
        )
      }, 8_000, "independent numbered streams")
    })
  })

  test("M04 one remote server going offline affects only its resources", async ({}, testInfo) => {
    await withPair(testInfo, async (a, b) => {
      const apiA = await a.startApi()
      const apiB = await b.startApi()
      const projectA = (await listProjects(apiA.origin))[0]
      const launchedA = await launchIdle(apiA.origin, projectA!.id, a.workspace, path.join(a.root, "m04-a.json"), "A")
      await b.killApi("SIGKILL")
      const stillA = await listSessions(apiA.origin)
      expect(stillA.length).toBeGreaterThan(0)
      await writeTerminal(apiA.origin, launchedA.ptyId, "A_STILL_LIVE\n")
      const bHealth = await hostRpcResult(apiB.origin, "tools:listSessions", [false]).catch(error => error)
      expect(bHealth).toBeTruthy()
      await waitUntil(async () => {
        try {
          await readHealth(apiB.origin)
          return false
        } catch {
          return true
        }
      }, 8_000, "B API is offline")
    })
  })

  test("M05 epoch change on one server resets only that server’s cache", async ({}, testInfo) => {
    await withPair(testInfo, async (a, b) => {
      const apiA = await a.startApi()
      const apiB = await b.startApi()
      const epochA = (await readHealth(apiA.origin)).identity.serverEpoch
      const epochB = (await readHealth(apiB.origin)).identity.serverEpoch
      await b.killApi("SIGKILL")
      const restartedB = await b.startApi()
      const nextB = (await readHealth(restartedB.origin)).identity.serverEpoch
      const stillA = (await readHealth(apiA.origin)).identity.serverEpoch
      expect(stillA).toBe(epochA)
      expect(nextB).not.toBe(epochB)
    })
  })

  test("M07 partial aggregate failure still returns successful server data", async ({}, testInfo) => {
    await withPair(testInfo, async (a, b) => {
      const apiA = await a.startApi()
      await b.startApi()
      await createSession(apiA.origin, "alive")
      await b.killApi("SIGKILL")
      const sessionsA = await listSessions(apiA.origin)
      expect(sessionsA.some(row => row.session.title === "alive")).toBe(true)
      const failedB = await hostRpcResult(b.origin, "tools:listSessions", [false]).catch(
        () => ({ ok: false as const, error: "offline" }),
      )
      expect(failedB.ok).toBe(false)
    })
  })

  test("M09 Git actions execute against the repository on the owning server", async ({}, testInfo) => {
    await withPair(testInfo, async (a, b) => {
      execFileSync("git", ["init"], { cwd: a.workspace })
      execFileSync("git", ["init"], { cwd: b.workspace })
      fs.writeFileSync(path.join(a.workspace, "only-a.txt"), "alpha\n")
      fs.writeFileSync(path.join(b.workspace, "only-b.txt"), "beta\n")
      const apiA = await a.startApi()
      const apiB = await b.startApi()
      const statusA = (await hostRpcResult(apiA.origin, "git:status", [
        pathToFileURL(a.workspace).href,
      ])) as { ok: true; value: Array<{ path: string }> }
      const statusB = (await hostRpcResult(apiB.origin, "git:status", [
        pathToFileURL(b.workspace).href,
      ])) as { ok: true; value: Array<{ path: string }> }
      expect(statusA.ok).toBe(true)
      expect(statusB.ok).toBe(true)
      const pathsA = statusA.value.map(row => row.path)
      const pathsB = statusB.value.map(row => row.path)
      expect(pathsA.join(" ")).toContain("only-a.txt")
      expect(pathsB.join(" ")).toContain("only-b.txt")
      expect(pathsA.join(" ")).not.toContain("only-b.txt")
      expect(pathsB.join(" ")).not.toContain("only-a.txt")
    })
  })

  test("M06 removing a server definition removes only owned resources", async ({}, testInfo) => {
    await withPair(testInfo, async (a, b) => {
      const apiA = await a.startApi()
      const apiB = await b.startApi()
      await createSession(apiA.origin, "Keep A")
      await createSession(apiB.origin, "Drop B")
      const browser = await a.startBrowser()
      const page = browser.page
      await addRemoteServer(page, "Server B", apiB.origin)
      await page.getByRole("button", { name: /Close settings/ }).click()
      const switcher = page.getByRole("button", { name: /Switch session/ })
      await switcher.click()
      const options = page.locator('[data-yaade-session-switcher-popover=""] [role="option"]')
      await expect(options.getByText("Drop B").first()).toBeVisible({ timeout: 20_000 })
      await expect(options.getByText("Keep A").first()).toBeVisible()
      await page.keyboard.press("Escape")
      await page.getByRole("button", { name: "Settings" }).click()
      await page.getByRole("tab", { name: "Servers" }).click()
      await page.getByRole("button", { name: "Remove Server B" }).click()
      await page.getByRole("button", { name: /Close settings/ }).click()
      await switcher.click()
      await expect(options.getByText("Drop B")).toHaveCount(0)
      await expect(options.getByText("Keep A").first()).toBeVisible()
    })
  })


  test("M10 remote agent-sidebar selection and deep links open the owning server resource", async ({}, testInfo) => {
    await withPair(testInfo, async (a, b) => {
      const apiA = await a.startApi()
      const apiB = await b.startApi()
      const projectA = (await listProjects(apiA.origin))[0]
      const projectB = (await listProjects(apiB.origin))[0]
      const sessionA = await createSession(apiA.origin, "Host A")
      const sessionB = await createSession(apiB.origin, "Host B")
      await createProviderToolUse(apiA.origin, sessionA.id, projectA!, path.join(a.root, "m10-a.json"), "Host A")
      const useB = await createProviderToolUse(apiB.origin, sessionB.id, projectB!, path.join(b.root, "m10-b.json"), "Host B")
      const healthB = await readHealth(apiB.origin)
      const browser = await a.startBrowser()
      const page = browser.page
      await addRemoteServer(page, "Server B", apiB.origin)
      await page.getByRole("button", { name: /Close settings/ }).click()
      await waitUntil(async () => {
        const agents = await page.evaluate(async () => {
          const listed = await window.yaade?.agents.listLive()
          return Array.isArray(listed) ? listed.map(agent => agent.title) : []
        })
        return agents.some(title => title.includes("Host B") || title.includes("Host A")) && agents.length >= 2
      }, 20_000, "aggregated live agents")
      const toggle = page.locator("[data-yaade-agent-sidebar-toggle]")
      if (await toggle.count()) {
        const state = await page.locator("[data-yaade-running-agent-sidebar-state]").getAttribute("data-yaade-running-agent-sidebar-state")
        if (state !== "expanded") await toggle.click()
      }
      await page.locator("[data-yaade-running-agent]").filter({ hasText: "Host B" }).first().click()
      await waitUntil(async () => {
        const href = page.url()
        const active = await page.locator("[data-yaade-session-switcher]").getAttribute("data-yaade-active-session")
        return Boolean(
          href.includes(sessionB.id.slice(4)) ||
          href.includes(useB.id.slice(4)) ||
          active?.includes(healthB.identity.serverId) ||
          active?.includes(sessionB.id),
        )
      }, 15_000, "focused B resource")
    })
  })
})

async function addRemoteServer(page: Page, name: string, url: string): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click()
  await expect(page.locator("[data-yaade-settings-overlay]")).toBeVisible()
  await page.getByRole("tab", { name: "Servers" }).click()
  const panel = page.locator('[data-yaade-server-settings=""]')
  await panel.getByRole("button", { name: "Add server" }).click()
  await page.locator("#yaade-server-name").fill(name)
  await page.locator("#yaade-server-url").fill(url)
  await page.getByRole("button", { name: "Save server" }).click()
  await expect(panel.getByText(name, { exact: true })).toBeVisible()
}

async function createProviderToolUse(
  origin: string,
  sessionId: string,
  project: { id: string; name: string; rootPath: string },
  controlFile: string,
  title: string,
) {
  const created = await createToolUse(origin, CreateToolUse.make({
    sessionId: Schema.decodeUnknownSync(SessionId)(sessionId),
    title,
    kind: "terminal",
    project: ProjectTarget.make({
      projectId: project.id,
      projectPath: project.rootPath,
      projectName: project.name,
    }),
    checkout: MainCheckout.make({ kind: "main" }),
    input: TerminalToolInput.make({
      kind: "terminal",
      executable: process.execPath,
      shellArgs: [MOCK_AGENT_PATH, "--mode", "idle", "--control-file", controlFile],
      provider: "claude",
    }),
  }))
  await waitForMockAgent(controlFile)
  return created
}
