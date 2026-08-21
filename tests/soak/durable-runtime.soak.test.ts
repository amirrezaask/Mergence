import { expect, test } from "@playwright/test"
import {
  createDurableRuntimeHarness,
  listTerminalInstances,
  processRssBytes,
} from "../runtime/harness/index.js"

const SOAK_MS = Number(process.env.YAADE_SOAK_MS ?? "8000")
const SOAK_PTYS = Number(process.env.YAADE_SOAK_PTYS ?? "8")

test.describe("C — soak", { tag: "@p2" }, () => {
  test("C01 multi-PTY durability soak remains within resource budgets", async ({}, testInfo) => {
    test.skip(SOAK_MS <= 0, "YAADE_SOAK_MS=0 disables the soak suite")
    const harness = await createDurableRuntimeHarness()
    try {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const launched = []
      for (let i = 0; i < SOAK_PTYS; i += 1) {
        launched.push(
          await harness.launchMockAgent({
            mode: i % 4 === 0 ? "flood" : i % 4 === 1 ? "idle" : "numbered",
            from: 1,
            intervalMs: 40,
          }),
        )
      }
      const projectId = launched[0]!.instance.projectId
      const startRss = processRssBytes(api.pid)
      await new Promise(resolve => setTimeout(resolve, SOAK_MS))
      for (const item of launched) {
        await harness.assertProcessAlive(item.processIdentity)
      }
      const instances = await listTerminalInstances(harness.origin, projectId)
      expect(instances.filter(row => row.processState === "running").length).toBe(SOAK_PTYS)
      const endRss = processRssBytes(api.pid)
      expect(endRss).toBeLessThan(startRss + 512 * 1024 * 1024)
      const health = await fetch(`${harness.origin}/health`)
      expect(health.ok).toBe(true)
    } catch (error) {
      await harness.retainDiagnostics(testInfo.outputDir).catch(() => undefined)
      throw error
    } finally {
      await harness.close()
    }
  })
})
