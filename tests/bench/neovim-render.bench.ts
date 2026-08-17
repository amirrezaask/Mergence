import path from "node:path"
import { test } from "@playwright/test"
import type { ShellDriver } from "../shell/driver.js"
import { launchJet, REPO_ROOT } from "../electron/_launch.js"
import { assertBudget, logBenchResult, runBench } from "./_bench.js"

const MOCK_ENV = {
  YAADE_NVIM_BIN: path.join(REPO_ROOT, "apps/host-server/mocks/mock-neovim-server.mjs"),
}

type NeovimDiagnostics = {
  readonly frames: number
  readonly firstPaintMs: number | null
  readonly lastFrameCpuMs: number
  readonly lastRedrawReduceCpuMs: number
  readonly lastPacketBuildCpuMs: number
  readonly lastCellUploadCpuMs: number
  readonly lastAtlasUploadCpuMs: number
  readonly lastDrawSubmitCpuMs: number
  readonly lastAtlasRasterCpuMs: number
  readonly bytesUploaded: number
  readonly packetCapacityBytes: number
  readonly atlasGpuBytes: number
  readonly pendingBitmapBytes: number
  readonly lastFrameDrawCalls: number
  readonly scheduledFrames: number
}

async function createNeovim(page: ShellDriver): Promise<string> {
  return page.evaluate(async () => {
    performance.clearMarks("yaade:neovim-create:start")
    performance.clearMarks("yaade:neovim-create:end")
    performance.clearMeasures("yaade:neovim-first-frame")
    performance.mark("yaade:neovim-create:start")
    const tools = window.yaade!.tools!
    const sessionId = window.__yaadeAgent!.getState().activeSessionId!
    const project = (await tools.listProjects())[0]!
    const created = await tools.createUse({
      _tag: "CreateToolUse",
      sessionId,
      kind: "neovim",
      project,
      checkout: { _tag: "MainCheckout", kind: "main" },
      input: { _tag: "NeovimToolInput", kind: "neovim" },
    })
    await window.__yaadeAgent!.selectToolUse?.(created.id)
    return created.id
  })
}

async function waitForReady(page: ShellDriver, toolUseId: string, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    id => {
      const status = document.querySelector(`[data-yaade-neovim-tool-use="${id}"]`)?.getAttribute("data-yaade-neovim-status")
      const diagnostics = window.__yaadeAgent!.getNeovimDiagnostics(id) as { firstPaintMs?: number | null } | null
      return status === "ready" && diagnostics?.firstPaintMs != null && window.__yaadeAgent!.getNeovimText(id).includes("YAADE Neovim")
    },
    toolUseId,
    { timeout },
  )
}

async function createReadyNeovim(page: ShellDriver): Promise<string> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const toolUseId = await createNeovim(page)
    try {
      await waitForReady(page, toolUseId, 5_000)
      if (attempt > 1) console.log(`[bench] neovim-first-frame-retry attempt=${attempt}`)
      return toolUseId
    } catch (error) {
      lastError = error
      console.log(`[bench] neovim-first-frame-retry-failed attempt=${attempt} id=${toolUseId}`)
      await closeNeovim(page, toolUseId).catch(() => undefined)
      await page.waitForTimeout(1_000)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function dispatchInput(page: ShellDriver, toolUseId: string, value: string): Promise<number> {
  return page.evaluate(
    ({ id, text }) => {
      const dispatch = window.__yaadeAgent!.dispatchNeovimInput
      if (!dispatch) throw new Error("Neovim benchmark input hook is unavailable")
      return dispatch(id, text)
    },
    { id: toolUseId, text: value },
  )
}

async function closeNeovim(page: ShellDriver, toolUseId: string): Promise<void> {
  await page.evaluate(id => window.__yaadeAgent!.closeToolUse!(id), toolUseId)
  await page.waitForFunction(
    id => !(window.__yaadeAgent!.getState().toolUses ?? []).some((use: { id: string }) => use.id === id),
    toolUseId,
    { timeout: 15_000 },
  )
}

async function diagnostics(page: ShellDriver, toolUseId: string): Promise<NeovimDiagnostics> {
  return page.evaluate(id => window.__yaadeAgent!.getNeovimDiagnostics(id) as NeovimDiagnostics, toolUseId)
}

function logStageDiagnostics(value: NeovimDiagnostics): void {
  console.log(`[bench] neovim-stages ${JSON.stringify({
    reduceMs: Number(value.lastRedrawReduceCpuMs.toFixed(3)),
    packetMs: Number(value.lastPacketBuildCpuMs.toFixed(3)),
    rasterMs: Number(value.lastAtlasRasterCpuMs.toFixed(3)),
    atlasUploadMs: Number(value.lastAtlasUploadCpuMs.toFixed(3)),
    cellUploadMs: Number(value.lastCellUploadCpuMs.toFixed(3)),
    drawMs: Number(value.lastDrawSubmitCpuMs.toFixed(3)),
    frameCpuMs: Number(value.lastFrameCpuMs.toFixed(3)),
    bytesUploaded: value.bytesUploaded,
    packetCapacityBytes: value.packetCapacityBytes,
    atlasGpuBytes: value.atlasGpuBytes,
    pendingBitmapBytes: value.pendingBitmapBytes,
    drawCalls: value.lastFrameDrawCalls,
  })}`)
}

test("bench WebGL2 Neovim rendering budgets", async () => {
  const app = await launchJet({ withTerminal: false, env: MOCK_ENV })
  try {
    const page = app.page
    console.log("[bench] neovim-environment", await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      dpr: window.devicePixelRatio,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      crossOriginIsolated: window.crossOriginIsolated,
    })))

    const firstFrame = await runBench({
      name: "neovim-first-frame",
      warmup: 1,
      rounds: 10,
      measure: async () => {
        const toolUseId = await createReadyNeovim(page)
        const elapsed = await page.evaluate(id => {
          const start = performance.getEntriesByName("yaade:neovim-create:start").at(-1)
          const paint = performance.getEntriesByName(`yaade:neovim-first-paint:${id}`).at(-1)
          if (!start || !paint) return 0
          return paint.startTime - start.startTime
        }, toolUseId)
        await closeNeovim(page, toolUseId)
        // Let React unregister the remountable surface and the host reap the
        // child before the next cold sample; this is fixture isolation, not
        // part of the measured create-to-paint interval.
        await page.waitForTimeout(1_600)
        return elapsed
      },
    })
    logBenchResult(firstFrame)
    assertBudget(firstFrame)

    const toolUseId = await createReadyNeovim(page)
    const inputToPaint = await runBench({
      name: "neovim-input-to-paint",
      warmup: 3,
      rounds: 20,
      measure: () => dispatchInput(page, toolUseId, "z"),
    })
    logBenchResult(inputToPaint)
    assertBudget(inputToPaint)

    const redraw10k = await runBench({
      name: "neovim-redraw-10k-cells",
      warmup: 2,
      rounds: 10,
      measure: async () => {
        await dispatchInput(page, toolUseId, "__YAADE_BENCH_10K__")
        const value = await diagnostics(page, toolUseId)
        return value.lastRedrawReduceCpuMs +
          value.lastPacketBuildCpuMs +
          value.lastCellUploadCpuMs +
          value.lastAtlasUploadCpuMs +
          value.lastDrawSubmitCpuMs
      },
    })
    logBenchResult(redraw10k)
    assertBudget(redraw10k)
    logStageDiagnostics(await diagnostics(page, toolUseId))

    const beforeIdle = await diagnostics(page, toolUseId)
    await page.waitForTimeout(2_000)
    const afterIdle = await diagnostics(page, toolUseId)
    console.log(`[bench] neovim-idle scheduledDelta=${afterIdle.scheduledFrames - beforeIdle.scheduledFrames} renderedDelta=${afterIdle.frames - beforeIdle.frames}`)

    await closeNeovim(page, toolUseId)
  } finally {
    await app.app.close()
  }
})
