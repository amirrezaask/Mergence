import { expect, test } from "@playwright/test"
import path from "node:path"
import {
  acquireLease,
  attachTerminal,
  createDurableRuntimeHarness,
  createTerminalInstance,
  listProjects,
  listViewers,
  MOCK_AGENT_PATH,
  numberedLine,
  requestControl,
  resizeTerminal,
  resizeTerminalResult,
  transferControl,
  waitForAttach,
  waitForMockAgent,
  writeTerminal,
  writeTerminalResult,
} from "../../runtime/harness/index.js"
import { waitUntil } from "../../runtime/harness/wait.js"

async function withHarness(
  testInfo: { outputDir: string },
  run: (harness: Awaited<ReturnType<typeof createDurableRuntimeHarness>>) => Promise<void>,
  env?: Record<string, string>,
): Promise<void> {
  const harness = await createDurableRuntimeHarness({ env })
  try {
    await run(harness)
  } catch (error) {
    await harness.retainDiagnostics(path.join(testInfo.outputDir, "runtime")).catch(() => undefined)
    throw error
  } finally {
    await harness.close()
  }
}

function rpcCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

async function launchIdle(
  origin: string,
  projectId: string,
  workspace: string,
  controlFile: string,
) {
  const instance = await createTerminalInstance(origin, {
    projectId,
    checkoutPath: workspace,
    checkoutKey: "main",
    title: "lease-agent",
    launchRequestId: `lease-${path.basename(controlFile)}`,
    executable: process.execPath,
    args: [MOCK_AGENT_PATH, "--mode", "idle", "--control-file", controlFile],
  })
  const agent = await waitForMockAgent(controlFile)
  const ptyId = instance.ptyId
  if (!ptyId) throw new Error("lease agent launched without a PTY")
  return { instance, agent, ptyId }
}

async function openModernSocket(origin: string, clientId: string): Promise<WebSocket> {
  const url = `${origin.replace(/^http/, "ws")}/ws?since=0&clientId=${encodeURIComponent(clientId)}&protocol=2`
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve())
    socket.addEventListener("error", () => reject(new Error(`websocket failed ${url}`)))
  })
  return socket
}

test.describe("L — multi-client writer and resize leases", { tag: "@p1" }, () => {
  test("L01 first controller plus second observer behaves deterministically", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]
      const launched = await launchIdle(
        api.origin,
        project!.id,
        harness.workspace,
        path.join(harness.root, "l01.json"),
      )
      await attachTerminal(api.origin, launched.ptyId, undefined, "desktop")
      await attachTerminal(api.origin, launched.ptyId, undefined, "phone")
      const viewers = await listViewers(api.origin, launched.ptyId, "desktop")
      expect(viewers.sort()).toEqual(["desktop", "phone"])
      await launched.agent.emitRange(1, 4)
      await waitUntil(async () => {
        const writer = await attachTerminal(api.origin, launched.ptyId, undefined, "desktop")
        const observer = await attachTerminal(api.origin, launched.ptyId, undefined, "phone")
        return Boolean(
          writer?.output.includes(numberedLine(4)) &&
          observer?.output.includes(numberedLine(4)),
        )
      }, 8_000, "both clients see identical output")
      const writeOk = await writeTerminalResult(api.origin, launched.ptyId, "L01_WRITER\n", "desktop")
      expect(writeOk.ok).toBe(true)
      const writeDenied = await writeTerminalResult(api.origin, launched.ptyId, "L01_OBSERVER\n", "phone")
      expect(writeDenied.ok).toBe(false)
      expect(rpcCode(writeDenied.error)).toBe("LEASE_NOT_HELD")
    })
  })

  test("L02 input carrying an expired or stale lease is rejected", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]
      const launched = await launchIdle(
        api.origin,
        project!.id,
        harness.workspace,
        path.join(harness.root, "l02.json"),
      )
      const writer = await acquireLease(api.origin, launched.ptyId, "desktop", "writer") as {
        leaseId: string
      }
      await acquireLease(api.origin, launched.ptyId, "phone", "observer")
      await transferControl(api.origin, launched.ptyId, writer.leaseId, "desktop", "phone")
      const denied = await writeTerminalResult(api.origin, launched.ptyId, "STALE\n", "desktop")
      expect(denied.ok).toBe(false)
      expect(rpcCode(denied.error)).toBe("LEASE_NOT_HELD")
      const accepted = await writeTerminalResult(api.origin, launched.ptyId, "NEW_WRITER\n", "phone")
      expect(accepted.ok).toBe(true)
    })
  })

  test("L03 observer resize cannot change authoritative PTY dimensions", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]
      const launched = await launchIdle(
        api.origin,
        project!.id,
        harness.workspace,
        path.join(harness.root, "l03.json"),
      )
      const writer = await acquireLease(api.origin, launched.ptyId, "desktop", "writer") as {
        leaseId: string
      }
      await acquireLease(api.origin, launched.ptyId, "phone", "observer")
      await resizeTerminal(api.origin, launched.ptyId, 80, 24, "desktop")
      const denied = await resizeTerminalResult(api.origin, launched.ptyId, 40, 12, "phone")
      expect(denied.ok).toBe(false)
      expect(rpcCode(denied.error)).toBe("LEASE_NOT_HELD")
      const before = await waitForAttach(api.origin, launched.ptyId)
      expect(before.cols).toBe(80)
      expect(before.rows).toBe(24)
      await transferControl(api.origin, launched.ptyId, writer.leaseId, "desktop", "phone")
      await resizeTerminal(api.origin, launched.ptyId, 60, 18, "phone")
      const after = await waitForAttach(api.origin, launched.ptyId)
      expect(after.cols).toBe(60)
      expect(after.rows).toBe(18)
    })
  })

  test("L04 control transfer is atomic under concurrent input", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]
      const launched = await launchIdle(
        api.origin,
        project!.id,
        harness.workspace,
        path.join(harness.root, "l04.json"),
      )
      const writer = await acquireLease(api.origin, launched.ptyId, "desktop", "writer") as {
        leaseId: string
      }
      await acquireLease(api.origin, launched.ptyId, "phone", "observer")
      const before = await writeTerminalResult(api.origin, launched.ptyId, "OLD_OK\n", "desktop")
      expect(before.ok).toBe(true)
      await transferControl(api.origin, launched.ptyId, writer.leaseId, "desktop", "phone")
      const afterOld = await writeTerminalResult(api.origin, launched.ptyId, "OLD_LATE\n", "desktop")
      expect(afterOld.ok).toBe(false)
      expect(rpcCode(afterOld.error)).toBe("LEASE_NOT_HELD")
      const afterNew = await writeTerminalResult(api.origin, launched.ptyId, "NEW_OK\n", "phone")
      expect(afterNew.ok).toBe(true)
    })
  })

  test("L05 disconnect grace prevents lease flapping", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]
      const launched = await launchIdle(
        api.origin,
        project!.id,
        harness.workspace,
        path.join(harness.root, "l05.json"),
      )
      await acquireLease(api.origin, launched.ptyId, "desktop", "writer")
      await acquireLease(api.origin, launched.ptyId, "phone", "observer")
      const socket = await openModernSocket(api.origin, "desktop")
      socket.close()
      await waitUntil(async () => socket.readyState === WebSocket.CLOSED, 2_000, "writer socket close")
      const duringGrace = await writeTerminalResult(api.origin, launched.ptyId, "GRACE\n", "desktop")
      expect(duringGrace.ok).toBe(true)
      const second = await openModernSocket(api.origin, "desktop")
      second.close()
      await waitUntil(async () => second.readyState === WebSocket.CLOSED, 2_000, "second writer socket close")
      const blocked = await requestControl(api.origin, launched.ptyId, "phone")
      expect(blocked.ok === false || blocked.value == null).toBe(true)
      await waitUntil(async () => {
        const result = await requestControl(api.origin, launched.ptyId, "phone")
        return result.ok && result.value != null
      }, 8_000, "observer acquires after grace")
      const stale = await writeTerminalResult(api.origin, launched.ptyId, "STALE\n", "desktop")
      expect(stale.ok).toBe(false)
      expect(rpcCode(stale.error)).toBe("LEASE_NOT_HELD")
    }, { JET_LEASE_DISCONNECT_GRACE_MS: "1200" })
  })

  test("L06 mobile opens an existing terminal as observer by default", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]
      const launched = await launchIdle(
        api.origin,
        project!.id,
        harness.workspace,
        path.join(harness.root, "l06.json"),
      )
      await acquireLease(api.origin, launched.ptyId, "desktop", "writer")
      await attachTerminal(api.origin, launched.ptyId, undefined, "mobile")
      const denied = await writeTerminalResult(api.origin, launched.ptyId, "MOBILE\n", "mobile")
      expect(denied.ok).toBe(false)
      expect(rpcCode(denied.error)).toBe("LEASE_NOT_HELD")
      const desktop = await writeTerminalResult(api.origin, launched.ptyId, "DESKTOP\n", "desktop")
      expect(desktop.ok).toBe(true)
      const browser = await harness.startBrowser()
      await browser.page.setViewportSize({ width: 390, height: 844 })
      await expect(browser.page.locator("[data-yaade-session-switcher]")).toBeVisible()
    })
  })

  test("L07 simultaneous lease acquisition has one deterministic winner", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]
      const launched = await launchIdle(
        api.origin,
        project!.id,
        harness.workspace,
        path.join(harness.root, "l07.json"),
      )
      const [first, second] = await Promise.all([
        requestControl(api.origin, launched.ptyId, "alpha"),
        requestControl(api.origin, launched.ptyId, "beta"),
      ])
      const winners = [first, second].filter(result => result.ok && result.value != null)
      const losers = [first, second].filter(result => !result.ok || result.value == null)
      expect(winners).toHaveLength(1)
      expect(losers).toHaveLength(1)
      const winnerId = first.ok && first.value ? "alpha" : "beta"
      const loserId = winnerId === "alpha" ? "beta" : "alpha"
      const winnerWrite = await writeTerminalResult(api.origin, launched.ptyId, "WIN\n", winnerId)
      expect(winnerWrite.ok).toBe(true)
      const loserWrite = await writeTerminalResult(api.origin, launched.ptyId, "LOSE\n", loserId)
      expect(loserWrite.ok).toBe(false)
      expect(rpcCode(loserWrite.error)).toBe("LEASE_NOT_HELD")
    })
  })
})
