import { expect, test } from "@playwright/test"
import { spawn } from "node:child_process"
import path from "node:path"
import {
  captureProcessIdentity,
  isProcessAlive,
  matchesProcessIdentity,
} from "../../packages/yaade-node-host/src/process-identity.js"
import {
  closeTerminalInstance,
  countMatchingProcesses,
  createDurableRuntimeHarness,
  listTerminalInstances,
  patchTerminalInstanceIdentity,
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

test.describe("P07 — PID reuse cannot kill an unrelated process", { tag: "@p0" }, () => {
  test("reconciliation leaves a sentinel alive when the start token does not match", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      await harness.startApi()
      const launched = await harness.launchMockAgent()
      const instanceId = launched.instance.id
      const projectId = launched.instance.projectId
      const staleIdentity = launched.processIdentity
      process.kill(launched.agent.pid, "SIGKILL")
      await waitUntil(() => !isProcessAlive(launched.agent.pid), 5_000, "mock agent exit")
      await harness.killApi("SIGTERM")
      await harness.killSupervisor("SIGKILL")

      const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
        stdio: "ignore",
      })
      try {
        const sentinelPid = sentinel.pid
        expect(sentinelPid).toBeTruthy()
        await waitUntil(() => captureProcessIdentity(sentinelPid!) != null, 5_000, "sentinel identity")
        const sentinelIdentity = captureProcessIdentity(sentinelPid!)
        expect(sentinelIdentity).toBeTruthy()
        patchTerminalInstanceIdentity(
          harness.dataDir,
          instanceId,
          JSON.stringify({
            ...staleIdentity,
            pid: sentinelPid,
            startToken: `${staleIdentity.startToken}-dead`,
          }),
        )
        const restarted = await harness.startApi()
        await waitUntil(async () => {
          const instances = await listTerminalInstances(restarted.origin, projectId)
          const row = instances.find(item => item.id === instanceId)
          return row?.processState === "orphaned" || row?.processState === "disconnected"
        }, 15_000, "terminal marked orphaned or disconnected")
        expect(isProcessAlive(sentinelPid!)).toBe(true)
        expect(matchesProcessIdentity(sentinelIdentity!)).toBe(true)
      } finally {
        sentinel.kill("SIGKILL")
        await new Promise<void>(resolve => sentinel.once("exit", () => resolve()))
      }
    })
  })
})

test.describe("P08 — explicit terminal close kills the complete PTY process tree", { tag: "@p0" }, () => {
  test("closing a terminal exits child and grandchild processes", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      await harness.startApi()
      const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" })
      try {
        const launched = await harness.launchMockAgent({ mode: "children" })
        await waitUntil(
          () => countMatchingProcesses("setInterval") >= 1,
          10_000,
          "mock agent children",
        )
        await closeTerminalInstance(
          harness.origin,
          launched.instance.id,
          launched.instance.generation,
        )
        await waitUntil(
          () => !isProcessAlive(launched.agent.pid),
          10_000,
          "mock agent exit after close",
        )
        expect(isProcessAlive(sibling.pid!)).toBe(true)
      } finally {
        sibling.kill("SIGKILL")
        await new Promise<void>(resolve => sibling.once("exit", () => resolve()))
      }
    })
  })
})
