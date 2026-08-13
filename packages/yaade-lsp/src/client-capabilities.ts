/** Initialize params capabilities advertised to language servers. */
export const yaadeLspClientCapabilities = {
  textDocument: {
    synchronization: {
      dynamicRegistration: false,
      willSave: true,
      willSaveWaitUntil: true,
      didSave: true,
    },
    completion: {
      dynamicRegistration: true,
      completionItem: {
        snippetSupport: true,
        documentationFormat: ["markdown", "plaintext"],
        resolveSupport: {
          properties: [
            "detail",
            "documentation",
            "additionalTextEdits",
            "command",
          ],
        },
      },
    },
    hover: { contentFormat: ["markdown", "plaintext"] },
    signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"] } },
    definition: { linkSupport: true },
    declaration: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    rename: { prepareSupport: true },
    formatting: {},
    rangeFormatting: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    codeAction: {
      dynamicRegistration: true,
      codeActionLiteralSupport: {
        codeActionKind: { valueSet: ["", "quickfix", "refactor", "source"] },
      },
      resolveSupport: { properties: ["edit", "command"] },
    },
    semanticTokens: {
      dynamicRegistration: true,
      requests: { range: true, full: { delta: true } },
      tokenTypes: [
        "namespace", "type", "class", "enum", "interface", "struct", "typeParameter",
        "parameter", "variable", "property", "enumMember", "event", "function", "method",
        "macro", "label", "comment", "string", "keyword", "number", "regexp", "operator",
        "decorator",
      ],
      tokenModifiers: [
        "declaration", "definition", "readonly", "static", "deprecated", "abstract",
        "async", "modification", "documentation", "defaultLibrary",
      ],
      formats: ["relative"],
    },
    inlayHint: {},
    documentHighlight: {},
    codeLens: {},
    onTypeFormatting: { dynamicRegistration: true },
    foldingRange: { dynamicRegistration: true, lineFoldingOnly: true },
    selectionRange: { dynamicRegistration: true },
    documentLink: { dynamicRegistration: true, tooltipSupport: true },
    colorProvider: { dynamicRegistration: true },
    callHierarchy: { dynamicRegistration: false },
    typeHierarchy: { dynamicRegistration: false },
    publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
  },
  workspace: {
    applyEdit: true,
    workspaceEdit: {
      documentChanges: true,
      resourceOperations: ["create", "rename", "delete"],
      failureHandling: "transactional",
    },
    didChangeWatchedFiles: {
      dynamicRegistration: true,
      relativePatternSupport: true,
    },
    workspaceFolders: true,
    configuration: true,
    symbol: { dynamicRegistration: false },
  },
  window: {
    showMessage: { messageActionItem: { additionalPropertiesSupport: true } },
    showDocument: { support: true },
    workDoneProgress: true,
  },
  general: { progress: true },
} as const
