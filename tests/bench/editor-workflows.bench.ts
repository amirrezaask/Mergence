import { expect, test } from "@playwright/test"
import { expectListRows } from "../helpers/list.js"
import {
  execCommand,
  launchJet,
  modChord,
  type ShellDriver,
} from "../electron/_launch.js"
import {
  assertBudget,
  logBenchResult,
  median,
  percentile,
  runBench,
  type BenchResult,
} from "./_bench.js"

const PALETTE = "[data-yaade-palette]"
const PALETTE_INPUT = `${PALETTE} input`
const PALETTE_ROWS =
  '[data-yaade-list-panel="yaade:palette"] [data-yaade-list-item]'
type BrowserFsReadStats = {
  count: number
  bytes: number
  byUri: Record<string, number>
}

type EditorResource = {
  name: string
  initiatorType: string
  transferSize: number
  encodedBodySize: number
  decodedBodySize: number
  duration: number
}

type EditorPaintState = {
  paintCount: number
  lastPaintAt: number
  keydownCount: number
  lastKey: string
  lastKeydownAt: number
  observer: MutationObserver | null
}

declare global {
  interface Window {
    __yaadeBenchEditorPaints?: EditorPaintState
    __yaadeBenchFsReads?: BrowserFsReadStats
  }
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

function assertTypingBudget(result: BenchResult): void {
  expect(result.median, `${result.name} median`).toBeLessThanOrEqual(16)
  expect(result.p95, `${result.name} p95`).toBeLessThanOrEqual(20)
  expect(result.p99, `${result.name} p99`).toBeLessThanOrEqual(32)
}

async function startTimer(page: ShellDriver, name: string): Promise<void> {
  await page.evaluate(mark => {
    performance.clearMarks(mark)
    performance.mark(mark)
  }, name)
}

async function finishTimerAtNextFrame(
  page: ShellDriver,
  name: string,
): Promise<number> {
  return page.evaluate(
    mark =>
      new Promise<number>((resolve, reject) => {
        const started = performance.getEntriesByName(mark, "mark").at(-1)
        if (!started) {
          reject(new Error(`missing benchmark mark: ${mark}`))
          return
        }
        requestAnimationFrame(() => resolve(performance.now() - started.startTime))
      }),
    name,
  )
}

async function finishTimer(page: ShellDriver, name: string): Promise<number> {
  return page.evaluate(mark => {
    const started = performance.getEntriesByName(mark, "mark").at(-1)
    if (!started) throw new Error(`missing benchmark mark: ${mark}`)
    return performance.now() - started.startTime
  }, name)
}

async function installEditorPaintCounter(page: ShellDriver): Promise<void> {
  await page.evaluate(() => {
    const previous = window.__yaadeBenchEditorPaints
    previous?.observer?.disconnect()
    const target = document.querySelector("[data-yaade-monaco-editor] .view-lines")
    if (!target) throw new Error("Monaco view lines unavailable")
    const state = {
      paintCount: 0,
      lastPaintAt: 0,
      keydownCount: 0,
      lastKey: "",
      lastKeydownAt: 0,
      observer: null as MutationObserver | null,
    }
    state.observer = new MutationObserver(() => {
      state.paintCount += 1
      state.lastPaintAt = performance.now()
    })
    state.observer.observe(target, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    window.addEventListener(
      "keydown",
      event => {
        const eventTarget = event.target
        if (
          !(eventTarget instanceof Element) ||
          !eventTarget.closest("[data-yaade-monaco-editor]")
        ) {
          return
        }
        state.keydownCount += 1
        state.lastKey = event.key
        state.lastKeydownAt = performance.now()
      },
      true,
    )
    window.__yaadeBenchEditorPaints = state
  })
}

type EditorInputSnapshot = {
  paintCount: number
  keydownCount: number
}

async function editorInputSnapshot(
  page: ShellDriver,
): Promise<EditorInputSnapshot> {
  return page.evaluate(() => {
    const state = window.__yaadeBenchEditorPaints
    if (
      !state ||
      typeof state.paintCount !== "number" ||
      typeof state.keydownCount !== "number"
    ) {
      throw new Error("editor paint counter was not installed")
    }
    return {
      paintCount: state.paintCount as number,
      keydownCount: state.keydownCount as number,
    }
  })
}

async function finishInputAtEditorPaint(
  page: ShellDriver,
  previous: EditorInputSnapshot,
  expectedKey: string,
): Promise<number> {
  return page.evaluate(
    ({ before, key }) =>
      new Promise<number>((resolve, reject) => {
        const deadline = performance.now() + 5_000
        const poll = () => {
          const state = window.__yaadeBenchEditorPaints
          if (
            state &&
            state.keydownCount > before.keydownCount &&
            state.paintCount > before.paintCount &&
            state.lastKey === key &&
            state.lastPaintAt >= state.lastKeydownAt
          ) {
            resolve(state.lastPaintAt - state.lastKeydownAt)
            return
          }
          if (performance.now() >= deadline) {
            reject(new Error("editor did not paint the typed input"))
            return
          }
          requestAnimationFrame(poll)
        }
        requestAnimationFrame(poll)
      }),
    { before: previous, key: expectedKey },
  )
}

async function installFsReadCounter(page: ShellDriver): Promise<void> {
  await page.evaluate(() => {
    const fs = window.yaade?.fs
    if (!fs) throw new Error("window.yaade.fs unavailable")
    const original = fs.readFile.bind(fs)
    const stats: BrowserFsReadStats = { count: 0, bytes: 0, byUri: {} }
    const countedRead = async (uri: string) => {
      const content = await original(uri)
      stats.count += 1
      stats.bytes += new TextEncoder().encode(content).byteLength
      stats.byUri[uri] = (stats.byUri[uri] ?? 0) + 1
      return content
    }
    window.__yaadeBenchFsReads = stats
    Reflect.set(fs, "readFile", countedRead)
  })
}

async function fsReadStats(page: ShellDriver): Promise<BrowserFsReadStats> {
  return page.evaluate(() => {
    const value = window.__yaadeBenchFsReads
    if (!value) {
      throw new Error("benchmark fs read counter was not installed")
    }
    return structuredClone(value) as BrowserFsReadStats
  })
}

async function waitForPaintedEditorText(
  page: ShellDriver,
  needle: string,
  timeoutMs = 15_000,
): Promise<void> {
  await page.waitForFunction(
    expected =>
      [...document.querySelectorAll<HTMLElement>(
        "[data-yaade-monaco-editor] .view-lines",
      )].some(element => (element.textContent ?? "").includes(expected)),
    needle,
    { timeout: timeoutMs },
  )
}

async function openFileToPaint(
  page: ShellDriver,
  relativePath: string,
  paintedNeedle: string,
  mark: string,
): Promise<number> {
  await startTimer(page, mark)
  await page.evaluate(path => window.__yaadeAgent!.openFile(path), relativePath)
  await waitForPaintedEditorText(page, paintedNeedle)
  return finishTimerAtNextFrame(page, mark)
}

async function closePalette(page: ShellDriver): Promise<void> {
  await page.keyboard.press("Escape")
  await page.locator(PALETTE).waitFor({ state: "hidden", timeout: 10_000 })
}

async function waitForPaletteRows(
  page: ShellDriver,
  needle: string,
  minItems: number,
): Promise<void> {
  await page.waitForFunction(
    ({ selector, expected, minimum }) => {
      const rows = [...document.querySelectorAll<HTMLElement>(selector)].filter(
        row => {
          const rect = row.getBoundingClientRect()
          const style = getComputedStyle(row)
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          )
        },
      )
      return (
        rows.length >= minimum &&
        rows.some(row => (row.textContent ?? "").includes(expected))
      )
    },
    { selector: PALETTE_ROWS, expected: needle, minimum: minItems },
    { timeout: 15_000 },
  )
}

async function editorResources(page: ShellDriver): Promise<EditorResource[]> {
  return page.evaluate(() =>
    (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .filter(entry =>
        /(?:MuxEditorPane|MonacoEditorHost|monaco(?:[.-])|(?:editor|css|html|json|ts)\.worker-)/i.test(
          new URL(entry.name).pathname.split("/").at(-1) ?? "",
        ),
      )
      .map(entry => ({
        name: new URL(entry.name).pathname.split("/").at(-1) ?? entry.name,
        initiatorType: entry.initiatorType,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
        duration: entry.duration,
      })),
  )
}

test("bench editor cold open, warm switching, lifecycle, and chunks", async () => {
  const coldOpenSamples: number[] = []
  const coldResources: EditorResource[][] = []
  let warmSwitchSamples: number[] = []
  let warmReadDelta = 0

  for (let round = 0; round < 5; round += 1) {
    const { app, page } = await launchJet({ withTerminal: false })
    try {
      await installFsReadCounter(page)
      coldOpenSamples.push(
        await openFileToPaint(
          page,
          "src/index.ts",
          "main()",
          `yaade:bench:open-file:${round}`,
        ),
      )
      coldResources.push(await editorResources(page))

      if (round === 0) {
        // Warm both retained models before measuring the file-switch path.
        await openFileToPaint(
          page,
          "src/utils.ts",
          "Hello",
          "yaade:bench:warm-prime-utils",
        )
        await openFileToPaint(
          page,
          "src/index.ts",
          "main()",
          "yaade:bench:warm-prime-index",
        )
        const resourcesBeforeSwitches = new Set(
          (await editorResources(page)).map(resource => resource.name),
        )
        const readsBeforeSwitches = (await fsReadStats(page)).count
        for (let switchRound = 0; switchRound < 12; switchRound += 1) {
          const toUtils = switchRound % 2 === 0
          warmSwitchSamples.push(
            await openFileToPaint(
              page,
              toUtils ? "src/utils.ts" : "src/index.ts",
              toUtils ? "Hello" : "main()",
              `yaade:bench:warm-switch:${switchRound}`,
            ),
          )
        }
        warmReadDelta = (await fsReadStats(page)).count - readsBeforeSwitches

        expect(
          await page.locator("[data-yaade-monaco-editor]").count(),
          "tab switches should retain one mounted editor host",
        ).toBe(1)
        expect(
          [
            ...new Set(
              (await editorResources(page)).map(resource => resource.name),
            ),
          ].sort(),
          "tab switches should not load or reload editor chunks",
        ).toEqual([...resourcesBeforeSwitches].sort())
        expect(
          warmReadDelta,
          "warm switches must use retained models without disk reads",
        ).toBe(0)
        expect(
          percentile(warmSwitchSamples, 0.95),
          "warm editor switch p95 must stay within 100 ms",
        ).toBeLessThanOrEqual(100)
      }
    } finally {
      await app.close()
    }
  }

  const coldOpen = result("editor-cold-open", coldOpenSamples)
  const warmOpen = result("open-file", warmSwitchSamples)
  logBenchResult(coldOpen)
  logBenchResult(warmOpen)
  console.log(`[bench] warm-editor-switch fsReads=${warmReadDelta}/12`)

  const uniqueEditorAssets = new Map<string, EditorResource>()
  for (const resource of coldResources.flat()) {
    uniqueEditorAssets.set(resource.name, resource)
  }
  const rawEditorBytes = [...uniqueEditorAssets.values()].reduce(
    (sum, resource) => sum + resource.decodedBodySize,
    0,
  )
  console.log(
    `[bench] editor-cold-assets count=${uniqueEditorAssets.size} ` +
      `decoded=${rawEditorBytes}B ` +
      `files=${JSON.stringify([...uniqueEditorAssets.keys()].sort())}`,
  )
  expect(
    [...uniqueEditorAssets.keys()].some(name =>
      /^(?:monaco(?:[.-])|MonacoEditorHost-)/i.test(name),
    ),
    "cold editor open should load the lazy Monaco chunk",
  ).toBe(true)
  expect(
    rawEditorBytes,
    "cold editor resources unexpectedly exceed 6 MiB decoded",
  ).toBeLessThan(6 * 1024 * 1024)
  assertBudget(warmOpen)
})

test("bench editor palettes and project navigation", async () => {
  const { app, page } = await launchJet({ withTerminal: false })
  try {
    const palette = await runBench({
      name: "palette-open",
      // A terminal benchmark session is created from the default Changes
      // route, whose lazy Git renderer may still be completing its one-time
      // module parse. Two warmups keep that cold-route cost in the dedicated
      // startup benchmark instead of charging it to steady-state palette UI.
      warmup: 2,
      rounds: 7,
      measure: async () => {
        await startTimer(page, "yaade:bench:palette-open")
        await execCommand(page, "ui.showCommandPalette")
        await waitForPaletteRows(page, "Close Pane", 3)
        // Visible, laid-out rows are the completion boundary; adding another
        // rAF here double-counts a frame after the palette has already painted.
        const elapsed = await finishTimer(page, "yaade:bench:palette-open")
        await closePalette(page)
        return elapsed
      },
    })
    logBenchResult(palette)
    assertBudget(palette)

    await execCommand(page, "ui.showCommandPalette")
    await waitForPaletteRows(page, "Close Pane", 3)
    await expectListRows(page, {
      panel: "yaade:palette",
      minItems: 3,
      needle: "Close Pane",
      noResultsText: "No results.",
    })
    await closePalette(page)

    const quickOpen = await runBench({
      name: "quick-open",
      warmup: 1,
      rounds: 7,
      measure: async () => {
        await startTimer(page, "yaade:bench:quick-open")
        await execCommand(page, "editor.quickOpen")
        await page.locator(PALETTE_INPUT).first().fill("index.ts")
        await waitForPaletteRows(page, "src/index.ts", 1)
        // waitForPaletteRows already proves visible, laid-out content. A
        // second animation frame measures scheduler phase rather than open
        // latency and makes the median oscillate by one full frame.
        const elapsed = await finishTimer(page, "yaade:bench:quick-open")
        await closePalette(page)
        return elapsed
      },
    })
    logBenchResult(quickOpen)
    assertBudget(quickOpen)

    await execCommand(page, "editor.quickOpen")
    await page.locator(PALETTE_INPUT).first().fill("index.ts")
    await waitForPaletteRows(page, "src/index.ts", 1)
    await expectListRows(page, {
      panel: "yaade:palette",
      minItems: 1,
      needle: "src/index.ts",
      noResultsText: "No matching files.",
    })
    await closePalette(page)

    const projectSearch = await runBench({
      name: "project-search",
      warmup: 1,
      rounds: 7,
      measure: async () => {
        await startTimer(page, "yaade:bench:project-search")
        await execCommand(page, "editor.projectSearch")
        await page.locator(PALETTE_INPUT).first().fill("greet")
        await waitForPaletteRows(page, "src/index.ts:", 2)
        const elapsed = await finishTimerAtNextFrame(
          page,
          "yaade:bench:project-search",
        )
        await closePalette(page)
        return elapsed
      },
    })
    logBenchResult(projectSearch)
    assertBudget(projectSearch)

    await execCommand(page, "editor.projectSearch")
    await page.locator(PALETTE_INPUT).first().fill("greet")
    await waitForPaletteRows(page, "src/index.ts:", 2)
    await expectListRows(page, {
      panel: "yaade:palette",
      minItems: 2,
      needle: "src/index.ts:",
      noResultsText: "No matches.",
    })
    await closePalette(page)
  } finally {
    await app.close()
  }
})

test("bench 1, 2, and 8 MiB typing with LSP disabled and enabled", async () => {
  const { app, page } = await launchJet({ withTerminal: false })
  try {
    const input = page.locator("[data-yaade-monaco-editor] textarea.inputarea")
    for (const mebibytes of [1, 2, 8]) {
      const largeFile = `.yaade-editor-bench-${mebibytes}m.ts`
      const needle = `bench_size_${mebibytes}`
      await page.evaluate(
        async ({ relativePath, sizeMiB, marker }) => {
          const root = window.__yaadeAgent!.getState().workspace
          const fs = window.yaade?.fs
          if (!root || !fs?.readTextFile || !fs.writeTextFile) {
            throw new Error("versioned text-file API unavailable")
          }
          const uri = encodeURI(`file://${root}/${relativePath}`)
          const targetBytes = sizeMiB * 1024 * 1024 + 1
          const header = `// ${marker}\n`
          const line = `// ${"x".repeat(120)}\n`
          const content =
            header +
            line
              .repeat(Math.ceil((targetBytes - header.length) / line.length))
              .slice(0, targetBytes - header.length)
          await fs.writeTextFile(uri, content, { create: true })
        },
        { relativePath: largeFile, sizeMiB: mebibytes, marker: needle },
      )
      await openFileToPaint(
        page,
        largeFile,
        needle,
        `yaade:bench:large-file-open:${mebibytes}`,
      )
      await input.focus()
      await page.keyboard.press(`${modChord()}+ArrowDown`)
      await page.evaluate(
        () =>
          new Promise<void>(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      // Monaco may replace the view-lines node when switching retained models.
      await installEditorPaintCounter(page)

      const measureTyping = async (mode: "off" | "on") => {
        const typing = await runBench({
          name: `typing-${mebibytes}m-lsp-${mode}`,
          warmup: 3,
          rounds: 30,
          measure: async () => {
            await input.focus()
            const previous = await editorInputSnapshot(page)
            await page.keyboard.type("x")
            return finishInputAtEditorPaint(page, previous, "x")
          },
        })
        logBenchResult(typing)
        assertTypingBudget(typing)
      }

      await measureTyping("off")
      await execCommand(page, "lsp.enableForCurrentFile")
      await page.waitForTimeout(100)
      await measureTyping("on")

      // Save All is an awaited command; the focused-editor save event is
      // intentionally fire-and-forget for keyboard responsiveness.
      await execCommand(page, "editor.saveAll")
      expect(
        await page.evaluate(() =>
          window.__yaadeAgent!
            .getEditorDiagnostics()
            .models.entries.some(model => model.dirty),
        ),
      ).toBe(false)
    }
  } finally {
    await app.close()
  }
})
