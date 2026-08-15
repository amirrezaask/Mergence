import { expect, test } from "@playwright/test"
import type { ShellDriver } from "../shell/driver.js"
import { expectListRows } from "../helpers/list.js"
import { expectSelectorVisible } from "../shell/assert.js"
import {
  execCommand,
  launchJet,
  pressMuxPrefix,
  waitForMux,
} from "./_launch.js"

const explorerRows =
  '[data-yaade-list-panel="yaade:explorer"] [data-yaade-list-item]'

async function pointerDrag(
  page: ShellDriver,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 4 })
  await page.waitForTimeout(50)
  await page.mouse.move(to.x, to.y, { steps: 20 })
  await page.waitForTimeout(30)
  await page.mouse.up()
}

async function submitExplorerPrompt(page: Page, value: string): Promise<void> {
  const input = page.locator("#yaade-explorer-prompt-input")
  await input.waitFor({ state: "visible" })
  await input.fill(value)
  await input.press("Enter")
}

test.describe("persistent tiled Explorer", () => {
  test("opens from Mod-k e, focuses, zooms, drags, and restores its layout", async () => {
    const { app, page } = await launchJet()
    try {
      await pressMuxPrefix(page, "KeyE")
      await expectSelectorVisible(page, '[data-yaade-tool-pane="explorer"]')
      await expectListRows(page, {
        panel: "yaade:explorer",
        minItems: 4,
        needle: "package.json",
        noResultsText: "No results",
      })
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBe(2)
      await expectSelectorVisible(
        page,
        '[data-yaade-mux-pane="yaade:explorer"][data-focused]',
      )

      await pressMuxPrefix(page, "KeyZ")
      await expectSelectorVisible(page, "[data-yaade-mux-window][data-zoomed]")
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBe(1)
      await pressMuxPrefix(page, "KeyZ")
      await expect
        .poll(
          async () =>
            page.locator("[data-yaade-mux-window][data-zoomed]").count(),
        )
        .toBe(0)

      await pressMuxPrefix(page, "KeyH")
      await expectSelectorVisible(
        page,
        '[data-yaade-mux-pane-kind="terminal"][data-focused]',
      )
      await pressMuxPrefix(page, "KeyL")
      await expectSelectorVisible(
        page,
        '[data-yaade-mux-pane="yaade:explorer"][data-focused]',
      )

      const source = page.locator(
        '[data-yaade-mux-pane="yaade:explorer"] [data-yaade-mux-pane-drag]',
      )
      const target = page.locator('[data-yaade-mux-pane-kind="terminal"]')
      const sourceBox = await source.boundingBox()
      const targetBox = await target.boundingBox()
      expect(sourceBox).toBeTruthy()
      expect(targetBox).toBeTruthy()
      await pointerDrag(
        page,
        {
          x: sourceBox!.x + sourceBox!.width / 2,
          y: sourceBox!.y + sourceBox!.height / 2,
        },
        {
          x: targetBox!.x + targetBox!.width / 2,
          y: targetBox!.y + targetBox!.height * 0.9,
        },
      )
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBe(2)
      await expectSelectorVisible(
        page,
        '[data-yaade-mux-pane="yaade:explorer"]',
      )

      await page.waitForTimeout(900)
      await page.reload()
      await waitForMux(page)
      await expectSelectorVisible(page, '[data-yaade-tool-pane="explorer"]')
      await expect
        .poll(async () => page.locator("[data-yaade-mux-pane]").count())
        .toBe(2)
      await expectListRows(page, {
        panel: "yaade:explorer",
        minItems: 4,
        needle: "package.json",
        noResultsText: "No results",
      })
    } finally {
      await app.close()
    }
  })

  test("creates, renames, trashes, restores-as, and empties through Explorer", async () => {
    const { app, page } = await launchJet({
      withTerminal: false,
      expectedHttpErrors: [
        { method: "POST", path: "/api/v1/rpc", status: 409 },
      ],
    })
    try {
      await execCommand(page, "explorer.focus")
      await expectSelectorVisible(page, '[data-yaade-tool-pane="explorer"]')
      await expectListRows(page, {
        panel: "yaade:explorer",
        minItems: 4,
        needle: "package.json",
        noResultsText: "No results",
      })

      await execCommand(page, "explorer.createFolder")
      await submitExplorerPrompt(page, "explorer-e2e")
      const folderRow = page.locator(explorerRows).filter({
        hasText: "explorer-e2e",
      })
      await expect.poll(async () => folderRow.count()).toBeGreaterThan(0)
      await folderRow.click()

      await execCommand(page, "explorer.createFile")
      await submitExplorerPrompt(page, "created.txt")
      await execCommand(page, "explorer.focus")
      const createdRow = page.locator(explorerRows).filter({
        hasText: "created.txt",
      })
      await expect.poll(async () => createdRow.count()).toBeGreaterThan(0)
      await createdRow.click({ button: "right" })
      await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
      await submitExplorerPrompt(page, "renamed.txt")
      await execCommand(page, "explorer.focus")
      const renamedRow = page.locator(explorerRows).filter({
        hasText: "renamed.txt",
      })
      await expect.poll(async () => renamedRow.count()).toBeGreaterThan(0)
      await renamedRow.click({ button: "right" })
      await page
        .getByRole("menuitem", {
          name: "Move to YAADE Trash",
          exact: true,
        })
        .click()
      await expect
        .poll(async () =>
          page.getByRole("button", { name: "Move to Trash", exact: true }).count(),
        )
        .toBeGreaterThan(0)
      await page
        .getByRole("button", { name: "Move to Trash", exact: true })
        .click()
      await expect.poll(async () => renamedRow.count()).toBe(0)

      await page.evaluate(async () => {
        const root = window.__yaadeAgent!.getState().workspace!
        await window.yaade!.fs.createFile(
          encodeURI(`file://${root}/explorer-e2e/renamed.txt`),
        )
      })

      await execCommand(page, "explorer.restore")
      await expectListRows(page, {
        panel: "yaade:palette",
        minItems: 1,
        needle: "renamed.txt",
        noResultsText: "YAADE Trash is empty",
      })
      await page
        .locator('[data-yaade-list-panel="yaade:palette"] [data-yaade-list-item]')
        .filter({ hasText: "renamed.txt" })
        .click()
      await expect
        .poll(async () =>
          page.getByRole("heading", { name: /Restore renamed\.txt As/ }).count(),
        )
        .toBeGreaterThan(0)
      await submitExplorerPrompt(page, "restored-as.txt")

      await execCommand(page, "explorer.focus")
      await expect
        .poll(async () =>
          page
            .locator(explorerRows)
            .filter({ hasText: "restored-as.txt" })
            .count(),
        )
        .toBeGreaterThan(0)

      await page.evaluate(async () => {
        const root = window.__yaadeAgent!.getState().workspace!
        const uri = encodeURI(`file://${root}/explorer-e2e/empty-me.txt`)
        await window.yaade!.fs.createFile(uri)
        await window.yaade!.fs.trash(uri)
      })
      await execCommand(page, "explorer.emptyTrash")
      await expect
        .poll(async () =>
          page.getByRole("button", { name: "Empty Trash", exact: true }).count(),
        )
        .toBeGreaterThan(0)
      await page
        .getByRole("button", { name: "Empty Trash", exact: true })
        .click()
      await expect
        .poll(async () => page.evaluate(() => window.yaade!.fs.listTrash()))
        .toEqual([])
    } finally {
      await app.close()
    }
  })
})
