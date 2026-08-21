import { expect, test } from "@playwright/test"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  attachTerminal,
  closeTerminalInstance,
  createDurableRuntimeHarness,
  createTerminalInstance,
  listProjects,
  listTerminalInstances,
  MOCK_AGENT_PATH,
  processRssBytes,
  waitForMockAgent,
} from "../runtime/harness/index.js"
import { waitUntil } from "../runtime/harness/wait.js"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(path.join(REPO_ROOT, "packages/yaade-host-server/src/server.ts"))
const WsClient = require("ws") as typeof import("ws")

async function withHarness(
  testInfo: { outputDir: string },
  run: (harness: Awaited<ReturnType<typeof createDurableRuntimeHarness>>) => Promise<void>,
): Promise<void> {
  const harness = await createDurableRuntimeHarness()
  try {
    await run(harness)
  } catch (error) {
    await harness.retainDiagnostics(testInfo.outputDir).catch(() => undefined)
    throw error
  } finally {
    await harness.close()
  }
}

test.describe("C — chaos", { tag: "@p2" }, () => {
  test("C02 repeated API kill and browser reconnect converges", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const launched = await harness.launchMockAgent({ mode: "numbered", from: 1, intervalMs: 20 })
      const browser = await harness.startBrowser()
      await browser.page.waitForFunction(() => window.__yaadeAgent != null, null, { timeout: 30_000 })
      const identity = launched.processIdentity
      const projectId = launched.instance.projectId
      for (let i = 0; i < 3; i += 1) {
        await harness.killApi("SIGKILL")
        await harness.restartApi()
        await harness.assertProcessAlive(identity)
        await browser.page.reload({ waitUntil: "domcontentloaded" })
        await browser.page.waitForFunction(() => window.__yaadeAgent != null, null, { timeout: 30_000 })
        await waitUntil(async () => {
          const instances = await listTerminalInstances(harness.origin, projectId)
          return instances.some(row => row.ptyId === launched.instance.ptyId && row.processState === "running")
        }, 15_000, "terminal still running after restart")
      }
      const instances = await listTerminalInstances(harness.origin, projectId)
      expect(
        instances.filter(row => row.ptyId === launched.instance.ptyId && row.processState === "running"),
      ).toHaveLength(1)
      await harness.assertProcessAlive(identity)
    })
  })

  test("C03 slow-client flood does not block a healthy client", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const launched = await harness.launchMockAgent({ mode: "flood" })
      const slow = new WsClient(`${api.origin.replace(/^http/, "ws")}/ws?protocol=2`)
      const slowClosed = new Promise<number>(resolve => {
        slow.once("close", (code: number) => resolve(code))
      })
      await new Promise<void>((resolve, reject) => {
        slow.once("open", () => resolve())
        slow.once("error", error => reject(error instanceof Error ? error : new Error("slow websocket failed")))
      })
      const socket = (slow as unknown as { _socket?: { pause?: () => void } })._socket
      socket?.pause?.()
      await launched.agent.emitText("YAADE_FLOOD ".repeat(8_192))
      await launched.agent.emitRange(1, 200)
      const healthy = await attachTerminal(api.origin, launched.instance.ptyId ?? "")
      expect(healthy?.status).toBe("running")
      const health = await fetch(`${api.origin}/health`)
      expect(health.ok).toBe(true)
      const closed = await Promise.race([
        slowClosed,
        new Promise<number>(resolve => setTimeout(() => resolve(0), 8_000)),
      ])
      if (closed !== 0) expect(closed).toBe(1013)
      slow.terminate()
    })
  })

  test("C04 multi-server network isolation", async ({}, testInfo) => {
    const a = await createDurableRuntimeHarness()
    const b = await createDurableRuntimeHarness()
    try {
      await a.startApi()
      await b.startApi()
      await a.startSupervisor()
      await b.startSupervisor()
      const aAgent = await a.launchMockAgent({ mode: "idle" })
      const bAgent = await b.launchMockAgent({ mode: "idle" })
      await b.killApi("SIGKILL")
      await a.assertProcessAlive(aAgent.processIdentity)
      const aHealth = await fetch(`${a.origin}/health`)
      expect(aHealth.ok).toBe(true)
      await waitUntil(async () => {
        try {
          const response = await fetch(`${b.origin}/health`)
          return !response.ok
        } catch {
          return true
        }
      }, 8_000, "server B offline after kill")
      await b.restartApi()
      await waitUntil(async () => {
        const response = await fetch(`${b.origin}/health`)
        return response.ok
      }, 15_000, "server B health after restart")
      await b.assertProcessAlive(bAgent.processIdentity)
    } catch (error) {
      await a.retainDiagnostics(path.join(testInfo.outputDir, "a")).catch(() => undefined)
      await b.retainDiagnostics(path.join(testInfo.outputDir, "b")).catch(() => undefined)
      throw error
    } finally {
      await a.close()
      await b.close()
    }
  })

  test("C05 create/dispose churn returns to expected process bounds", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]
      expect(project).toBeTruthy()
      const before = processRssBytes(api.pid)
      for (let i = 0; i < 8; i += 1) {
        const controlFile = path.join(harness.root, `churn-${i}.json`)
        const instance = await createTerminalInstance(api.origin, {
          projectId: project!.id,
          checkoutPath: project!.rootPath,
          checkoutKey: "main",
          title: `churn-${i}`,
          launchRequestId: `churn-${i}`,
          executable: process.execPath,
          args: [MOCK_AGENT_PATH, "--mode", "idle", "--control-file", controlFile],
        })
        await waitForMockAgent(controlFile)
        await closeTerminalInstance(api.origin, instance.id, instance.generation)
        await waitUntil(
          async () => {
            const live = (await listTerminalInstances(api.origin, project!.id))
              .filter(row => row.id === instance.id && row.processState === "running")
            return live.length === 0
          },
          10_000,
          `churn instance ${i} stopped`,
        )
      }
      const live = (await listTerminalInstances(api.origin, project!.id)).filter(
        row => row.processState === "running",
      )
      expect(live.length).toBe(0)
      const after = processRssBytes(api.pid)
      expect(after).toBeLessThan(before + 256 * 1024 * 1024)
    })
  })
})
