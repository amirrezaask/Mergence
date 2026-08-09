import { expect, test } from "@playwright/test";
import {
  createMockLspHarness,
  mockLspMessageField,
} from "../../apps/host-server/mocks/mock-lsp-harness.js";
import { expectListRows } from "../helpers/list.js";
import {
  expectLocatorContainsText,
  expectLocatorCount,
} from "../shell/assert.js";
import { execCommand, launchJet } from "./_launch.js";

test("host-owned LSP resolves, opens, and restores the exact connection after crash", async () => {
  const mock = createMockLspHarness();
  const { page, app } = await launchJet({ env: mock.env, withTerminal: false });
  try {
    await page.evaluate(() => window.__yaadeAgent!.openFile("src/index.ts"));
    await page.evaluate(() => window.__yaadeAgent!.waitForEditor());

    const initialize = await mock.waitForClientMethod("initialize", {
      timeoutMs: 15_000,
    });
    const firstOpen = await mock.waitForClientMethod("textDocument/didOpen", {
      timeoutMs: 15_000,
    });
    const initializeParams = mockLspMessageField(initialize.message, "params");
    const firstOpenParams = mockLspMessageField(firstOpen.message, "params");
    const firstDocument = mockLspMessageField(firstOpenParams, "textDocument");
    expect(mockLspMessageField(initializeParams, "rootUri")).toMatch(
      /^file:.*sample-workspace/,
    );
    expect(mockLspMessageField(firstDocument, "languageId")).toBe("typescript");
    const registration = await mock.waitForServerMethod(
      "client/registerCapability",
      {
        timeoutMs: 15_000,
      },
    );
    const registrationId = mockLspMessageField(registration.message, "id");
    const registrations = mockLspMessageField(
      mockLspMessageField(registration.message, "params"),
      "registrations",
    );
    expect(
      Array.isArray(registrations)
        ? registrations.map((item) => mockLspMessageField(item, "method"))
        : [],
    ).toEqual(["textDocument/didSave", "workspace/didChangeWatchedFiles"]);
    await mock.waitForCapture(
      (capture) =>
        capture.direction === "client" &&
        mockLspMessageField(capture.message, "id") === registrationId &&
        mockLspMessageField(capture.message, "method") === undefined,
      { timeoutMs: 15_000 },
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__yaadeAgent!.getEditorDiagnostics().models.entries[0]
              ?.lspOwnerCount ?? 0,
        ),
      )
      .toBe(1);

    const editorInput = page.locator(
      "[data-yaade-monaco-editor] textarea.inputarea",
    );
    await editorInput.focus();
    await page.keyboard.type(" ");
    await expect
      .poll(() =>
        page.evaluate(() => window.__yaadeAgent!.getState().activeEditorDirty),
      )
      .toBe(true);
    const beforeSave = mock.captures().length;
    await page.evaluate(() =>
      window.__yaadeAgent!.executeCommand("editor.save"),
    );
    await mock.waitForClientMethod("textDocument/didSave", {
      timeoutMs: 15_000,
      afterCaptureCount: beforeSave,
    });
    const saveMethods = mock
      .captures()
      .slice(beforeSave)
      .flatMap((capture) => {
        if (capture.direction !== "client") return [];
        const method = mockLspMessageField(capture.message, "method");
        return typeof method === "string" ? [method] : [];
      });
    expect(saveMethods.indexOf("textDocument/willSave")).toBeGreaterThanOrEqual(
      0,
    );
    expect(
      saveMethods.indexOf("textDocument/willSaveWaitUntil"),
    ).toBeGreaterThan(saveMethods.indexOf("textDocument/willSave"));
    expect(saveMethods.indexOf("textDocument/didSave")).toBeGreaterThan(
      saveMethods.indexOf("textDocument/willSaveWaitUntil"),
    );
    const didSave = mock.clientMessages("textDocument/didSave").at(-1);
    expect(
      typeof mockLspMessageField(
        mockLspMessageField(didSave?.message, "params"),
        "text",
      ),
    ).toBe("string");
    await expect
      .poll(() =>
        page.evaluate(() => window.__yaadeAgent!.getState().activeEditorDirty),
      )
      .toBe(false);

    const watchedUri = await page.evaluate(async () => {
      const root = window.__yaadeAgent!.getState().workspace;
      const uri = encodeURI(`file://${root}/src/lsp-watched-file.ts`);
      await window.yaade!.fs.writeTextFile(uri, "export const watched = 1\n", {
        create: true,
      });
      return uri;
    });
    const waitForWatchedChange = (type: number, afterCaptureCount: number) =>
      mock.waitForCapture(
        (capture) => {
          if (capture.direction !== "client") return false;
          if (
            mockLspMessageField(capture.message, "method") !==
            "workspace/didChangeWatchedFiles"
          ) {
            return false;
          }
          const changes = mockLspMessageField(
            mockLspMessageField(capture.message, "params"),
            "changes",
          );
          return (
            Array.isArray(changes) &&
            changes.some(
              (change) =>
                mockLspMessageField(change, "uri") === watchedUri &&
                mockLspMessageField(change, "type") === type,
            )
          );
        },
        { timeoutMs: 15_000, afterCaptureCount },
      );
    await waitForWatchedChange(1, beforeSave);

    const beforeChange = mock.captures().length;
    await page.evaluate(async (uri) => {
      const fs = window.yaade!.fs;
      const current = await fs.readTextFile(uri);
      await fs.writeTextFile(uri, "export const watched = 2\n", {
        expectedVersion: current.version,
      });
    }, watchedUri);
    await waitForWatchedChange(2, beforeChange);

    const beforeDelete = mock.captures().length;
    await page.evaluate((uri) => window.yaade!.fs.trash(uri), watchedUri);
    await waitForWatchedChange(3, beforeDelete);

    const catalog = await page.evaluate(() =>
      window.yaade!.lsp.listDefinitions(),
    );
    expect(
      catalog.some(
        (definition) => definition.id === "typescript-language-server",
      ),
    ).toBe(true);
    expect(
      catalog.every(
        (definition) => Object.keys(definition.environment).length === 0,
      ),
    ).toBe(true);

    const captureCount = mock.captures().length;
    mock.crash(1, 72);
    await mock.waitForStartCount(2, 15_000);
    const reopened = await mock.waitForClientMethod("textDocument/didOpen", {
      timeoutMs: 15_000,
      afterCaptureCount: captureCount,
    });
    expect(reopened.generation).toBe(2);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__yaadeAgent!.getEditorDiagnostics().models.entries[0]
              ?.lspOwnerCount ?? 0,
        ),
      )
      .toBe(1);

    const logs = await page.evaluate(() =>
      window.yaade!.lsp.logs({ limit: 20 }),
    );
    expect(
      logs.some((entry) => entry.serverId === "typescript-language-server"),
    ).toBe(true);
  } finally {
    await app.close();
    mock.dispose();
  }
});

test("LSP browser surface handles diagnostics, navigation, interaction, and progress", async () => {
  const mock = createMockLspHarness();
  const { page, app } = await launchJet({ env: mock.env, withTerminal: false });
  try {
    await page.evaluate(() => window.__yaadeAgent!.openFile("src/index.ts"));
    await page.evaluate(() => window.__yaadeAgent!.waitForEditor());
    await mock.waitForClientMethod("textDocument/didOpen", {
      timeoutMs: 15_000,
    });

    await execCommand(page, "problems.focus");
    await expectListRows(page, {
      panel: "yaade:problems",
      minItems: 1,
      needle: "Deterministic mock diagnostic",
      noResultsText: "No problems",
    });
    await execCommand(page, "mux.closePane");

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__yaadeAgent!.getEditorDiagnostics().models.entries.find(
              (entry) => entry.uri.endsWith("/src/index.ts"),
            )?.lspOwnerCount ?? 0,
        ),
      )
      .toBe(1);
    // Click the visible editor before focusing Monaco's hidden textarea. A
    // programmatic textarea focus alone does not always activate Monaco after
    // closing an adjacent tool pane.
    await page.locator("[data-yaade-monaco-editor]").last().click();
    await page
      .locator("[data-yaade-monaco-editor] textarea.inputarea")
      .last()
      .focus();
    await page.evaluate(() => window.__yaadeAgent!.setEditorSelection(1, 2));
    await page.keyboard.press("Control+Space");
    await mock.waitForClientMethod("textDocument/completion", {
      timeoutMs: 15_000,
    });
    const suggestWidget = page.locator(".suggest-widget");
    await suggestWidget.waitFor({ state: "visible" });
    await expectLocatorContainsText(suggestWidget, "mockCompletion");
    await suggestWidget
      .getByText("mockCompletion", { exact: false })
      .first()
      .hover();
    await mock.waitForClientMethod("completionItem/resolve", {
      timeoutMs: 15_000,
    });
    await page.keyboard.press("Escape");

    await execCommand(page, "definitions.focus");
    await mock.waitForClientMethod("textDocument/definition", {
      timeoutMs: 15_000,
    });
    await expectListRows(page, {
      panel: "yaade:tool:definitions",
      minItems: 1,
      needle: "src/index.ts:1",
      noResultsText: "No definitions",
    });
    await page
      .locator(
        '[data-yaade-list-panel="yaade:tool:definitions"] [data-yaade-list-item]',
      )
      .first()
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__yaadeAgent!.getEditorDiagnostics().editors.activeUri,
        ),
      )
      .toMatch(/\/src\/index\.ts$/);

    await page.evaluate(() => window.__yaadeAgent!.setEditorSelection(1, 2));
    await page.evaluate(() =>
      window.__yaadeAgent!.executeCommand("editor.action.rename"),
    );
    await mock.waitForClientMethod("textDocument/prepareRename", {
      timeoutMs: 15_000,
    });
    const renameInput = page.locator(".rename-box input.rename-input");
    await renameInput.waitFor({ state: "visible" });
    await renameInput.fill("RenamedByBrowser");
    await renameInput.press("Enter");
    await mock.waitForClientMethod("textDocument/rename", {
      timeoutMs: 15_000,
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window
              .__yaadeAgent!.getEditorDiagnostics()
              .models.entries.find((entry) =>
                entry.uri.endsWith("/src/index.ts"),
              )?.content ?? "",
        ),
      )
      .toContain("RenamedByBrowser");

    await execCommand(page, "workspaceSymbols.focus");
    const workspaceSymbolSearch = page.getByRole("textbox", {
      name: "Search workspace symbols",
    });
    await workspaceSymbolSearch.fill("Mock");
    await mock.waitForClientMethod("workspace/symbol", { timeoutMs: 15_000 });
    await expectListRows(page, {
      panel: "yaade:tool:workspace-symbols",
      minItems: 1,
      needle: "MockWorkspaceSymbol",
      noResultsText: "No workspace symbols",
    });

    const beforeMessageRequest = mock.captures().length;
    mock.showMessageRequest("Choose from the browser actions", {
      generation: 1,
    });
    const messageRequest = await mock.waitForServerMethod(
      "window/showMessageRequest",
      {
        timeoutMs: 15_000,
        afterCaptureCount: beforeMessageRequest,
      },
    );
    const messageRequestId = mockLspMessageField(messageRequest.message, "id");
    const messageDialog = page.locator("[data-yaade-lsp-message-request]");
    await expectLocatorContainsText(
      messageDialog,
      "Choose from the browser actions",
    );
    await messageDialog
      .getByRole("button", { name: "Accept", exact: true })
      .click();
    const messageResponse = await mock.waitForCapture(
      (capture) =>
        capture.direction === "client" &&
        mockLspMessageField(capture.message, "id") === messageRequestId &&
        mockLspMessageField(capture.message, "method") === undefined,
      { timeoutMs: 15_000, afterCaptureCount: beforeMessageRequest },
    );
    expect(messageResponse.direction).toBe("client");
    if (messageResponse.direction === "client") {
      expect(
        mockLspMessageField(
          mockLspMessageField(messageResponse.message, "result"),
          "title",
        ),
      ).toBe("Accept");
    }

    const utilsUri = await page.evaluate(() => {
      const root = window.__yaadeAgent!.getState().workspace;
      if (!root) throw new Error("workspace unavailable");
      return encodeURI(`file://${root}/src/utils.ts`);
    });
    const beforeShowDocument = mock.captures().length;
    mock.showDocument(utilsUri, { generation: 1 });
    const showDocument = await mock.waitForServerMethod("window/showDocument", {
      timeoutMs: 15_000,
      afterCaptureCount: beforeShowDocument,
    });
    const showDocumentId = mockLspMessageField(showDocument.message, "id");
    await mock.waitForCapture(
      (capture) =>
        capture.direction === "client" &&
        mockLspMessageField(capture.message, "id") === showDocumentId &&
        mockLspMessageField(capture.message, "method") === undefined &&
        mockLspMessageField(
          mockLspMessageField(capture.message, "result"),
          "success",
        ) === true,
      { timeoutMs: 15_000, afterCaptureCount: beforeShowDocument },
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__yaadeAgent!.getEditorDiagnostics().editors.activeUri,
        ),
      )
      .toMatch(/\/src\/utils\.ts$/);

    await execCommand(page, "lsp.output.focus");
    const beforeProgress = mock.captures().length;
    mock.workDoneProgress("Indexing from the browser", { generation: 1 });
    await mock.waitForServerMethod("$/progress", {
      timeoutMs: 15_000,
      afterCaptureCount: beforeProgress,
    });
    const progress = page.locator("[data-yaade-lsp-progress]");
    await expectLocatorContainsText(progress, "Indexing from the browser");
    await progress.getByRole("button", { name: "Cancel", exact: true }).click();
    await mock.waitForClientMethod("window/workDoneProgress/cancel", {
      timeoutMs: 15_000,
      afterCaptureCount: beforeProgress,
    });
    await expectLocatorCount(progress, 0);

    await page
      .getByRole("combobox", { name: "Filter language server output…" })
      .fill("workDoneProgress/cancel");
    await expectListRows(page, {
      panel: "yaade:tool:lsp-output",
      minItems: 1,
      needle: "window/workDoneProgress/cancel",
      noResultsText: "No language server output",
    });
  } finally {
    await app.close();
    mock.dispose();
  }
});

test("LSP resource edits atomically remap a clean open buffer", async () => {
  const mock = createMockLspHarness();
  const { page, app } = await launchJet({ env: mock.env, withTerminal: false });
  try {
    const uris = await page.evaluate(async () => {
      const root = window.__yaadeAgent!.getState().workspace;
      if (!root) throw new Error("workspace unavailable");
      const oldUri = encodeURI(`file://${root}/src/lsp-resource-old.ts`);
      const newUri = encodeURI(`file://${root}/src/lsp-resource-new.ts`);
      await window.yaade!.fs.writeTextFile(
        oldUri,
        "export const resourceValue = 1\n",
        { create: true },
      );
      await window.__yaadeAgent!.openFile(oldUri);
      return { oldUri, newUri };
    });
    await page.evaluate(() => window.__yaadeAgent!.waitForEditor());
    await mock.waitForClientMethod("textDocument/didOpen", {
      timeoutMs: 15_000,
    });

    const before = mock.captures().length;
    mock.applyWorkspaceEdit({
      documentChanges: [
        { kind: "rename", oldUri: uris.oldUri, newUri: uris.newUri },
        {
          textDocument: { uri: uris.newUri, version: null },
          edits: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
              },
              newText: "// edited by mock LSP\n",
            },
          ],
        },
      ],
    });
    const request = await mock.waitForServerMethod("workspace/applyEdit", {
      timeoutMs: 15_000,
      afterCaptureCount: before,
    });
    const requestId = mockLspMessageField(request.message, "id");
    await mock.waitForCapture(
      capture =>
        capture.direction === "client" &&
        mockLspMessageField(capture.message, "id") === requestId &&
        mockLspMessageField(
          mockLspMessageField(capture.message, "result"),
          "applied",
        ) === true,
      { timeoutMs: 15_000, afterCaptureCount: before },
    );

    await expect
      .poll(() =>
        page.evaluate(async ({ oldUri, newUri }) => {
          const diagnostics = window.__yaadeAgent!.getEditorDiagnostics();
          const model = diagnostics.models.entries.find(
            entry => entry.uri === newUri,
          );
          return {
            oldExists: await window.yaade!.fs.exists(oldUri),
            newDisk: (await window.yaade!.fs.readTextFile(newUri)).content,
            oldOpen: diagnostics.editors.openBuffers.includes(oldUri),
            newOpen: diagnostics.editors.openBuffers.includes(newUri),
            content: model?.content ?? "",
            dirty: model?.dirty ?? false,
            owners:
              model?.owners.filter(owner => owner.startsWith("buffer:")) ?? [],
          };
        }, uris),
      )
      .toEqual({
        oldExists: false,
        newDisk: "export const resourceValue = 1\n",
        oldOpen: false,
        newOpen: true,
        content: "// edited by mock LSP\nexport const resourceValue = 1\n",
        dirty: true,
        owners: [expect.stringContaining("mux-editor-")],
      });
  } finally {
    await app.close();
    mock.dispose();
  }
});
