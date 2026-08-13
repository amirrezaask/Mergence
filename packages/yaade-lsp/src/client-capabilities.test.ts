import assert from "node:assert/strict"
import { test } from "node:test"

import { yaadeLspClientCapabilities } from "./client-capabilities.js"

test("advertises only semantic features implemented by the Monaco client", () => {
  const textDocument = yaadeLspClientCapabilities.textDocument

  assert.ok(textDocument.completion)
  assert.ok(textDocument.hover)
  assert.ok(textDocument.signatureHelp)
  assert.ok(textDocument.definition)
  assert.ok(textDocument.declaration)
  assert.ok(textDocument.typeDefinition)
  assert.ok(textDocument.implementation)
  assert.ok(textDocument.references)
  assert.ok(textDocument.rename)
  assert.ok(textDocument.formatting)
  assert.ok(textDocument.rangeFormatting)
  assert.ok(textDocument.documentSymbol)
  assert.ok(textDocument.codeAction)
  assert.ok(textDocument.semanticTokens)
  assert.ok(textDocument.inlayHint)
  assert.ok(textDocument.documentHighlight)
  assert.ok(textDocument.codeLens)
  assert.ok(textDocument.onTypeFormatting)
  assert.ok(textDocument.foldingRange)
  assert.ok(textDocument.selectionRange)
  assert.ok(textDocument.documentLink)
  assert.ok(textDocument.colorProvider)
  assert.ok(textDocument.callHierarchy)
  assert.ok(textDocument.typeHierarchy)
  assert.ok(textDocument.publishDiagnostics)
  assert.equal(textDocument.synchronization.dynamicRegistration, false)
  assert.equal(textDocument.synchronization.willSave, true)
  assert.equal(textDocument.synchronization.willSaveWaitUntil, true)
  assert.equal(textDocument.synchronization.didSave, true)

  assert.equal(textDocument.completion.dynamicRegistration, true)
  assert.ok(textDocument.completion.completionItem.resolveSupport)
  assert.equal(textDocument.codeAction.dynamicRegistration, true)
  assert.ok(textDocument.codeAction.resolveSupport)
  assert.deepEqual(textDocument.semanticTokens.requests, {
    range: true,
    full: { delta: true },
  })
  assert.deepEqual(yaadeLspClientCapabilities.workspace.workspaceEdit.resourceOperations, [
    "create",
    "rename",
    "delete",
  ])
  assert.equal(
    yaadeLspClientCapabilities.workspace.didChangeWatchedFiles.relativePatternSupport,
    true,
  )
  assert.equal(yaadeLspClientCapabilities.window.showDocument.support, true)
  assert.ok(yaadeLspClientCapabilities.workspace.symbol)
})
