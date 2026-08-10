import { expect, test } from "@playwright/test"
import {
  assertBudget,
  logBenchResult,
  median,
  percentile,
  type BenchResult,
} from "./_bench.js"
import { launchJet } from "../electron/_launch.js"

type StartupSnapshot = {
  readyMs: number
  nodeCount: number
  usedHeapBytes: number | null
  scripts: string[]
}

function result(name: string, samples: number[]): BenchResult {
  return {
    name,
    median: median(samples),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    samples,
  }
}

test("bench frontend cold startup and first overlay", async () => {
  const startupSamples: number[] = []
  const overlaySamples: number[] = []
  const overlayDispatchSamples: number[] = []
  const snapshots: StartupSnapshot[] = []

  for (let round = 0; round < 5; round++) {
    const { app, page } = await launchJet({
      launchWithoutWorkspace: true,
      hq: true,
    })
    try {
      const snapshot = await page.evaluate(() => {
        const memory = Reflect.get(performance, "memory")
        const usedHeapBytes =
          typeof memory === "object" &&
          memory !== null &&
          "usedJSHeapSize" in memory &&
          typeof memory.usedJSHeapSize === "number"
            ? memory.usedJSHeapSize
            : null
        return {
          readyMs: performance.now(),
          nodeCount: document.getElementsByTagName("*").length,
          usedHeapBytes,
          scripts: performance
            .getEntriesByType("resource")
            .filter(entry => entry.name.endsWith(".js"))
            .map(entry => entry.name),
        }
      })
      snapshots.push(snapshot)
      startupSamples.push(snapshot.readyMs)

      const dispatchMs = await page.evaluate(async () => {
        performance.mark("yaade:overlay-cold-open:start")
        const startedAt = performance.now()
        await window.__yaadeAgent!.executeCommand("settings.show")
        return performance.now() - startedAt
      })
      overlayDispatchSamples.push(dispatchMs)
      await page.waitForSelector("[data-yaade-settings-overlay]", {
        state: "visible",
        timeout: 10_000,
      })
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
      overlaySamples.push(
        await page.evaluate(() => {
          const mark = performance.getEntriesByName("yaade:overlay-cold-open:start").at(-1)
          return mark ? performance.now() - mark.startTime : 0
        }),
      )
    } finally {
      await app.close()
    }
  }

  const startup = result("frontend-cold-start", startupSamples)
  const overlay = result("overlay-cold-open", overlaySamples)
  logBenchResult(startup)
  logBenchResult(overlay)
  console.log(
    `[bench] overlay-command-dispatch median=${median(overlayDispatchSamples).toFixed(1)}ms`,
  )
  assertBudget(startup)
  assertBudget(overlay)

  for (const snapshot of snapshots) {
    expect(snapshot.nodeCount, "cold HQ DOM should stay compact").toBeLessThan(2_000)
    expect(
      snapshot.scripts.some(name =>
        /(?:MuxApp|monaco|xterm|git-entry|agent-picker-entry)/i.test(
          name,
        ),
      ),
      "workspace or agent-dialog implementation loaded on the cold HQ path",
    ).toBe(false)
    if (snapshot.usedHeapBytes != null) {
      expect(snapshot.usedHeapBytes, "cold home JS heap exceeded 64 MiB").toBeLessThan(
        64 * 1024 * 1024,
      )
    }
  }
})
