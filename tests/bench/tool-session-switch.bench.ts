import { test } from "@playwright/test"
import { launchWeb } from "../shell/launch-web.js"
import { assertBudget, runBench } from "./_bench.js"

async function openShell(page: Awaited<ReturnType<typeof launchWeb>>["page"]): Promise<void> {
  await page.evaluate(() => {
    history.pushState(null, "", "/")
    window.dispatchEvent(new Event("popstate"))
  })
  await page.waitForSelector('[data-yaade-shell="tool-session"]')
  await page.waitForFunction(() => (window.__yaadeAgent?.getState().sessions?.length ?? 0) >= 1)
}

async function createTerminal(page: Awaited<ReturnType<typeof launchWeb>>["page"], title: string): Promise<string> {
  return page.evaluate(async nextTitle => {
    const tools = window.yaade!.tools!
    const sessionId = window.__yaadeAgent!.getState().activeSessionId!
    const project = (await tools.listProjects())[0]!
    const created = await tools.createUse({
      _tag: "CreateToolUse",
      sessionId,
      title: nextTitle,
      kind: "terminal",
      project,
      checkout: { _tag: "MainCheckout", kind: "main" },
      input: { _tag: "TerminalToolInput", kind: "terminal" },
    })
    await window.__yaadeAgent!.selectToolUse?.(created.id)
    return created.id
  }, title)
}

test("session-switch chrome updates within budget", async () => {
  const app = await launchWeb({})
  try {
    const page = app.page
    await openShell(page)
    await page.getByRole("button", { name: "New session" }).click()
    await page.waitForFunction(() => (window.__yaadeAgent?.getState().sessions?.length ?? 0) >= 2)
    const ids = await page.evaluate(() => (window.__yaadeAgent!.getState().sessions ?? []).map((session: { id: string }) => session.id))
    const result = await runBench({
      name: "session-switch",
      warmup: 1,
      rounds: 5,
      measure: async () => {
        const started = Date.now()
        await page.evaluate(async id => {
          performance.clearMarks("yaade:session-switch")
          performance.clearMeasures("yaade:session-switch")
          performance.mark("yaade:session-switch:start")
          await window.__yaadeAgent!.selectSession!(id)
          performance.mark("yaade:session-switch:end")
          performance.measure("yaade:session-switch", "yaade:session-switch:start", "yaade:session-switch:end")
        }, ids[0])
        await page.evaluate(async id => {
          performance.clearMarks("yaade:session-switch")
          performance.clearMeasures("yaade:session-switch")
          performance.mark("yaade:session-switch:start")
          await window.__yaadeAgent!.selectSession!(id)
          performance.mark("yaade:session-switch:end")
          performance.measure("yaade:session-switch", "yaade:session-switch:start", "yaade:session-switch:end")
        }, ids[1])
        const duration = await page.evaluate(() => {
          const measure = performance.getEntriesByName("yaade:session-switch").at(-1)
          return measure?.duration ?? Date.now()
        })
        return typeof duration === "number" && duration < 10_000 ? duration : Date.now() - started
      },
    })
    assertBudget(result)
  } finally {
    await app.app.close()
  }
})

test("tool-switch viewport updates within budget", async () => {
  const app = await launchWeb({})
  try {
    const page = app.page
    await openShell(page)
    const first = await createTerminal(page, "bench-a")
    const second = await createTerminal(page, "bench-b")
    await page.waitForFunction(
      ids => ids.every(id => (window.__yaadeAgent?.getState().toolUses ?? []).some((use: { id: string }) => use.id === id)),
      [first, second],
      { timeout: 20_000 },
    )
    const result = await runBench({
      name: "tool-switch",
      warmup: 1,
      rounds: 5,
      measure: async () => {
        const started = Date.now()
        const selectAndMeasure = async (id: string) => {
          await page.evaluate(async toolUseId => {
            performance.clearMarks("yaade:tool-switch")
            performance.clearMeasures("yaade:tool-switch")
            performance.mark("yaade:tool-switch:start")
            await window.__yaadeAgent!.selectToolUse!(toolUseId)
          }, id)
          await page.waitForFunction(toolUseId => {
            const tile = document.querySelector(
              `[data-yaade-tool-tile="${toolUseId}"]`,
            )
            return tile?.hasAttribute("data-focused") === true
          }, id)
          await page.evaluate(async () => {
            await new Promise<void>(resolve => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            })
            performance.mark("yaade:tool-switch:end")
            performance.measure(
              "yaade:tool-switch",
              "yaade:tool-switch:start",
              "yaade:tool-switch:end",
            )
          })
        }
        await selectAndMeasure(first)
        await selectAndMeasure(second)
        const duration = await page.evaluate(() => {
          const measure = performance.getEntriesByName("yaade:tool-switch").at(-1)
          return measure?.duration ?? Date.now()
        })
        return typeof duration === "number" && duration < 10_000 ? duration : Date.now() - started
      },
    })
    assertBudget(result)
  } finally {
    await app.app.close()
  }
})

test("search-first-result stays within budget", async () => {
  const app = await launchWeb({ workspaceRel: "fixtures/non-git-search" })
  try {
    const page = app.page
    await openShell(page)
    await page.evaluate(async () => {
      const tools = window.yaade!.tools!
      const sessionId = window.__yaadeAgent!.getState().activeSessionId!
      const project = (await tools.listProjects())[0]!
      const created = await tools.createUse({
        _tag: "CreateToolUse",
        sessionId,
        title: "bench-search",
        kind: "search",
        project,
        checkout: { _tag: "MainCheckout", kind: "main" },
        input: {
          _tag: "SearchToolInput",
          kind: "search",
          query: "nonGitSearchFixture",
          options: {},
        },
      })
      await window.__yaadeAgent!.selectToolUse?.(created.id)
    })
    await page.waitForSelector('[data-yaade-list-panel="tool-search-results"]', { timeout: 30_000 })
    const result = await runBench({
      name: "search-first-result",
      warmup: 1,
      rounds: 3,
      measure: async () => {
        const started = Date.now()
        await page.evaluate(async () => {
          performance.clearMarks("yaade:search-first-result")
          performance.clearMeasures("yaade:search-first-result")
          performance.mark("yaade:search-first-result:start")
          const use = (window.__yaadeAgent!.getState().toolUses ?? []).find((item: { kind: string }) => item.kind === "search")
          if (!use) throw new Error("missing search tool")
          const latest = await window.yaade!.tools!.getUse(use.id)
          await window.yaade!.tools!.updateUseInput({
            _tag: "UpdateToolUseInput",
            toolUseId: latest.id,
            inputRevision: latest.inputRevision,
            input: {
              _tag: "SearchToolInput",
              kind: "search",
              query: "nonGitSearchFixture",
              options: latest.input.kind === "search" ? latest.input.options : {},
            },
          })
        })
        await page.waitForFunction(() => {
          const panel = document.querySelector('[data-yaade-list-panel="tool-search-results"]')
          return [...panel?.querySelectorAll("[data-yaade-list-item]") ?? []].some(row =>
            (row.textContent ?? "").includes("nonGitSearchFixture"),
          )
        }, null, { timeout: 10_000 })
        await page.evaluate(() => {
          performance.mark("yaade:search-first-result:end")
          performance.measure("yaade:search-first-result", "yaade:search-first-result:start", "yaade:search-first-result:end")
        })
        const duration = await page.evaluate(() => {
          const measure = performance.getEntriesByName("yaade:search-first-result").at(-1)
          return measure?.duration ?? Date.now()
        })
        return typeof duration === "number" && duration < 10_000 ? duration : Date.now() - started
      },
    })
    assertBudget(result)
  } finally {
    await app.app.close()
  }
})
