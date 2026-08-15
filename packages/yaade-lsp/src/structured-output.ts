/** Keep LSP output useful without retaining whole documents or workspace edits. */
export function structuredOutputData(method: string, data: unknown): unknown {
  if (!data || typeof data !== "object") return data
  if (method === "textDocument/didSave") {
    const text = Object.entries(data).find(([name]) => name === "text")?.[1]
    return {
      textDocument: Object.entries(data).find(([name]) => name === "textDocument")?.[1],
      includeText: typeof text === "string",
      ...(typeof text === "string" ? { textLength: text.length } : {}),
    }
  }
  if (method === "textDocument/publishDiagnostics") {
    const diagnostics = Object.entries(data).find(([name]) => name === "diagnostics")?.[1]
    return {
      uri: Object.entries(data).find(([name]) => name === "uri")?.[1],
      version: Object.entries(data).find(([name]) => name === "version")?.[1],
      diagnosticCount: Array.isArray(diagnostics) ? diagnostics.length : 0,
    }
  }
  if (method === "workspace/applyEdit") {
    const edit = Object.entries(data).find(([name]) => name === "edit")?.[1]
    const changes = edit && typeof edit === "object"
      ? Object.entries(edit).find(([name]) => name === "changes")?.[1]
      : undefined
    const documentChanges = edit && typeof edit === "object"
      ? Object.entries(edit).find(([name]) => name === "documentChanges")?.[1]
      : undefined
    return {
      changedDocumentCount: changes && typeof changes === "object"
        ? Object.keys(changes).length
        : 0,
      documentChangeCount: Array.isArray(documentChanges) ? documentChanges.length : 0,
    }
  }
  return data
}
