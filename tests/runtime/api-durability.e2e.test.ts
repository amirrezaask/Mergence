import { expect, test } from "@playwright/test"
import path from "node:path"
import { Schema } from "effect"
import {
  CreateToolUse,
  MainCheckout,
  ProjectTarget,
  SessionId,
  TerminalToolInput,
} from "../../packages/yaade-rpc/src/tool-session.js"
import {
  archiveSession,
  attachTerminal,
  countMatchingProcesses,
  createDurableRuntimeHarness,
  createSession,
  createTerminalInstance,
  createToolUse,
  listProjects,
  listSessions,
  MOCK_AGENT_PATH,
  numberedLine,
  numberedLinesPresentOnce,
  waitForMockAgent,
  waitForAttach,
  writeTerminal,
} from "./harness/index.js"
import { waitUntil } from "./harness/wait.js"
import { localResourceKey } from "../../packages/yaade-app/src/tools/tool-session-routing.js"

function toolSessionPath(sessionId: string, toolUseId: string, tabId?: string): string {
  const params = new URLSearchParams({ s: sessionId, u: toolUseId })
  if (tabId) params.set("t", tabId)
  return `/?${params.toString()}`
}

async function expectNamedSession(page: { url(): string }, sessionId: string): Promise<void> {
  await expect
    .poll(() => {
      const selected = new URL(page.url()).searchParams.get("s") ?? ""
      return localResourceKey(selected)
    })
    .toBe(localResourceKey(sessionId))
}

async function withHarness(
  testInfo: { outputDir: string },
  run: (harness: Awaited<ReturnType<typeof createDurableRuntimeHarness>>) => Promise<void>,
  options?: { env?: Record<string, string> },
): Promise<void> {
  const harness = await createDurableRuntimeHarness(options)
  try {
    await run(harness)
  } catch (error) {
    await harness.retainDiagnostics(path.join(testInfo.outputDir, "runtime")).catch(() => undefined)
    throw error
  } finally {
    await harness.close()
  }
}

test.describe("A — browser/API detach and convergence", { tag: "@p0" }, () => {
  test("A01 closing the last browser detaches without terminating the agent", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const projects = await listProjects(api.origin)
      const project = projects[0]
      expect(project).toBeTruthy()
      const session = await createSession(api.origin, "A01")
      const controlFile = path.join(harness.root, "a01-control.json")
      const created = await createToolUse(
        api.origin,
        CreateToolUse.make({
          sessionId: Schema.decodeUnknownSync(SessionId)(session.id),
          kind: "terminal",
          title: "mock-agent",
          project: ProjectTarget.make({
            projectId: project!.id,
            projectPath: project!.rootPath,
            projectName: project!.name,
          }),
          checkout: MainCheckout.make({ kind: "main" }),
          input: TerminalToolInput.make({
            kind: "terminal",
            executable: process.execPath,
            shellArgs: [MOCK_AGENT_PATH, "--mode", "idle", "--control-file", controlFile],
          }),
        }),
      )
      const agent = await waitForMockAgent(controlFile)
      const identity = await harness.readProcessIdentity(agent.pid)
      const ptyId = created.output.ptyId
      expect(ptyId).toBeTruthy()
      const startPath = `/?s=${encodeURIComponent(session.id)}${created.tabId ? `&t=${encodeURIComponent(created.tabId)}` : ""}&u=${encodeURIComponent(created.id)}`

      const browser = await harness.startBrowser(undefined, startPath)
      await expect(browser.page.locator("[data-yaade-terminal-panel]")).toBeVisible({ timeout: 30_000 })
      await agent.emitRange(1, 3)
      await expect
        .poll(
          () => browser.page.evaluate(id => window.__yaadeAgent?.getTerminalText?.(id) ?? "", created.id),
          { timeout: 15_000 },
        )
        .toContain(numberedLine(1))
      await browser.close()

      await agent.emitRange(4, 8)
      await harness.assertProcessAlive(identity)
      expect(countMatchingProcesses(controlFile)).toBe(1)

      const again = await harness.startBrowser(undefined, startPath)
      await expect(again.page.locator("[data-yaade-terminal-panel]")).toBeVisible({ timeout: 30_000 })
      await expect
        .poll(async () => {
          const text = await again.page.evaluate(id => window.__yaadeAgent?.getTerminalText?.(id) ?? "", created.id)
          const present = numberedLinesPresentOnce(text, 1, 8)
          return present.missing.length === 0 && present.duplicated.length === 0
        }, { timeout: 20_000 })
        .toBe(true)

      const db = await harness.readDatabaseState()
      expect(db.terminalInstances.some(item => item.pty_id === ptyId)).toBe(true)
      await harness.assertProcessAlive(identity)
      expect(countMatchingProcesses(controlFile)).toBe(1)
    })
  })

  test("A04 graceful API SIGTERM does not terminate supervisor-owned PTYs", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      await harness.startApi()
      const launched = await harness.launchMockAgent()
      const ptyId = launched.instance.ptyId
      expect(ptyId).toBeTruthy()
      await launched.agent.emitRange(1, 2)
      await harness.killApi("SIGTERM")
      await launched.agent.emitRange(3, 5)
      await harness.assertProcessAlive(launched.processIdentity)
      const restarted = await harness.startApi()
      await harness.assertProcessAlive(launched.processIdentity)
      const attached = await waitForAttach(restarted.origin, ptyId!, 8_000)
      expect(attached.status).toBe("running")
      expect(numberedLinesPresentOnce(attached.output, 1, 5).missing).toEqual([])
    })
  })

  test("A05 forced API SIGKILL does not terminate supervisor-owned PTYs", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      await harness.startApi()
      const launched = await harness.launchMockAgent()
      const ptyId = launched.instance.ptyId
      expect(ptyId).toBeTruthy()
      await harness.killApi("SIGKILL")
      await launched.agent.emitRange(10, 12)
      await harness.assertProcessAlive(launched.processIdentity)
      const restarted = await harness.startApi()
      const attached = await waitForAttach(restarted.origin, ptyId!)
      expect(attached.status).toBe("running")
      await harness.assertProcessAlive(launched.processIdentity)
      await waitUntil(async () => {
        const snapshot = await attachTerminal(restarted.origin, ptyId!)
        return numberedLinesPresentOnce(snapshot?.output ?? "", 10, 12).missing.length === 0
      }, 10_000, "A05 offline numbered output")
      const present = numberedLinesPresentOnce(
        (await attachTerminal(restarted.origin, ptyId!))?.output ?? "",
        10,
        12,
      )
      expect(present.missing, `missing ${present.missing.join(",")} output=${attached.output}`).toEqual([])
    })
  })

  test("A06 output produced while no API process exists is replayed after restart", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      await harness.startApi()
      const launched = await harness.launchMockAgent()
      const ptyId = launched.instance.ptyId
      expect(ptyId).toBeTruthy()
      await harness.killApi("SIGKILL")
      await launched.agent.emitRange(20, 29)
      await harness.assertProcessAlive(launched.processIdentity)
      const restarted = await harness.startApi()
      const attached = await waitForAttach(restarted.origin, ptyId!)
      expect(attached.status).toBe("running")
      await waitUntil(async () => {
        const snapshot = await attachTerminal(restarted.origin, ptyId!)
        return numberedLinesPresentOnce(snapshot?.output ?? "", 20, 29).missing.length === 0
      }, 10_000, "A06 offline numbered output")
      const present = numberedLinesPresentOnce(
        (await attachTerminal(restarted.origin, ptyId!))?.output ?? "",
        20,
        29,
      )
      expect(present.missing, `missing ${present.missing.join(",")}`).toEqual([])
      expect(present.duplicated).toEqual([])
      await harness.assertProcessAlive(launched.processIdentity)
    })
  })

  test("A07 API restart changes serverEpoch and resets the client cursor", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const first = await harness.startApi()
      const launched = await harness.launchMockAgent()
      const oldEpoch = (await harness.readRuntimeSnapshot()).identity.serverEpoch
      const storage = path.join(harness.root, "browser-a07")
      const browser = await harness.startBrowser(storage)
      await expect(browser.page.locator('[data-yaade-shell="tool-session"]')).toBeVisible({
        timeout: 30_000,
      })
      await launched.agent.emitRange(1, 2)
      await harness.killApi("SIGTERM")
      const restarted = await harness.startApi()
      const newEpoch = (await harness.readRuntimeSnapshot()).identity.serverEpoch
      expect(newEpoch).not.toBe(oldEpoch)
      expect(restarted.origin).toBe(first.origin)
      await browser.page.reload({ waitUntil: "domcontentloaded" })
      await browser.page.waitForFunction(() => window.__yaadeAgent != null, null, { timeout: 30_000 })
      await browser.page.evaluate(() => window.__yaadeAgent!.waitForReady())
      const epochInPage = await browser.page.evaluate(async () => {
        const response = await fetch("/health")
        const body = (await response.json()) as { identity?: { serverEpoch?: string } }
        return body.identity?.serverEpoch ?? ""
      })
      expect(epochInPage).toBe(newEpoch)
      await launched.agent.emitRange(30, 31)
      await waitUntil(async () => {
        const attached = await attachTerminal(restarted.origin, launched.instance.ptyId ?? "")
        return (attached?.output ?? "").includes(numberedLine(30))
      }, 15_000, "post-restart numbered output")
    })
  })

  test("A02 reload during continuous output loses and duplicates no terminal frames", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      const projects = await listProjects(api.origin)
      const session = await createSession(api.origin, "A02")
      const controlFile = path.join(harness.root, "a02-control.json")
      const created = await createToolUse(
        api.origin,
        CreateToolUse.make({
          sessionId: Schema.decodeUnknownSync(SessionId)(session.id),
          kind: "terminal",
          title: "mock-agent",
          project: ProjectTarget.make({
            projectId: projects[0]!.id,
            projectPath: projects[0]!.rootPath,
            projectName: projects[0]!.name,
          }),
          checkout: MainCheckout.make({ kind: "main" }),
          input: TerminalToolInput.make({
            kind: "terminal",
            executable: process.execPath,
            shellArgs: [MOCK_AGENT_PATH, "--mode", "idle", "--control-file", controlFile],
          }),
        }),
      )
      const agent = await waitForMockAgent(controlFile)
      const ptyId = created.output.ptyId
      expect(ptyId).toBeTruthy()
      const browser = await harness.startBrowser(
        undefined,
        toolSessionPath(session.id, created.id, created.tabId),
      )
      await expect(browser.page.locator("[data-yaade-terminal-panel]")).toBeVisible({ timeout: 30_000 })
      await expectNamedSession(browser.page, session.id)
      await expect
        .poll(async () => {
          const text = await browser.page.evaluate(
            id => window.__yaadeAgent?.getTerminalText?.(id) ?? "",
            created.tabId ?? created.id,
          )
          return text.includes("YAADE_MOCK_AGENT_READY")
        }, { timeout: 20_000 })
        .toBe(true)
      await agent.startNumbered(1, 40)
      await expect
        .poll(async () => {
          const text = await browser.page.evaluate(
            id => window.__yaadeAgent?.getTerminalText?.(id) ?? "",
            created.tabId ?? created.id,
          )
          return numberedLinesPresentOnce(text, 1, 5).missing.length === 0
        }, { timeout: 20_000 })
        .toBe(true)
      await browser.page.reload({ waitUntil: "domcontentloaded" })
      await browser.page.waitForFunction(() => window.__yaadeAgent != null, null, { timeout: 30_000 })
      await browser.page.evaluate(() => window.__yaadeAgent!.waitForReady())
      await expectNamedSession(browser.page, session.id)
      await expect(browser.page.locator("[data-yaade-terminal-panel]")).toBeVisible({ timeout: 30_000 })
      await waitUntil(async () => {
        const attached = await attachTerminal(api.origin, ptyId!)
        return numberedLinesPresentOnce(attached?.output ?? "", 1, 40).missing.length === 0
      }, 20_000, "numbered range emitted")
      await agent.stopNumbered()
      await expect
        .poll(async () => {
          const text = await browser.page.evaluate(
            id => window.__yaadeAgent?.getTerminalText?.(id) ?? "",
            created.tabId ?? created.id,
          )
          const present = numberedLinesPresentOnce(text, 1, 40)
          return present.missing.length === 0 && present.duplicated.length === 0
        }, { timeout: 25_000 })
        .toBe(true)
    })
  })

  test("A03 browser offline/online reconverges from snapshot plus terminal replay", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      const projects = await listProjects(api.origin)
      const session = await createSession(api.origin, "A03")
      const controlFile = path.join(harness.root, "a03-control.json")
      const created = await createToolUse(
        api.origin,
        CreateToolUse.make({
          sessionId: Schema.decodeUnknownSync(SessionId)(session.id),
          kind: "terminal",
          title: "mock-agent",
          project: ProjectTarget.make({
            projectId: projects[0]!.id,
            projectPath: projects[0]!.rootPath,
            projectName: projects[0]!.name,
          }),
          checkout: MainCheckout.make({ kind: "main" }),
          input: TerminalToolInput.make({
            kind: "terminal",
            executable: process.execPath,
            shellArgs: [MOCK_AGENT_PATH, "--mode", "idle", "--control-file", controlFile],
          }),
        }),
      )
      const agent = await waitForMockAgent(controlFile)
      const browser = await harness.startBrowser(
        undefined,
        toolSessionPath(session.id, created.id, created.tabId),
      )
      await expect(browser.page.locator("[data-yaade-terminal-panel]")).toBeVisible({ timeout: 30_000 })
      await expectNamedSession(browser.page, session.id)
      await expect
        .poll(async () => {
          const text = await browser.page.evaluate(
            id => window.__yaadeAgent?.getTerminalText?.(id) ?? "",
            created.tabId ?? created.id,
          )
          return text.includes("YAADE_MOCK_AGENT_READY")
        }, { timeout: 20_000 })
        .toBe(true)
      await agent.emitRange(1, 3)
      await expect
        .poll(async () => {
          const text = await browser.page.evaluate(
            id => window.__yaadeAgent?.getTerminalText?.(id) ?? "",
            created.tabId ?? created.id,
          )
          return numberedLinesPresentOnce(text, 1, 3).missing.length === 0
        }, { timeout: 15_000 })
        .toBe(true)
      await browser.context.setOffline(true)
      await agent.emitRange(4, 10)
      await browser.context.setOffline(false)
      await browser.page.evaluate(
        () =>
          new Promise<void>(resolve => {
            const finish = () => resolve()
            window.addEventListener("yaade:host-reconnected", finish, { once: true })
            window.setTimeout(finish, 8_000)
          }),
      )
      await expect(browser.page.locator("[data-yaade-terminal-panel]")).toBeVisible({ timeout: 30_000 })
      await expect
        .poll(async () => {
          const text = await browser.page.evaluate(
            id => window.__yaadeAgent?.getTerminalText?.(id) ?? "",
            created.tabId ?? created.id,
          )
          const present = numberedLinesPresentOnce(text, 1, 10)
          return present.missing.length === 0 && present.duplicated.length === 0
        }, { timeout: 25_000 })
        .toBe(true)
      expect(countMatchingProcesses(controlFile)).toBe(1)
    })
  })

  test("A08 a replay gap forces authoritative resynchronization", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      for (let index = 0; index < 12; index += 1) {
        await createSession(api.origin, `A08-${index}`)
      }
      const messages: Array<{ channel?: string }> = []
      const socket = new WebSocket(`${api.origin.replace("http", "ws")}/ws?since=1`)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("replay-gap websocket timed out")), 10_000)
        socket.addEventListener("message", event => {
          const payload = JSON.parse(String(event.data)) as { channel?: string }
          messages.push(payload)
          if (payload.channel === "protocol:replay-gap" || messages.length >= 20) {
            clearTimeout(timeout)
            socket.close()
            resolve()
          }
        })
        socket.addEventListener("error", () => {
          clearTimeout(timeout)
          reject(new Error("replay-gap websocket error"))
        })
      })
      expect(messages.some(item => item.channel === "protocol:replay-gap")).toBe(true)
    }, { env: { JET_EVENT_HUB_CAPACITY: "4" } })
  })

  test("A09 snapshot replacement removes stale entities", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      const kept = await createSession(api.origin, "A09-kept")
      const removed = await createSession(api.origin, "A09-removed")
      const storage = path.join(harness.root, "browser-a09")
      const browser = await harness.startBrowser(storage)
      await expect(browser.page.locator('[data-yaade-shell="tool-session"]')).toBeVisible({
        timeout: 30_000,
      })
      await archiveSession(api.origin, removed.id, "keep-running")
      await browser.page.reload({ waitUntil: "domcontentloaded" })
      await browser.page.waitForFunction(() => window.__yaadeAgent != null, null, { timeout: 30_000 })
      await browser.page.evaluate(() => window.__yaadeAgent!.waitForReady())
      const listed = await listSessions(api.origin)
      expect(listed.some(item => item.session.id === kept.id)).toBe(true)
      expect(listed.some(item => item.session.id === removed.id)).toBe(false)
      await expect
        .poll(async () => {
          const ids = await browser.page.evaluate(() => {
            const sessions = window.__yaadeAgent?.getState().sessions ?? []
            return sessions.flatMap(session => {
              if (!session || typeof session !== "object" || !("id" in session)) return []
              const id = session.id
              return typeof id === "string" ? [id] : []
            })
          })
          return ids.includes(kept.id) && !ids.includes(removed.id)
        }, { timeout: 15_000 })
        .toBe(true)
    })
  })

  test("A10 repeated API restarts remain idempotent", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      await harness.startApi()
      const launched = await harness.launchMockAgent()
      const ptyId = launched.instance.ptyId
      expect(ptyId).toBeTruthy()
      for (let cycle = 0; cycle < 10; cycle += 1) {
        await launched.agent.emitRange(cycle * 2 + 1, cycle * 2 + 2)
        await harness.killApi("SIGKILL")
        await harness.startApi()
        await harness.assertProcessAlive(launched.processIdentity)
      }
      const attached = await waitForAttach(harness.origin, ptyId!)
      expect(attached.status).toBe("running")
      expect(countMatchingProcesses(launched.agent.controlFile)).toBe(1)
      const db = await harness.readDatabaseState()
      const rows = db.terminalInstances.filter(item => item.pty_id === ptyId)
      expect(rows.length).toBe(1)
    })
  })

  test("A11 hot terminal commands around API restart are deterministic", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      const launched = await harness.launchMockAgent({ extraArgs: ["--echo"] })
      const ptyId = launched.instance.ptyId
      expect(ptyId).toBeTruthy()
      await waitForAttach(api.origin, ptyId!)
      await writeTerminal(api.origin, ptyId!, "before\r")
      const during = writeTerminal(api.origin, ptyId!, "during\r").then(
        () => "ok" as const,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      await harness.killApi("SIGKILL")
      const duringResult = await during
      expect(duringResult === "ok" || /failed|ECONNREFUSED|fetch|SUPERVISOR|disconnect/i.test(duringResult)).toBe(true)
      const restarted = await harness.startApi()
      await waitForAttach(restarted.origin, ptyId!)
      await writeTerminal(restarted.origin, ptyId!, "after\r")
      await waitUntil(async () => {
        const attached = await attachTerminal(restarted.origin, ptyId!)
        return (attached?.output ?? "").includes("after") || (attached?.status === "running")
      }, 10_000, "post-restart write accepted")
      await harness.assertProcessAlive(launched.processIdentity)
    })
  })

  test("A12 in-flight terminal creation is idempotent across API failure", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      const projects = await listProjects(api.origin)
      const launchRequestId = "a12-stable-launch"
      const controlFile = path.join(harness.root, "a12.json")
      const createOnce = createTerminalInstance(api.origin, {
        projectId: projects[0]!.id,
        checkoutPath: harness.workspace,
        checkoutKey: "main",
        title: "mock-agent",
        launchRequestId,
        executable: process.execPath,
        args: [MOCK_AGENT_PATH, "--mode", "idle", "--control-file", controlFile],
      })
      await Promise.race([
        createOnce,
        new Promise(resolve => setTimeout(resolve, 40)),
      ])
      await harness.killApi("SIGKILL")
      await createOnce.catch(() => undefined)
      const restarted = await harness.startApi()
      const retried = await createTerminalInstance(restarted.origin, {
        projectId: projects[0]!.id,
        checkoutPath: harness.workspace,
        checkoutKey: "main",
        title: "mock-agent",
        launchRequestId,
        executable: process.execPath,
        args: [MOCK_AGENT_PATH, "--mode", "idle", "--control-file", controlFile],
      })
      expect(retried.ptyId).toBeTruthy()
      expect(countMatchingProcesses(controlFile)).toBe(1)
      const instances = (await harness.readDatabaseState()).terminalInstances.filter(
        item => item.launch_request_id === launchRequestId,
      )
      expect(instances.length).toBe(1)
    })
  })
})
