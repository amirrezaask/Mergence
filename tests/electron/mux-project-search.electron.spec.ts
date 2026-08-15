import { expect, test } from "@playwright/test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expectListRows } from "../helpers/list.js"
import {
  expectNotContainsText,
  expectLocatorHidden,
  expectLocatorCount,
  expectLocatorVisible,
} from "../shell/assert.js"
import { execCommand, launchJet, waitForMux } from "./_launch.js"

async function expectMonacoShowsFile(
  page: import("@playwright/test").Page,
  relativePath: string,
  needle: string,
  line?: number,
) {
  await waitForMux(page)
  await expect
    .poll(() =>
      page.evaluate(
        rel =>
          window.__yaadeAgent!.getEditorDiagnostics().editors.openBuffers.some(uri =>
            uri.endsWith(`/${rel}`),
          ),
        relativePath,
      ),
    )
    .toBe(true)
  await expectLocatorVisible(
    page.locator(`[data-yaade-mux-editor-uri$="/${relativePath}"]`),
  )
  await expectLocatorVisible(page.locator("[data-yaade-monaco-editor]"))
  await expect
    .poll(async () => {
      return page.evaluate(text => {
        const monaco = document.querySelector("[data-yaade-monaco-editor]")
        if (!monaco) return { ok: false, reason: "missing-monaco" }
        const rect = monaco.getBoundingClientRect()
        if (rect.width < 80 || rect.height < 80) {
          return { ok: false, reason: `size-${rect.width}x${rect.height}` }
        }
        const lines = Array.from(monaco.querySelectorAll(".view-line")).map(
          el => el.textContent ?? "",
        )
        if (!lines.some(lineText => lineText.includes(text))) {
          return { ok: false, reason: `missing-text:${lines.join("|")}` }
        }
        return { ok: true, reason: "ok" }
      }, needle)
    })
    .toEqual({ ok: true, reason: "ok" })
  if (line != null) {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const editors = window.__yaadeAgent!.getEditorDiagnostics().editors.entries
          const focused =
            editors.find(editor => editor.focused) ?? editors[0] ?? null
          return focused?.position?.line ?? null
        }),
      )
      .toBe(line)
  }
}

test.describe("project search", () => {
  test("opens a result after search creates the editor session", async () => {
    const { app, page } = await launchJet({
      workspaceRel: "fixtures/non-git-search",
      projectPage: true,
      withTerminal: false,
    })
    try {
      await page.locator("[data-yaade-project-search-create]").click()
      await expectLocatorVisible(page.locator('[data-yaade-search-results="fullscreen"]'))
      await page.locator("[data-yaade-project-search-input]").fill("nonGitSearchFixture")
      await expectListRows(page, {
        panel: "project-search",
        minItems: 1,
        needle: "nonGitSearchFixture",
        noResultsText: "No matches.",
      })
      await page.locator('[data-yaade-project-search-hit="src/index.ts:2"]').click()
      await expectLocatorVisible(page.locator('[data-yaade-search-results="rail"]'))
      await expectMonacoShowsFile(page, "src/index.ts", "nonGitSearchFixture", 2)
      await expectNotContainsText(
        page,
        '[data-yaade-project-surface="editors"]',
        "No open editors in this worktree.",
      )
    } finally {
      await app.close()
    }
  })

  test("sidebar search lists hits and opens Monaco on click", async () => {
    const { app, page } = await launchJet({
      workspaceRel: "fixtures/non-git-search",
      withTerminal: false,
    })
    try {
      await waitForMux(page)

      await execCommand(page, "editor.projectSearch")
      await expectLocatorVisible(page.locator('[data-yaade-search-results="fullscreen"]'))
      await expectLocatorVisible(page.locator("[data-yaade-project-search-panel]"))
      await expectLocatorVisible(page.locator("[data-yaade-project-searches-group]"))

      const input = page.locator("[data-yaade-project-search-input]")
      await input.fill("nonGitSearchFixture")
      await expect
        .poll(
          async () =>
            page.locator('[data-yaade-list-panel="project-search"] [data-yaade-list-item]').count(),
          { timeout: 15_000 },
        )
        .toBeGreaterThanOrEqual(1)
      await expectListRows(page, {
        panel: "project-search",
        minItems: 1,
        needle: "nonGitSearchFixture",
        noResultsText: "No matches.",
      })
      await expect
        .poll(() => page.getByRole("status", { name: "Loading" }).count())
        .toBe(0)
      await expectLocatorVisible(
        page.locator('[data-yaade-project-search-hit="src/index.ts:2"]'),
      )
      await expectLocatorVisible(page.locator("[data-yaade-project-search-chunk]"))
      await expect
        .poll(async () =>
          page
            .locator('[data-yaade-project-search-file="src/index.ts"]')
            .getAttribute("data-yaade-project-search-file-loaded"),
        )
        .toBe("1")
      await expect
        .poll(async () =>
          page.locator('[data-yaade-project-search-chunk] [data-yaade-list-item]').count(),
        )
        .toBeGreaterThanOrEqual(1)

      await page
        .locator('[data-yaade-list-panel="project-search"] [data-yaade-list-item]')
        .first()
        .click()

      await expectLocatorHidden(page.locator('[data-yaade-search-results="fullscreen"]'))
      await expectLocatorVisible(page.locator('[data-yaade-search-results="rail"]'))
      await expectMonacoShowsFile(page, "src/index.ts", "nonGitSearchFixture", 1)
      await expectLocatorCount(page.locator('[data-yaade-modal-editor-tab][data-preview]'), 1)
      await expect.poll(() => page.evaluate(() => location.href)).toMatch(/file=src%2Findex\.ts/)

      await expectLocatorVisible(
        page.locator("[data-yaade-project-search-item]").first(),
      )

      await page.evaluate(() => history.back())
      await expect.poll(() => page.evaluate(() => location.href.includes("file="))).toBe(false)
      await expectLocatorVisible(page.locator('[data-yaade-search-results="fullscreen"]'))
      await expectLocatorVisible(
        page.locator('[data-yaade-list-panel="project-search"] [data-selected]'),
      )
      await expect
        .poll(() =>
          page.locator('[data-yaade-list-panel="project-search"] [data-selected]').evaluate(
            element => element === document.activeElement,
          ),
        )
        .toBe(true)

      await page.evaluate(() => history.forward())
      await expect.poll(() => page.evaluate(() => location.href)).toMatch(/file=src%2Findex\.ts/)
      await expectLocatorVisible(page.locator('[data-yaade-search-results="rail"]'))
      await expectMonacoShowsFile(page, "src/index.ts", "nonGitSearchFixture", 1)
    } finally {
      await app.close()
    }
  })

  test("broad searches stop at a bounded page without a fake loading spinner", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-broad-search-"))
    fs.writeFileSync(
      path.join(project, "broad-results.txt"),
      Array.from(
        { length: 520 },
        (_, index) => `broadNeedle result-row-${String(index).padStart(3, "0")}`,
      ).join("\n"),
    )

    const { app, page } = await launchJet({
      workspaceRel: project,
      withTerminal: false,
    })
    try {
      await waitForMux(page)
      await execCommand(page, "editor.projectSearch")
      await page.locator("[data-yaade-project-search-input]").fill("broadNeedle")

      await expectListRows(page, {
        panel: "project-search",
        minItems: 2,
        needle: "result-row-001",
        noResultsText: "No matches.",
      })
      await expectLocatorVisible(
        page.locator('[data-yaade-project-search-hit="broad-results.txt:1"]'),
      )
      await expectLocatorVisible(page.getByRole("button", { name: "Load more matches" }))
      await expect
        .poll(() => page.getByRole("status", { name: "Loading" }).count())
        .toBe(0)
      await expect
        .poll(async () =>
          (await page
            .locator('[data-yaade-list-panel="project-search"]')
            .textContent()) ?? "",
        )
        .not.toContain("Loading more matches")
    } finally {
      await app.close()
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  test("search tabs survive reload and clean previews are replaced", async () => {
    const { app, page } = await launchJet({
      workspaceRel: "fixtures/non-git-search",
      withTerminal: false,
    })
    try {
      await waitForMux(page)
      await execCommand(page, "editor.projectSearch")
      const input = page.locator("[data-yaade-project-search-input]")
      await input.fill("export const")
      await expectListRows(page, {
        panel: "project-search",
        minItems: 2,
        needle: "excludedSearchFixture",
        noResultsText: "No matches.",
      })

      await page.locator('[data-yaade-project-search-hit="src/index.ts:2"]').click()
      await expectLocatorVisible(page.locator('[data-yaade-search-results="rail"]'))
      await expectMonacoShowsFile(page, "src/index.ts", "nonGitSearchFixture", 2)
      await expectLocatorCount(page.locator('[data-yaade-modal-editor-tab][data-preview]'), 1)

      await page.locator('[data-yaade-project-search-hit="src/other.ts:1"]').click()
      await expectMonacoShowsFile(page, "src/other.ts", "excludedSearchFixture", 1)
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__yaadeAgent!.getEditorDiagnostics().editors.openBuffers.filter(uri =>
              uri.endsWith("/src/index.ts") || uri.endsWith("/src/other.ts"),
            ),
          ),
        )
        .toEqual([expect.stringMatching(/\/src\/other\.ts$/)])
      await expectLocatorCount(page.locator('[data-yaade-modal-editor-tab][data-preview]'), 1)

      await page.evaluate(() => history.back())
      await expect
        .poll(() => page.evaluate(() => new URL(location.href).searchParams.get("file")))
        .toBe("src/index.ts")
      await page.evaluate(() => history.back())
      await expectLocatorVisible(page.locator('[data-yaade-search-results="fullscreen"]'))
      await expect.poll(() => page.evaluate(() => new URL(location.href).searchParams.get("q"))).toBe("export const")
      await page.reload()
      await expectLocatorVisible(page.locator('[data-yaade-search-results="fullscreen"]'))
      await expect
        .poll(() =>
          page.locator("[data-yaade-project-search-input]").evaluate(
            element => (element as HTMLInputElement).value,
          ),
        )
        .toBe("export const")
      await expectListRows(page, {
        panel: "project-search",
        minItems: 2,
        needle: "nonGitSearchFixture",
        noResultsText: "No matches.",
      })
    } finally {
      await app.close()
    }
  })

  test("double-click pins a search preview tab", async () => {
    const { app, page } = await launchJet({
      workspaceRel: "fixtures/non-git-search",
      withTerminal: false,
    })
    try {
      await waitForMux(page)
      await execCommand(page, "editor.projectSearch")
      await page.locator("[data-yaade-project-search-input]").fill("nonGitSearchFixture")
      await expectLocatorVisible(
        page.locator('[data-yaade-project-search-hit="src/index.ts:2"]'),
      )
      await page.evaluate(() => {
        const hit = document.querySelector<HTMLElement>(
          '[data-yaade-project-search-hit="src/index.ts:2"]',
        )
        hit?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, detail: 2 }),
        )
      })
      await expectLocatorVisible(page.locator('[data-yaade-search-results="rail"]'))
      await expectMonacoShowsFile(page, "src/index.ts", "nonGitSearchFixture", 2)
      await expectLocatorCount(page.locator('[data-yaade-modal-editor-tab][data-preview]'), 0)
      await expectLocatorCount(page.locator("[data-yaade-modal-editor-tab]"), 1)
    } finally {
      await app.close()
    }
  })
})
