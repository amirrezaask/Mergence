import type { ServerCapabilities } from "vscode-languageserver-protocol"

export function capabilityEnabled(value: unknown): boolean {
  return value === true || (typeof value === "object" && value != null)
}

export function hasFullSemanticTokens(capabilities: ServerCapabilities): boolean {
  const provider = capabilities.semanticTokensProvider
  return typeof provider === "object" && provider != null && Boolean(provider.full)
}

export function hasSemanticTokenDelta(capabilities: ServerCapabilities): boolean {
  const provider = capabilities.semanticTokensProvider
  return typeof provider === "object"
    && provider != null
    && typeof provider.full === "object"
    && provider.full != null
    && provider.full.delta === true
}

export function hasRangeSemanticTokens(capabilities: ServerCapabilities): boolean {
  const provider = capabilities.semanticTokensProvider
  return typeof provider === "object" && provider != null && Boolean(provider.range)
}

export function serverSupports(capabilities: ServerCapabilities, method: string): boolean {
  switch (method) {
    case "textDocument/completion": return capabilities.completionProvider != null
    case "textDocument/hover": return capabilityEnabled(capabilities.hoverProvider)
    case "textDocument/signatureHelp": return capabilities.signatureHelpProvider != null
    case "textDocument/declaration": return capabilityEnabled(capabilities.declarationProvider)
    case "textDocument/definition": return capabilityEnabled(capabilities.definitionProvider)
    case "textDocument/typeDefinition": return capabilityEnabled(capabilities.typeDefinitionProvider)
    case "textDocument/implementation": return capabilityEnabled(capabilities.implementationProvider)
    case "textDocument/references": return capabilityEnabled(capabilities.referencesProvider)
    case "textDocument/rename": return capabilityEnabled(capabilities.renameProvider)
    case "textDocument/formatting": return capabilityEnabled(capabilities.documentFormattingProvider)
    case "textDocument/rangeFormatting": return capabilityEnabled(capabilities.documentRangeFormattingProvider)
    case "textDocument/documentSymbol": return capabilityEnabled(capabilities.documentSymbolProvider)
    case "textDocument/codeAction": return capabilityEnabled(capabilities.codeActionProvider)
    case "textDocument/semanticTokens/full": return hasFullSemanticTokens(capabilities)
    case "textDocument/semanticTokens/full/delta": return hasSemanticTokenDelta(capabilities)
    case "textDocument/semanticTokens/range": return hasRangeSemanticTokens(capabilities)
    case "textDocument/onTypeFormatting": return capabilities.documentOnTypeFormattingProvider != null
    case "textDocument/foldingRange": return capabilityEnabled(capabilities.foldingRangeProvider)
    case "textDocument/selectionRange": return capabilityEnabled(capabilities.selectionRangeProvider)
    case "textDocument/documentLink": return capabilities.documentLinkProvider != null
    case "textDocument/documentColor": return capabilityEnabled(capabilities.colorProvider)
    case "textDocument/inlayHint": return capabilityEnabled(capabilities.inlayHintProvider)
    case "textDocument/documentHighlight": return capabilityEnabled(capabilities.documentHighlightProvider)
    case "textDocument/codeLens": return capabilities.codeLensProvider != null
    case "textDocument/prepareCallHierarchy": return capabilityEnabled(capabilities.callHierarchyProvider)
    case "textDocument/prepareTypeHierarchy": return capabilityEnabled(capabilities.typeHierarchyProvider)
    case "workspace/symbol": return capabilityEnabled(capabilities.workspaceSymbolProvider)
    default: return false
  }
}
