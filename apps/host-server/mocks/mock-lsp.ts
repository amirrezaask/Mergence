#!/usr/bin/env tsx
/**
 * Deterministic Language Server Protocol peer for unit, integration, and E2E tests.
 *
 * The process speaks standard Content-Length framed JSON-RPC over stdio. Protocol
 * traffic is optionally mirrored to a JSONL capture file, while a second JSONL
 * file provides out-of-band crash/restart and notification controls. Stdout is
 * reserved exclusively for LSP frames.
 *
 * Environment:
 *   YAADE_MOCK_LSP_CAPTURE_PATH  append-only protocol/event capture
 *   YAADE_MOCK_LSP_CONTROL_PATH  append-only control commands
 *   YAADE_MOCK_LSP_STATE_DIR     one marker per process generation
 *
 * Usage:
 *   apps/host-server/mocks/bin/yaade-mock-lsp --stdio
 */
import fs from "node:fs";
import path from "node:path";

type JsonRpcId = string | number | null;
type Direction = "client" | "server";

type DocumentState = {
  languageId: string;
  text: string;
  version: number | null;
};

type ControlCommand =
  | "crash"
  | "restart"
  | "publishDiagnostics"
  | "registerCapability"
  | "showMessage"
  | "showMessageRequest"
  | "showDocument"
  | "applyWorkspaceEdit"
  | "workDoneProgress"
  | "finishWorkDoneProgress";

const capturePath = process.env.YAADE_MOCK_LSP_CAPTURE_PATH?.trim() || null;
const controlPath = process.env.YAADE_MOCK_LSP_CONTROL_PATH?.trim() || null;
const stateDir = process.env.YAADE_MOCK_LSP_STATE_DIR?.trim() || null;
const documents = new Map<string, DocumentState>();

let inputBuffer = Buffer.alloc(0);
let rootUri = "file:///mock-workspace";
let nextServerRequest = 1;
let controlOffset = 0;
let shuttingDown = false;
const activeProgressTokens = new Set<string | number>();

function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return Object.entries(value).find(([name]) => name === key)?.[1];
}

function stringField(value: unknown, key: string): string | undefined {
  const result = field(value, key);
  return typeof result === "string" ? result : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  const result = field(value, key);
  return typeof result === "number" && Number.isFinite(result)
    ? result
    : undefined;
}

function arrayField(value: unknown, key: string): readonly unknown[] {
  const result = field(value, key);
  return Array.isArray(result) ? result : [];
}

function hasField(value: unknown, key: string): boolean {
  return (
    value !== null && typeof value === "object" && Object.hasOwn(value, key)
  );
}

function rpcId(value: unknown): JsonRpcId | undefined {
  return typeof value === "string" ||
    typeof value === "number" ||
    value === null
    ? value
    : undefined;
}

function appendJsonLine(filePath: string | null, value: unknown): void {
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`yaade-mock-lsp: capture failed: ${message}\n`);
  }
}

function allocateGeneration(dir: string | null): number {
  if (!dir) return 1;
  fs.mkdirSync(dir, { recursive: true });
  for (let generation = 1; generation < 100_000; generation += 1) {
    const marker = path.join(
      dir,
      `${String(generation).padStart(6, "0")}.started`,
    );
    try {
      fs.writeFileSync(marker, "started\n", { encoding: "utf8", flag: "wx" });
      return generation;
    } catch (error) {
      const code =
        error !== null && typeof error === "object"
          ? field(error, "code")
          : undefined;
      if (code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("mock LSP generation limit exceeded");
}

const generation = allocateGeneration(stateDir);

function capture(direction: Direction, message: unknown): void {
  appendJsonLine(capturePath, { generation, direction, message });
}

function captureEvent(event: string, details?: unknown): void {
  appendJsonLine(capturePath, {
    generation,
    direction: "event",
    event,
    ...(details === undefined ? {} : { details }),
  });
}

function writeMessage(message: unknown): void {
  capture("server", message);
  const json = JSON.stringify(message);
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`,
  );
}

function respond(id: JsonRpcId, result: unknown): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function respondError(id: JsonRpcId, code: number, message: string): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method: string, params: unknown): void {
  writeMessage({ jsonrpc: "2.0", method, params });
}

function request(method: string, params: unknown): string {
  const id = `mock-server-${nextServerRequest}`;
  nextServerRequest += 1;
  writeMessage({ jsonrpc: "2.0", id, method, params });
  return id;
}

function documentUri(params: unknown): string {
  return (
    stringField(field(params, "textDocument"), "uri") ??
    stringField(field(params, "item"), "uri") ??
    `${rootUri}/mock.ts`
  );
}

function position(
  line = 0,
  character = 0,
): { line: number; character: number } {
  return { line, character };
}

function range(
  startLine = 0,
  startCharacter = 0,
  endLine = 0,
  endCharacter = 4,
): {
  start: { line: number; character: number };
  end: { line: number; character: number };
} {
  return {
    start: position(startLine, startCharacter),
    end: position(endLine, endCharacter),
  };
}

function location(
  uri: string,
  line = 0,
): { uri: string; range: ReturnType<typeof range> } {
  return { uri, range: range(line, 0, line, 4) };
}

function positionToOffset(
  text: string,
  line: number,
  character: number,
): number {
  if (line <= 0) return Math.min(Math.max(character, 0), text.length);
  let offset = 0;
  let currentLine = 0;
  while (offset < text.length && currentLine < line) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return text.length;
    offset = next + 1;
    currentLine += 1;
  }
  return Math.min(offset + Math.max(character, 0), text.length);
}

function applyContentChanges(
  text: string,
  changes: readonly unknown[],
): string {
  let nextText = text;
  for (const change of changes) {
    const replacement = stringField(change, "text") ?? "";
    const changeRange = field(change, "range");
    if (changeRange === undefined || changeRange === null) {
      nextText = replacement;
      continue;
    }
    const start = field(changeRange, "start");
    const end = field(changeRange, "end");
    const startOffset = positionToOffset(
      nextText,
      numberField(start, "line") ?? 0,
      numberField(start, "character") ?? 0,
    );
    const endOffset = positionToOffset(
      nextText,
      numberField(end, "line") ?? 0,
      numberField(end, "character") ?? 0,
    );
    nextText = `${nextText.slice(0, startOffset)}${replacement}${nextText.slice(endOffset)}`;
  }
  return nextText;
}

function documentEnd(text: string): { line: number; character: number } {
  const lines = text.split("\n");
  const line = Math.max(0, lines.length - 1);
  return position(line, lines[line]?.length ?? 0);
}

function formattedText(text: string): string {
  const normalized = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function publishDiagnostics(
  uri: string,
  message = "Deterministic mock diagnostic",
): void {
  const document = documents.get(uri);
  notify("textDocument/publishDiagnostics", {
    uri,
    ...(document?.version == null ? {} : { version: document.version }),
    diagnostics: [
      {
        range: range(),
        severity: 2,
        code: "mock-warning",
        source: "yaade-mock-lsp",
        message,
        relatedInformation: [
          {
            location: location(uri, 0),
            message: "Mock related information",
          },
        ],
      },
    ],
  });
}

function registerDynamicCapability(): void {
  const registrationId = `mock-did-save-registration-${nextServerRequest}`;
  request("client/registerCapability", {
    registrations: [
      {
        id: registrationId,
        method: "textDocument/didSave",
        registerOptions: {
          documentSelector: [
            { scheme: "file", language: "typescript" },
            { scheme: "file", language: "javascript" },
          ],
          includeText: true,
        },
      },
      {
        id: `mock-watch-registration-${nextServerRequest}`,
        method: "workspace/didChangeWatchedFiles",
        registerOptions: {
          watchers: [{ globPattern: "**/*.{ts,tsx}", kind: 7 }],
        },
      },
    ],
  });
}

function hierarchyItem(uri: string, name = "MockSymbol"): unknown {
  return {
    name,
    kind: 12,
    detail: "Deterministic mock hierarchy item",
    uri,
    range: range(),
    selectionRange: range(),
    data: { mockHierarchy: true },
  };
}

function initializeResult(): unknown {
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: 2,
        willSave: true,
        willSaveWaitUntil: true,
        save: { includeText: true },
      },
      completionProvider: {
        resolveProvider: true,
        triggerCharacters: ["."],
      },
      hoverProvider: true,
      signatureHelpProvider: { triggerCharacters: ["(", ","] },
      declarationProvider: true,
      definitionProvider: true,
      typeDefinitionProvider: true,
      implementationProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      documentSymbolProvider: true,
      codeActionProvider: {
        codeActionKinds: ["quickfix", "refactor", "source"],
        resolveProvider: true,
      },
      documentOnTypeFormattingProvider: {
        firstTriggerCharacter: "}",
        moreTriggerCharacter: [";"],
      },
      semanticTokensProvider: {
        legend: { tokenTypes: ["function"], tokenModifiers: ["declaration"] },
        full: { delta: true },
        range: true,
      },
      foldingRangeProvider: true,
      selectionRangeProvider: true,
      documentLinkProvider: { resolveProvider: true },
      colorProvider: true,
      inlayHintProvider: true,
      documentHighlightProvider: true,
      codeLensProvider: { resolveProvider: true },
      callHierarchyProvider: true,
      typeHierarchyProvider: true,
      workspaceSymbolProvider: true,
      executeCommandProvider: {
        commands: ["yaade.mock.echo", "yaade.mock.crash", "yaade.mock.restart"],
      },
      workspace: {
        workspaceFolders: { supported: true, changeNotifications: true },
      },
    },
    serverInfo: { name: "yaade-mock-lsp", version: "1.0.0" },
  };
}

function handleRequest(id: JsonRpcId, method: string, params: unknown): void {
  const uri = documentUri(params);
  const document = documents.get(uri);
  switch (method) {
    case "initialize": {
      rootUri = stringField(params, "rootUri") ?? rootUri;
      respond(id, initializeResult());
      break;
    }
    case "shutdown": {
      shuttingDown = true;
      respond(id, null);
      break;
    }
    case "textDocument/completion": {
      respond(id, {
        isIncomplete: false,
        items: [
          {
            label: "mockCompletion",
            kind: 3,
            detail: "Unresolved mock completion",
            insertText: "mockCompletion(${1:value})",
            insertTextFormat: 2,
            sortText: "0000",
            data: { mockCompletionId: "completion-1" },
          },
        ],
      });
      break;
    }
    case "completionItem/resolve": {
      respond(id, {
        label: stringField(params, "label") ?? "mockCompletion",
        kind: numberField(params, "kind") ?? 3,
        detail: "Resolved mock completion",
        documentation: {
          kind: "markdown",
          value: "Resolved by **yaade-mock-lsp**.",
        },
        insertText:
          stringField(params, "insertText") ?? "mockCompletion(${1:value})",
        insertTextFormat: numberField(params, "insertTextFormat") ?? 2,
        data: field(params, "data") ?? { mockCompletionId: "completion-1" },
      });
      break;
    }
    case "textDocument/hover": {
      respond(id, {
        contents: {
          kind: "markdown",
          value: "`MockSymbol`: deterministic hover",
        },
        range: range(),
      });
      break;
    }
    case "textDocument/signatureHelp": {
      respond(id, {
        signatures: [
          {
            label: "mockFunction(value: string): string",
            documentation: "Deterministic mock signature",
            parameters: [{ label: [13, 26], documentation: "Mock value" }],
          },
        ],
        activeSignature: 0,
        activeParameter: 0,
      });
      break;
    }
    case "textDocument/declaration":
    case "textDocument/definition":
    case "textDocument/typeDefinition":
    case "textDocument/implementation": {
      respond(id, [location(uri)]);
      break;
    }
    case "textDocument/references": {
      respond(id, [location(uri, 0), location(uri, 2)]);
      break;
    }
    case "textDocument/prepareRename": {
      respond(id, { range: range(), placeholder: "mock" });
      break;
    }
    case "textDocument/rename": {
      const newName = stringField(params, "newName") ?? "renamedMock";
      respond(id, {
        changes: {
          [uri]: [
            { range: range(0, 0, 0, 4), newText: newName },
            { range: range(2, 0, 2, 4), newText: newName },
          ],
        },
      });
      break;
    }
    case "textDocument/formatting": {
      respond(id, [
        {
          range: { start: position(), end: documentEnd(document?.text ?? "") },
          newText: formattedText(document?.text ?? "mock\n"),
        },
      ]);
      break;
    }
    case "textDocument/rangeFormatting": {
      const requestedRange = field(params, "range") ?? range();
      respond(id, [{ range: requestedRange, newText: "mockFormatted" }]);
      break;
    }
    case "textDocument/willSaveWaitUntil": {
      respond(id, []);
      break;
    }
    case "textDocument/documentSymbol": {
      respond(id, [
        {
          name: "MockSymbol",
          detail: "deterministic symbol",
          kind: 12,
          range: range(0, 0, 3, 0),
          selectionRange: range(),
          children: [
            {
              name: "mockValue",
              detail: "nested symbol",
              kind: 13,
              range: range(1, 0, 1, 9),
              selectionRange: range(1, 0, 1, 9),
            },
          ],
        },
      ]);
      break;
    }
    case "textDocument/codeAction": {
      respond(id, [
        {
          title: "Apply deterministic mock fix",
          kind: "quickfix",
          isPreferred: true,
          data: { mockCodeActionId: "fix-1", uri },
        },
      ]);
      break;
    }
    case "codeAction/resolve": {
      const data = field(params, "data");
      const editUri = stringField(data, "uri") ?? uri;
      respond(id, {
        title: stringField(params, "title") ?? "Apply deterministic mock fix",
        kind: stringField(params, "kind") ?? "quickfix",
        isPreferred: field(params, "isPreferred") ?? true,
        data: data ?? { mockCodeActionId: "fix-1", uri: editUri },
        edit: {
          changes: { [editUri]: [{ range: range(), newText: "fixed" }] },
        },
        command: {
          title: "Report deterministic mock fix",
          command: "yaade.mock.echo",
          arguments: ["code-action-resolved"],
        },
      });
      break;
    }
    case "textDocument/onTypeFormatting": {
      const requestedPosition = field(params, "position");
      const line = numberField(requestedPosition, "line") ?? 0;
      const character = numberField(requestedPosition, "character") ?? 0;
      respond(id, [
        {
          range: range(line, character, line, character),
          newText: " // mock on-type",
        },
      ]);
      break;
    }
    case "textDocument/semanticTokens/full": {
      respond(id, { resultId: "mock-semantic-1", data: [0, 0, 4, 0, 1] });
      break;
    }
    case "textDocument/semanticTokens/full/delta": {
      respond(id, {
        resultId: "mock-semantic-2",
        edits: [{ start: 0, deleteCount: 5, data: [0, 0, 4, 0, 1] }],
      });
      break;
    }
    case "textDocument/semanticTokens/range": {
      respond(id, { data: [0, 0, 4, 0, 1] });
      break;
    }
    case "textDocument/foldingRange": {
      respond(id, [{ startLine: 0, endLine: 2, kind: "region" }]);
      break;
    }
    case "textDocument/selectionRange": {
      respond(
        id,
        arrayField(params, "positions").map((requestedPosition) => {
          const line = numberField(requestedPosition, "line") ?? 0;
          const character = numberField(requestedPosition, "character") ?? 0;
          return {
            range: range(line, character, line, character + 1),
            parent: { range: range(line, 0, line, Math.max(character + 1, 4)) },
          };
        }),
      );
      break;
    }
    case "textDocument/documentLink": {
      respond(id, [
        {
          range: range(0, 0, 0, 4),
          tooltip: "Resolve deterministic mock link",
          data: { mockDocumentLinkId: "link-1" },
        },
      ]);
      break;
    }
    case "documentLink/resolve": {
      respond(id, {
        range: field(params, "range") ?? range(0, 0, 0, 4),
        target: "https://example.test/yaade-mock-lsp",
        tooltip: "Resolved deterministic mock link",
        data: field(params, "data") ?? { mockDocumentLinkId: "link-1" },
      });
      break;
    }
    case "textDocument/documentColor": {
      respond(id, [
        {
          range: range(0, 0, 0, 4),
          color: { red: 0.25, green: 0.5, blue: 0.75, alpha: 1 },
        },
      ]);
      break;
    }
    case "textDocument/colorPresentation": {
      const requestedRange = field(params, "range") ?? range(0, 0, 0, 4);
      respond(id, [
        {
          label: "rgba(64, 128, 191, 1)",
          textEdit: { range: requestedRange, newText: "rgba(64, 128, 191, 1)" },
        },
      ]);
      break;
    }
    case "textDocument/inlayHint": {
      respond(id, [
        {
          position: position(0, 4),
          label: ": MockType",
          kind: 1,
          paddingLeft: true,
          tooltip: "Deterministic mock inlay hint",
        },
      ]);
      break;
    }
    case "textDocument/documentHighlight": {
      respond(id, [
        { range: range(), kind: 2 },
        { range: range(2, 0, 2, 4), kind: 3 },
      ]);
      break;
    }
    case "textDocument/codeLens": {
      respond(id, [
        {
          range: range(0, 0, 0, 0),
          data: { mockCodeLens: true },
        },
      ]);
      break;
    }
    case "codeLens/resolve": {
      respond(id, {
        range: field(params, "range") ?? range(0, 0, 0, 0),
        command: {
          title: "Run mock command",
          command: "yaade.mock.echo",
          arguments: ["code-lens"],
        },
      });
      break;
    }
    case "textDocument/prepareCallHierarchy":
    case "textDocument/prepareTypeHierarchy": {
      respond(id, [hierarchyItem(uri)]);
      break;
    }
    case "callHierarchy/incomingCalls": {
      respond(id, [
        {
          from: hierarchyItem(uri, "MockCaller"),
          fromRanges: [range(2, 0, 2, 4)],
        },
      ]);
      break;
    }
    case "callHierarchy/outgoingCalls": {
      respond(id, [
        {
          to: hierarchyItem(uri, "MockCallee"),
          fromRanges: [range()],
        },
      ]);
      break;
    }
    case "typeHierarchy/supertypes": {
      respond(id, [hierarchyItem(uri, "MockBase")]);
      break;
    }
    case "typeHierarchy/subtypes": {
      respond(id, [hierarchyItem(uri, "MockDerived")]);
      break;
    }
    case "workspace/symbol": {
      respond(id, [
        {
          name: "MockWorkspaceSymbol",
          kind: 12,
          containerName: "yaade-mock-lsp",
          location: location(`${rootUri}/src/index.ts`, 1),
        },
      ]);
      break;
    }
    case "workspace/executeCommand": {
      const command = stringField(params, "command") ?? "";
      respond(id, { command, arguments: arrayField(params, "arguments") });
      if (command === "yaade.mock.crash" || command === "yaade.mock.restart") {
        const exitCode = command.endsWith("restart") ? 86 : 1;
        setImmediate(() =>
          controlledExit(
            command.endsWith("restart") ? "restart" : "crash",
            exitCode,
          ),
        );
      }
      break;
    }
    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }
}

function handleNotification(method: string, params: unknown): void {
  const uri = documentUri(params);
  switch (method) {
    case "initialized":
      registerDynamicCapability();
      notify("window/showMessage", {
        type: 3,
        message: `Mock language server initialized (generation ${generation})`,
      });
      notify("$/progress", {
        token: "mock-startup",
        value: { kind: "end", message: "Mock indexing complete" },
      });
      break;
    case "textDocument/didOpen": {
      const textDocument = field(params, "textDocument");
      documents.set(uri, {
        languageId: stringField(textDocument, "languageId") ?? "plaintext",
        text: stringField(textDocument, "text") ?? "",
        version: numberField(textDocument, "version") ?? null,
      });
      publishDiagnostics(uri);
      break;
    }
    case "textDocument/didChange": {
      const current = documents.get(uri) ?? {
        languageId: "plaintext",
        text: "",
        version: null,
      };
      const textDocument = field(params, "textDocument");
      current.text = applyContentChanges(
        current.text,
        arrayField(params, "contentChanges"),
      );
      current.version = numberField(textDocument, "version") ?? current.version;
      documents.set(uri, current);
      publishDiagnostics(uri, "Deterministic diagnostic after change");
      break;
    }
    case "textDocument/didSave": {
      const current = documents.get(uri) ?? {
        languageId: "plaintext",
        text: "",
        version: null,
      };
      const savedText = stringField(params, "text");
      if (savedText !== undefined) current.text = savedText;
      documents.set(uri, current);
      publishDiagnostics(uri, "Deterministic diagnostic after save");
      notify("window/showMessage", {
        type: 3,
        message: `Mock observed save: ${uri}`,
      });
      break;
    }
    case "textDocument/didClose":
      documents.delete(uri);
      notify("textDocument/publishDiagnostics", { uri, diagnostics: [] });
      break;
    case "exit":
      process.exit(shuttingDown ? 0 : 1);
      break;
    case "$/cancelRequest":
      captureEvent("cancel-request", { id: field(params, "id") });
      break;
    case "window/workDoneProgress/cancel": {
      const token = field(params, "token");
      captureEvent("progress-cancel", { token });
      if (typeof token === "string" || typeof token === "number") {
        activeProgressTokens.delete(token);
        notify("$/progress", {
          token,
          value: { kind: "end", message: "Mock work cancelled" },
        });
      }
      break;
    }
    default:
      break;
  }
}

function handleMessage(message: unknown): void {
  capture("client", message);
  const method = stringField(message, "method");
  if (!method) return;
  const params = field(message, "params");
  if (hasField(message, "id")) {
    const id = rpcId(field(message, "id"));
    if (id !== undefined) handleRequest(id, method, params);
    return;
  }
  handleNotification(method, params);
}

function feedInput(chunk: Buffer): void {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  for (;;) {
    const headerEnd = inputBuffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = inputBuffer.subarray(0, headerEnd).toString("latin1");
    const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
    if (!lengthMatch) {
      process.stderr.write("yaade-mock-lsp: missing Content-Length header\n");
      process.exit(1);
      return;
    }
    const byteLength = Number.parseInt(lengthMatch[1] ?? "", 10);
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      byteLength > 10 * 1024 * 1024
    ) {
      process.stderr.write("yaade-mock-lsp: invalid Content-Length header\n");
      process.exit(1);
      return;
    }
    const bodyStart = headerEnd + 4;
    if (inputBuffer.length < bodyStart + byteLength) return;
    const body = inputBuffer
      .subarray(bodyStart, bodyStart + byteLength)
      .toString("utf8");
    inputBuffer = inputBuffer.subarray(bodyStart + byteLength);
    try {
      const message: unknown = JSON.parse(body);
      handleMessage(message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`yaade-mock-lsp: invalid JSON payload: ${detail}\n`);
      process.exit(1);
      return;
    }
  }
}

function controlledExit(
  command: "crash" | "restart",
  code: number,
  stderr?: string,
): void {
  captureEvent(command, { code });
  process.stderr.write(
    `${stderr?.trim() || `yaade-mock-lsp: controlled ${command}`}\n`,
  );
  process.exit(code);
}

function controlCommand(value: unknown): ControlCommand | null {
  const command = stringField(value, "command");
  switch (command) {
    case "crash":
    case "restart":
    case "publishDiagnostics":
    case "registerCapability":
    case "showMessage":
    case "showMessageRequest":
    case "showDocument":
    case "applyWorkspaceEdit":
    case "workDoneProgress":
    case "finishWorkDoneProgress":
      return command;
    default:
      return null;
  }
}

function handleControl(value: unknown): void {
  const targetGeneration = numberField(value, "generation");
  if (targetGeneration !== undefined && targetGeneration !== generation) return;
  const command = controlCommand(value);
  switch (command) {
    case "crash":
      controlledExit(
        "crash",
        numberField(value, "code") ?? 1,
        stringField(value, "stderr"),
      );
      break;
    case "restart":
      controlledExit(
        "restart",
        numberField(value, "code") ?? 86,
        stringField(value, "stderr"),
      );
      break;
    case "publishDiagnostics": {
      const uri =
        stringField(value, "uri") ??
        documents.keys().next().value ??
        `${rootUri}/mock.ts`;
      publishDiagnostics(uri, stringField(value, "message"));
      break;
    }
    case "registerCapability":
      registerDynamicCapability();
      break;
    case "showMessage":
      notify("window/showMessage", {
        type: numberField(value, "type") ?? 3,
        message:
          stringField(value, "message") ?? "Controlled mock server message",
      });
      break;
    case "showMessageRequest":
      request("window/showMessageRequest", {
        type: numberField(value, "type") ?? 3,
        message:
          stringField(value, "message") ?? "Choose a deterministic action",
        actions: [{ title: "Accept" }, { title: "Cancel" }],
      });
      break;
    case "showDocument":
      request("window/showDocument", {
        uri: stringField(value, "uri") ?? `${rootUri}/mock.ts`,
        takeFocus: true,
        selection: range(),
      });
      break;
    case "applyWorkspaceEdit":
      request("workspace/applyEdit", {
        label: stringField(value, "message") ?? "Controlled mock workspace edit",
        edit: field(value, "edit") ?? {},
      });
      break;
    case "workDoneProgress": {
      const token = `mock-progress-${nextServerRequest}`;
      activeProgressTokens.add(token);
      request("window/workDoneProgress/create", { token });
      notify("$/progress", {
        token,
        value: {
          kind: "begin",
          title: "Mock work",
          message: stringField(value, "message") ?? "Mock work started",
          percentage: 10,
          cancellable: true,
        },
      });
      break;
    }
    case "finishWorkDoneProgress": {
      for (const token of activeProgressTokens) {
        notify("$/progress", {
          token,
          value: { kind: "end", message: "Mock work complete" },
        });
      }
      activeProgressTokens.clear();
      break;
    }
    case null:
      captureEvent("unknown-control", value);
      break;
  }
}

function readControls(): void {
  if (!controlPath) return;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(controlPath);
  } catch (error) {
    const code =
      error !== null && typeof error === "object"
        ? field(error, "code")
        : undefined;
    if (code === "ENOENT") return;
    throw error;
  }
  if (stat.size < controlOffset) controlOffset = 0;
  if (stat.size === controlOffset) return;
  const fd = fs.openSync(controlPath, "r");
  try {
    const byteLength = stat.size - controlOffset;
    const buffer = Buffer.alloc(byteLength);
    fs.readSync(fd, buffer, 0, byteLength, controlOffset);
    controlOffset = stat.size;
    for (const line of buffer.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        handleControl(value);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        captureEvent("invalid-control", { detail });
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

if (controlPath) {
  try {
    controlOffset = fs.statSync(controlPath).size;
  } catch {
    controlOffset = 0;
  }
}

captureEvent("started", { generation, cwd: process.cwd() });

const controlTimer = setInterval(() => {
  try {
    readControls();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    captureEvent("control-error", { detail });
  }
}, 20);

process.stdin.on("data", (chunk) => {
  feedInput(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
});

process.stdin.on("end", () => {
  clearInterval(controlTimer);
  process.exit(shuttingDown ? 0 : 1);
});

process.stdin.resume();
