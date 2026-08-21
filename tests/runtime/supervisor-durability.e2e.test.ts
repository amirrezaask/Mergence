import { expect, test } from "@playwright/test"
import path from "node:path"
import { isProcessAlive } from "../../packages/yaade-node-host/src/process-identity.js"
import fs from "node:fs"
import {
  countMatchingProcesses,
  createDurableRuntimeHarness,
  createTerminalInstance,
  listProjects,
  listSupervisorPtys,
  listTerminalInstances,
  MOCK_AGENT_PATH,
  readHealth,
  readSupervisorHandle,
  startIncompatibleSupervisor,
} from "./harness/index.js"
import { waitUntil } from "./harness/wait.js"

async function withHarness(
  testInfo: { outputDir: string },
  run: (harness: Awaited<ReturnType<typeof createDurableRuntimeHarness>>) => Promise<void>,
): Promise<void> {
  const harness = await createDurableRuntimeHarness()
  try {
    await run(harness)
  } catch (error) {
    await harness.retainDiagnostics(path.join(testInfo.outputDir, "runtime")).catch(() => undefined)
    throw error
  } finally {
    await harness.close()
  }
}

test.describe("P — supervisor and process-safety", { tag: "@p0" }, () => {
  test("P01 concurrent daemon/API startup elects exactly one supervisor", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const [first, second] = await Promise.allSettled([
        harness.startApi(),
        harness.startCompetingApi(),
      ])
      let supervisor = readSupervisorHandle(harness.dataDir)
      await waitUntil(() => {
        supervisor = readSupervisorHandle(harness.dataDir)
        return supervisor != null && isProcessAlive(supervisor.pid)
      }, 20_000, "supervisor elected")
      expect(supervisor, "exactly one supervisor manifest should own the data directory").toBeTruthy()
      expect(supervisor?.supervisorId).toBeTruthy()
      expect(isProcessAlive(supervisor!.pid)).toBe(true)

      const origins: string[] = []
      if (first.status === "fulfilled") origins.push(first.value.origin)
      if (second.status === "fulfilled" && !second.value.startError) origins.push(second.value.origin)
      const healthy = (
        await Promise.all(
          origins.map(async origin => {
            try {
              const health = await readHealth(origin)
              return ["healthy", "degraded"].includes(health.health.supervisor.status)
            } catch {
              return false
            }
          }),
        )
      ).filter(Boolean)
      expect(healthy.length, "at least one API must connect to the elected supervisor").toBeGreaterThanOrEqual(1)
      if (second.status === "fulfilled") await second.value.close()
    })
  })

  test("P03 temporary supervisor socket interruption reconnects without losing PTYs", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      const before = await harness.startSupervisor()
      const launched = await harness.launchMockAgent()
      const ptyId = launched.instance.ptyId
      expect(ptyId).toBeTruthy()
      await launched.agent.emitRange(1, 2)

      await harness.interruptSupervisorSocket()
      await waitUntil(async () => {
        const health = await readHealth(api.origin)
        return (
          health.health.supervisor.message === "reconnecting" ||
          health.health.supervisor.message === "Supervisor reconnecting" ||
          health.health.supervisor.status === "degraded" ||
          health.health.supervisor.status === "healthy"
        )
      }, 10_000, "supervisor reconnecting or recovered")

      await waitUntil(async () => {
        const health = await readHealth(api.origin)
        return health.health.supervisor.status === "healthy"
      }, 15_000, "supervisor healthy after interrupt")

      const after = readSupervisorHandle(harness.dataDir)
      expect(after?.supervisorId).toBe(before.supervisorId)
      const live = await listSupervisorPtys(harness.dataDir)
      expect(live.some(item => item.id === ptyId)).toBe(true)
      await harness.assertProcessAlive(launched.processIdentity)
    })
  })

  test("P02 stale supervisor manifest and socket are recovered safely", async ({}, testInfo) => {
    test.skip(process.platform === "win32", "Unix socket stale-file recovery")
    await withHarness(testInfo, async harness => {
      const socketPath = path.join(harness.dataDir, "pty-supervisor.sock")
      const manifestPath = path.join(harness.dataDir, "pty-supervisor.json")
      fs.mkdirSync(harness.dataDir, { recursive: true })
      fs.writeFileSync(socketPath, "stale")
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          schemaVersion: 1,
          supervisorId: "stale-supervisor",
          supervisorEpoch: "stale-epoch",
          protocolVersion: 1,
          pid: 999999,
          processIdentity: {
            pid: 999999,
            platform: process.platform === "linux" ? "linux" : "darwin",
            startToken: "dead-start-token",
          },
          socketPath,
          startedAt: new Date().toISOString(),
        }),
      )
      await harness.startApi()
      const supervisor = readSupervisorHandle(harness.dataDir)
      expect(supervisor?.supervisorId).not.toBe("stale-supervisor")
      expect(supervisor?.pid).toBeTruthy()
      expect(isProcessAlive(supervisor!.pid)).toBe(true)
    })
  })

  test("P04 supervisor reconnect during create preserves idempotency", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      const projects = await listProjects(api.origin)
      const launchRequestId = "p04-stable-create"
      const args = [
        MOCK_AGENT_PATH,
        "--mode",
        "idle",
        "--control-file",
        path.join(harness.root, "p04.json"),
      ]
      const first = createTerminalInstance(api.origin, {
        projectId: projects[0]!.id,
        checkoutPath: harness.workspace,
        checkoutKey: "main",
        title: "p04",
        launchRequestId,
        executable: process.execPath,
        args,
      })
      await harness.interruptSupervisorSocket()
      const created = await first.catch(() => null)
      await waitUntil(async () => {
        const health = await readHealth(api.origin)
        return health.health.supervisor.status === "healthy"
      }, 15_000, "supervisor healthy after create interrupt")
      const retried = await createTerminalInstance(api.origin, {
        projectId: projects[0]!.id,
        checkoutPath: harness.workspace,
        checkoutKey: "main",
        title: "p04",
        launchRequestId,
        executable: process.execPath,
        args,
      })
      expect(retried.ptyId).toBeTruthy()
      if (created?.ptyId) expect(retried.ptyId).toBe(created.ptyId)
      const live = await listSupervisorPtys(harness.dataDir)
      expect(live.filter(item => item.id === retried.ptyId).length).toBe(1)
      expect(countMatchingProcesses(path.join(harness.root, "p04.json"))).toBe(1)
    })
  })

  test("P05 supervisor SIGKILL never leaves a false running state", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      const launched = await harness.launchMockAgent()
      await harness.killSupervisor("SIGKILL")
      await waitUntil(async () => {
        const instances = await listTerminalInstances(api.origin, launched.instance.projectId)
        const row = instances.find(item => item.id === launched.instance.id)
        return (
          row != null &&
          row.processState !== "running" &&
          row.processState !== "starting"
        )
      }, 20_000, "terminal left running after supervisor death")
      const instances = await listTerminalInstances(api.origin, launched.instance.projectId)
      const row = instances.find(item => item.id === launched.instance.id)
      expect(row?.processState).not.toBe("running")
    })
  })

  test("P06 supervisor protocol mismatch is surfaced and non-destructive", async ({}, testInfo) => {
    test.skip(process.platform === "win32", "Unix incompatible-supervisor fixture")
    await withHarness(testInfo, async harness => {
      const fixture = await startIncompatibleSupervisor(harness.dataDir)
      try {
        const api = await harness.startApi()
        const health = await readHealth(api.origin)
        expect(health.health.supervisor.status).toBe("unhealthy")
        expect(health.health.supervisor.message).toMatch(/incompatible/i)
        await expect(harness.launchMockAgent()).rejects.toThrow(/INCOMPATIBLE|incompatible|supervisor/i)
        expect(fs.existsSync(fixture.socketPath)).toBe(true)
      } finally {
        await fixture.close()
      }
    })
  })
})
