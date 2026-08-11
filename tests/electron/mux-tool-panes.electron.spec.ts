import { expect, test } from "@playwright/test"
import { createMockLspHarness } from "../../apps/host-server/mocks/mock-lsp-harness.js"
import { expectListRows } from "../helpers/list.js"
import { expectSelectorVisible } from "../shell/assert.js"
import {
  execCommand,
  launchJet,
  pressMuxPrefix,
} from "./_launch.js"

test.describe("persistent mux developer tools", () => {
  test("opens Buffer MRU from the planned prefix key", async () => {
    const { app, page } = await launchJet({ withTerminal: false })
    try {
      await page.evaluate(() => window.__yaadeAgent!.openFile("src/utils.ts"))
      await page.evaluate(() => window.__yaadeAgent!.waitForEditor())

      await pressMuxPrefix(page, "KeyB")
      await expectSelectorVisible(page, '[data-yaade-tool-pane="buffers"]')
      await expectListRows(page, {
        panel: "yaade:tool:buffers",
        minItems: 1,
        needle: "src/utils.ts:1",
        noResultsText: "No open buffers",
      })
      await expectSelectorVisible(
        page,
        '[data-yaade-mux-pane="yaade:tool:buffers"][data-focused]',
      )

      const paneCount = await page.locator("[data-yaade-mux-pane]").count()
      await pressMuxPrefix(page, "KeyB")
      await expectSelectorVisible(
        page,
        '[data-yaade-mux-pane="yaade:tool:buffers"][data-focused]',
      )
      await expect.poll(async () => page.locator("[data-yaade-mux-pane]").count()).toBe(
        paneCount,
      )
    } finally {
      await app.close()
    }
  })

  test("renders LSP navigation, hierarchy, problems, and output as tiled lists", async () => {
    const mock = createMockLspHarness()
    const { app, page } = await launchJet({ env: mock.env, withTerminal: false })
    try {
      await page.evaluate(() => window.__yaadeAgent!.openFile("src/index.ts"))
      await page.evaluate(() => window.__yaadeAgent!.waitForEditor())
      await mock.waitForClientMethod("textDocument/didOpen", {
        timeoutMs: 15_000,
      })

      await pressMuxPrefix(page, "KeyO")
      await mock.waitForClientMethod("textDocument/documentSymbol", {
        timeoutMs: 15_000,
      })
      await expectListRows(page, {
        panel: "yaade:tool:outline",
        minItems: 2,
        needle: "MockSymbol",
        noResultsText: "No symbols",
      })
      await execCommand(page, "mux.closePane")

      await pressMuxPrefix(page, "KeyR")
      await mock.waitForClientMethod("textDocument/references", {
        timeoutMs: 15_000,
      })
      await expectListRows(page, {
        panel: "yaade:tool:references",
        minItems: 2,
        needle: "src/index.ts:3",
        noResultsText: "No references",
      })
      await execCommand(page, "mux.closePane")

      await execCommand(page, "definitions.focus")
      await mock.waitForClientMethod("textDocument/definition", {
        timeoutMs: 15_000,
      })
      await expectListRows(page, {
        panel: "yaade:tool:definitions",
        minItems: 1,
        needle: "src/index.ts:1",
        noResultsText: "No definitions",
      })
      await execCommand(page, "mux.closePane")

      await execCommand(page, "problems.focus")
      await expectListRows(page, {
        panel: "yaade:problems",
        minItems: 1,
        needle: "Deterministic mock diagnostic",
        noResultsText: "No problems",
      })
      await execCommand(page, "mux.closePane")

      await execCommand(page, "callHierarchy.focus")
      await mock.waitForClientMethod("callHierarchy/incomingCalls", {
        timeoutMs: 15_000,
      })
      await expectListRows(page, {
        panel: "yaade:tool:call-hierarchy",
        minItems: 1,
        needle: "MockCaller",
        noResultsText: "No calls",
      })
      await execCommand(page, "mux.closePane")

      await execCommand(page, "typeHierarchy.focus")
      await mock.waitForClientMethod("typeHierarchy/supertypes", {
        timeoutMs: 15_000,
      })
      await expectListRows(page, {
        panel: "yaade:tool:type-hierarchy",
        minItems: 1,
        needle: "MockBase",
        noResultsText: "No types",
      })
      await execCommand(page, "mux.closePane")

      await execCommand(page, "lsp.output.focus")
      await page
        .getByRole("combobox", { name: "Filter language server output…" })
        .fill("register")
      await expectListRows(page, {
        panel: "yaade:tool:lsp-output",
        minItems: 1,
        needle: "client/register",
        noResultsText: "No language server output",
      })
    } finally {
      await app.close()
      mock.dispose()
    }
  })
})
