import { test, expect } from "@playwright/test"
import type { ShellDriver } from "../shell/driver.js"
import {
  assertBudget,
  logBenchResult,
  median,
  percentile,
  runBench,
  type BenchResult,
} from "./_bench.js"
import {
  focusTerminal,
  hasPtySpawn,
  launchJet,
  showTerminal,
} from "../electron/_launch.js"

const ptyAvailable = hasPtySpawn()

async function waitForRunningTerminal(page: ShellDriver): Promise<void> {
  await expect(
    page.locator('[data-yaade-terminal-panel][data-yaade-terminal-status="running"]'),
  ).toBeVisible({ timeout: 15_000 })
}

async function terminalRenderer(page: ShellDriver): Promise<string> {
  return page.evaluate(
    () =>
      document.querySelector<HTMLElement>("[data-yaade-terminal-panel]")
        ?.dataset.yaadeTerminalRenderer ?? "unknown",
  )
}

async function resetTerminalForStreamSample(
  page: ShellDriver,
  resetMarker: string,
): Promise<void> {
  await page.evaluate(async currentMarker => {
    const panel = document.querySelector<HTMLElement>(
      '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
    )
    const ptyId = panel?.dataset.yaadeTerminalPtyId
    const terminal = window.yaade?.terminal
    if (!ptyId || !terminal) throw new Error("running terminal unavailable")

    // Keep the complete marker out of the echoed command. It must only become
    // visible after the shell executes printf and Ghostty parses the RIS reset.
    const splitAt = Math.floor(currentMarker.length / 2)
    const markerExpression =
      `'${currentMarker.slice(0, splitAt)}'` +
      `'${currentMarker.slice(splitAt)}'`
    await terminal.write(
      ptyId,
      `printf '\\033c%s\\n' ${markerExpression}\n`,
    )
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error(`terminal reset did not parse: ${currentMarker}`)),
        10_000,
      )
      const poll = () => {
        const text = window.__yaadeAgent?.getTerminalText?.() ?? ""
        if (text.includes(currentMarker)) {
          window.clearTimeout(timeout)
          resolve()
          return
        }
        requestAnimationFrame(poll)
      }
      poll()
    })
  }, resetMarker)
}

test("bench terminal-stream-throughput", async () => {
  test.skip(!ptyAvailable, "node-pty cannot spawn a shell on this machine")

  const { app, page } = await launchJet()
  try {
    await showTerminal(page)
    await waitForRunningTerminal(page)
    console.log(`[bench] terminal-stream renderer=${await terminalRenderer(page)}`)

    let round = 0
    const result = await runBench({
      name: "terminal-stream-throughput",
      warmup: 2,
      rounds: 5,
      measure: async () => {
        const sample = round++
        await resetTerminalForStreamSample(
          page,
          `YAADE-TERMINAL-RESET-${sample}`,
        )
        const marker = `YAADE-TERMINAL-BENCH-${sample}`
        return page.evaluate(async currentMarker => {
          const panel = document.querySelector<HTMLElement>(
            '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
          )
          const ptyId = panel?.dataset.yaadeTerminalPtyId
          const terminal = window.yaade?.terminal
          if (!ptyId || !terminal) throw new Error("running terminal unavailable")

          let tail = ""
          let unsubscribe = () => {}
          const markerArrived = new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(() => {
              unsubscribe()
              reject(new Error(`terminal marker did not arrive: ${currentMarker}`))
            }, 30_000)
            unsubscribe = terminal.onData(ptyId, data => {
              const combined = `${tail}${data}`
              if (!combined.includes(currentMarker)) {
                tail = combined.slice(-currentMarker.length * 2)
                return
              }
              window.clearTimeout(timeout)
              unsubscribe()
              resolve()
            })
          })
          // Adjacent shell literals evaluate to the marker, while their quote
          // boundary prevents PTY command echo from satisfying markerArrived.
          const splitAt = Math.floor(currentMarker.length / 2)
          const markerExpression =
            `'${currentMarker.slice(0, splitAt)}'` +
            `'${currentMarker.slice(splitAt)}'`
          const startedAt = performance.now()
          await terminal.write(
            ptyId,
            `head -c 1048576 /dev/zero | tr '\\0' x; printf '\\n%s\\n' ${markerExpression}\n`,
          )
          await markerArrived
          return performance.now() - startedAt
        }, marker)
      },
    })
    logBenchResult(result)
    assertBudget(result)
  } finally {
    await app.close()
  }
})

/**
 * Agent/TUI-like flood: many small CSI + CR rewrite frames (not one fat blob).
 * Exercises rAF coalesce + GPU renderer under Cursor-style paint storms.
 */
test("bench terminal-agent-flood-throughput", async () => {
  test.skip(!ptyAvailable, "node-pty cannot spawn a shell on this machine")

  const { app, page } = await launchJet()
  try {
    await showTerminal(page)
    await waitForRunningTerminal(page)

    let round = 0
    const result = await runBench({
      name: "terminal-agent-flood-throughput",
      warmup: 2,
      rounds: 5,
      measure: async () => {
        const marker = `YAADE-AGENT-FLOOD-${round++}`
        return page.evaluate(async currentMarker => {
          const panel = document.querySelector<HTMLElement>(
            '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
          )
          const ptyId = panel?.dataset.yaadeTerminalPtyId
          const terminal = window.yaade?.terminal
          if (!ptyId || !terminal) throw new Error("running terminal unavailable")

          // Generate the flood in the PTY so host batching matches real agent CLIs
          // (many small onData chunks), not one giant RPC write.
          // Keep the marker split in the command; terminal text includes the shell echo.
          const markerSplit = Math.floor(currentMarker.length / 2)
          const markerExpression =
            `(${JSON.stringify(currentMarker.slice(0, markerSplit))} + ` +
            `${JSON.stringify(currentMarker.slice(markerSplit))})`
          const pythonCode =
            `import sys; [sys.stdout.write(("\\x1b[?25l" if i % 2 == 0 else "\\x1b[?25h") + f"\\rprogress {i}/2000   ") or (sys.stdout.flush() if i % 16 == 0 else None) for i in range(2000)]; sys.stdout.write("\\r\\n" + ${markerExpression} + "\\n"); sys.stdout.flush()`
          const script = `python3 -c ${JSON.stringify(pythonCode)}\n`

          const startedAt = performance.now()
          await terminal.write(ptyId, script)
          await new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(
              () => reject(new Error(`agent flood marker did not paint: ${currentMarker}`)),
              30_000,
            )
            const poll = () => {
              const text = window.__yaadeAgent?.getTerminalText?.() ?? ""
              if (text.includes(currentMarker)) {
                window.clearTimeout(timeout)
                requestAnimationFrame(() => resolve())
                return
              }
              requestAnimationFrame(poll)
            }
            poll()
          })
          return performance.now() - startedAt
        }, marker)
      },
    })
    logBenchResult(result)
    assertBudget(result)
  } finally {
    await app.close()
  }
})

/**
 * Idle key → echo paint. Target ≤1 frame (16ms median) — VS Code local feel.
 */
test("bench terminal-typing-idle", async () => {
  test.skip(!ptyAvailable, "node-pty cannot spawn a shell on this machine")

  const { app, page } = await launchJet()
  try {
    await showTerminal(page)
    await waitForRunningTerminal(page)

    await focusTerminal(page)

    let idleRound = 0
    const result = await runBench({
      name: "terminal-typing-idle",
      warmup: 2,
      rounds: 8,
      measure: async () => {
        await focusTerminal(page)
        // Unique needle — shell redraw can keep total string length stable.
        const marker = `Id${idleRound++}z`
        const t0 = await page.evaluate(() => performance.now())
        await page.keyboard.type(marker, { delay: 0 })
        await page.waitForFunction(
          needle =>
            (window.__yaadeAgent?.getTerminalText?.() ?? "").includes(needle),
          marker,
          { timeout: 10_000 },
        )
        const t1 = await page.evaluate(
          () =>
            new Promise<number>(resolve => {
              requestAnimationFrame(() => resolve(performance.now()))
            }),
        )
        // Per-key estimate: total / chars typed (marker length).
        return (t1 - t0) / marker.length
      },
    })
    logBenchResult(result)
    assertBudget(result)
  } finally {
    await app.close()
  }
})

/**
 * Main-thread input scheduling while a Cursor-style TUI flood is in flight.
 * Raw samples are aggregated once; a second rAF and nested percentiles would
 * add a synthetic floor and amplify one stall into every reported percentile.
 */
test("bench terminal-typing-under-flood", async () => {
  test.skip(!ptyAvailable, "node-pty cannot spawn a shell on this machine")

  const { app, page } = await launchJet()
  try {
    await showTerminal(page)
    await waitForRunningTerminal(page)

    const renderer = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>(
        "[data-yaade-terminal-panel]",
      )
      return panel?.dataset.yaadeTerminalRenderer ?? "unknown"
    })
    console.log(`[bench] terminal-under-flood renderer=${renderer}`)
    expect(renderer).toBe("ghostty")

    const samples = await page.evaluate(async () => {
          const panel = document.querySelector<HTMLElement>(
            '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
          )
          const ptyId = panel?.dataset.yaadeTerminalPtyId
          const terminal = window.yaade?.terminal
          const textarea = panel?.querySelector<HTMLTextAreaElement>(
            "[data-ghostty-terminal-input]",
          )
          if (!ptyId || !terminal || !textarea) {
            throw new Error("running terminal input unavailable")
          }

          // One continuous flood keeps every sample under one workload.
          const flood = [
            "python3 - <<'PY'",
            "import sys, time",
            "end = time.time() + 2.5",
            "i = 0",
            "while time.time() < end:",
            "    hide = i % 2 == 0",
            "    sys.stdout.write(('\\x1b[?25l' if hide else '\\x1b[?25h') + f'\\rprogress {i}   ')",
            "    if i % 8 == 0:",
            "        sys.stdout.flush()",
            "    i += 1",
            "sys.stdout.write('\\r\\n')",
            "sys.stdout.flush()",
            "PY",
            "",
          ].join("\n")
          await terminal.write(ptyId, flood)

          // Let flood hit the renderer before measuring key latency.
          await new Promise<void>(r => setTimeout(r, 80))

          textarea.focus()
          const samples: number[] = []
          for (let n = 0; n < 40; n++) {
            const t0 = performance.now()
            textarea.dispatchEvent(
              new InputEvent("beforeinput", {
                bubbles: true,
                cancelable: true,
                inputType: "insertText",
                data: "x",
              }),
            )
            // Hidden IME input path used for synthetic browser input events.
            textarea.value = "x"
            textarea.dispatchEvent(
              new InputEvent("input", { bubbles: true, data: "x" }),
            )
            await new Promise<void>(resolve => {
              requestAnimationFrame(() => resolve())
            })
            samples.push(performance.now() - t0)
            await new Promise<void>(r => setTimeout(r, 16))
          }
          return samples
        })
    const result: BenchResult = {
      name: "terminal-typing-under-flood",
      median: median(samples),
      p95: percentile(samples, 0.95),
      p99: percentile(samples, 0.99),
      samples,
    }
    logBenchResult(result)
    assertBudget(result)
  } finally {
    await app.close()
  }
})
