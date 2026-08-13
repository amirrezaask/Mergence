import assert from "node:assert/strict"
import { test } from "node:test"
import type { ServerCapabilities } from "vscode-languageserver-protocol"

import { serverSupports } from "./server-capabilities.js"

test("gates Monaco providers on the server's declared capabilities", () => {
  const capabilities: ServerCapabilities = {
    documentSymbolProvider: true,
    codeActionProvider: { codeActionKinds: ["quickfix"] },
    semanticTokensProvider: {
      legend: { tokenTypes: ["variable"], tokenModifiers: [] },
      full: { delta: true },
      range: true,
    },
    documentOnTypeFormattingProvider: {
      firstTriggerCharacter: "}",
      moreTriggerCharacter: [";"],
    },
    foldingRangeProvider: true,
    selectionRangeProvider: true,
    documentLinkProvider: { resolveProvider: true },
    colorProvider: true,
    inlayHintProvider: true,
    documentRangeFormattingProvider: true,
    documentHighlightProvider: true,
    codeLensProvider: { resolveProvider: true },
    callHierarchyProvider: true,
    typeHierarchyProvider: true,
    workspaceSymbolProvider: true,
  }

  for (const method of [
    "textDocument/documentSymbol",
    "textDocument/codeAction",
    "textDocument/semanticTokens/full",
    "textDocument/semanticTokens/full/delta",
    "textDocument/semanticTokens/range",
    "textDocument/onTypeFormatting",
    "textDocument/foldingRange",
    "textDocument/selectionRange",
    "textDocument/documentLink",
    "textDocument/documentColor",
    "textDocument/inlayHint",
    "textDocument/rangeFormatting",
    "textDocument/documentHighlight",
    "textDocument/codeLens",
    "textDocument/prepareCallHierarchy",
    "textDocument/prepareTypeHierarchy",
    "workspace/symbol",
  ]) assert.equal(serverSupports(capabilities, method), true, method)

  assert.equal(serverSupports({ semanticTokensProvider: {
    legend: { tokenTypes: [], tokenModifiers: [] },
    range: true,
  } }, "textDocument/semanticTokens/full"), false)
  assert.equal(serverSupports({ semanticTokensProvider: {
    legend: { tokenTypes: [], tokenModifiers: [] },
    full: true,
  } }, "textDocument/semanticTokens/full/delta"), false)
  assert.equal(serverSupports(capabilities, "textDocument/linkedEditingRange"), false)
})
