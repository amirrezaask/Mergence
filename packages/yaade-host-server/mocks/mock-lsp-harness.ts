/**
 * Test-side controller for `mock-lsp.ts`.
 *
 * Typical E2E use:
 *
 *   const mockLsp = createMockLspHarness()
 *   const { page, app } = await launchJet({ env: mockLsp.env })
 *   await mockLsp.waitForClientMethod("textDocument/didOpen")
 *   await mockLsp.showMessage("message asserted by the spec")
 *   await mockLsp.restart(mockLsp.startCount())
 *   // Trigger Yaade to ensure the language server again, then:
 *   await mockLsp.waitForStartCount(2)
 *   await app.close()
 *   mockLsp.dispose()
 *
 * `env` overrides every bundled language-server binary so normal fixture files
 * exercise the mock without production registry changes. Capture files are
 * private temporary test artifacts and must not be published in test reports.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type MockLspDirection = "client" | "server" | "event";

export type MockLspMessageCapture = {
  generation: number;
  direction: "client" | "server";
  message: unknown;
};

export type MockLspEventCapture = {
  generation: number;
  direction: "event";
  event: string;
  details?: unknown;
};

export type MockLspCapture = MockLspMessageCapture | MockLspEventCapture;

export type MockLspControl = {
  command:
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
  generation?: number;
  code?: number;
  stderr?: string;
  uri?: string;
  message?: string;
  type?: number;
  edit?: unknown;
};

export type WaitForMockLspOptions = {
  timeoutMs?: number;
  afterCaptureCount?: number;
};

const repoModuleDir = path.join(process.cwd(), "packages", "yaade-host-server", "mocks");
const packageModuleDir = path.join(process.cwd(), "mocks");
const moduleDir = fs.existsSync(repoModuleDir)
  ? repoModuleDir
  : packageModuleDir;
export const MOCK_LSP_BIN = path.join(moduleDir, "bin", "yaade-mock-lsp");

const SERVER_IDS = [
  "typescript-language-server",
  "gopls",
  "rust-analyzer",
  "pyright",
  "ruby-lsp",
  "vscode-json-language-server",
  "vscode-html-language-server",
  "vscode-css-language-server",
] as const;

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

function parseCapture(line: string): MockLspCapture | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const generation = numberField(value, "generation");
  const direction = stringField(value, "direction");
  if (generation === undefined) return null;
  if (direction === "client" || direction === "server") {
    return { generation, direction, message: field(value, "message") };
  }
  if (direction === "event") {
    const event = stringField(value, "event");
    if (!event) return null;
    const details = field(value, "details");
    return {
      generation,
      direction,
      event,
      ...(details === undefined ? {} : { details }),
    };
  }
  return null;
}

function methodOf(capture: MockLspCapture): string | undefined {
  return capture.direction === "event"
    ? undefined
    : stringField(capture.message, "method");
}

function responseIdOf(
  capture: MockLspCapture,
): string | number | null | undefined {
  if (capture.direction === "event") return undefined;
  const id = field(capture.message, "id");
  return typeof id === "string" || typeof id === "number" || id === null
    ? id
    : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lspOverrideKey(serverId: string): string {
  return `YAADE_LSP_${serverId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_BIN`;
}

export class MockLspHarness {
  readonly rootDir: string;
  readonly capturePath: string;
  readonly controlPath: string;
  readonly stateDir: string;
  readonly env: Record<string, string>;
  readonly binaryPath = MOCK_LSP_BIN;
  private readonly ownsRoot: boolean;

  constructor(rootDir?: string) {
    this.ownsRoot = rootDir === undefined;
    this.rootDir =
      rootDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "yaade-mock-lsp-"));
    this.capturePath = path.join(this.rootDir, "capture.jsonl");
    this.controlPath = path.join(this.rootDir, "control.jsonl");
    this.stateDir = path.join(this.rootDir, "state");
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.writeFileSync(this.controlPath, "", "utf8");

    const env: Record<string, string> = {
      YAADE_LSP_MOCK: "1",
      YAADE_LSP_MOCK_BIN: MOCK_LSP_BIN,
      YAADE_MOCK_LSP_CAPTURE_PATH: this.capturePath,
      YAADE_MOCK_LSP_CONTROL_PATH: this.controlPath,
      YAADE_MOCK_LSP_STATE_DIR: this.stateDir,
    };
    for (const serverId of SERVER_IDS)
      env[lspOverrideKey(serverId)] = MOCK_LSP_BIN;
    this.env = env;
  }

  captures(): MockLspCapture[] {
    let text: string;
    try {
      text = fs.readFileSync(this.capturePath, "utf8");
    } catch (error) {
      const code =
        error !== null && typeof error === "object"
          ? field(error, "code")
          : undefined;
      if (code === "ENOENT") return [];
      throw error;
    }
    const result: MockLspCapture[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const capture = parseCapture(line);
      if (capture) result.push(capture);
    }
    return result;
  }

  clientMessages(method?: string): MockLspMessageCapture[] {
    return this.captures().filter(
      (capture): capture is MockLspMessageCapture =>
        capture.direction === "client" &&
        (method === undefined || methodOf(capture) === method),
    );
  }

  serverMessages(method?: string): MockLspMessageCapture[] {
    return this.captures().filter(
      (capture): capture is MockLspMessageCapture =>
        capture.direction === "server" &&
        (method === undefined || methodOf(capture) === method),
    );
  }

  events(event?: string): MockLspEventCapture[] {
    return this.captures().filter(
      (capture): capture is MockLspEventCapture =>
        capture.direction === "event" &&
        (event === undefined || capture.event === event),
    );
  }

  startCount(): number {
    try {
      return fs
        .readdirSync(this.stateDir)
        .filter((name) => name.endsWith(".started")).length;
    } catch (error) {
      const code =
        error !== null && typeof error === "object"
          ? field(error, "code")
          : undefined;
      if (code === "ENOENT") return 0;
      throw error;
    }
  }

  appendControl(control: MockLspControl): void {
    fs.appendFileSync(this.controlPath, `${JSON.stringify(control)}\n`, "utf8");
  }

  crash(generation?: number, code = 1): void {
    this.appendControl({ command: "crash", generation, code });
  }

  restart(generation?: number): void {
    this.appendControl({ command: "restart", generation, code: 86 });
  }

  publishDiagnostics(
    options: { generation?: number; uri?: string; message?: string } = {},
  ): void {
    this.appendControl({ command: "publishDiagnostics", ...options });
  }

  registerCapability(generation?: number): void {
    this.appendControl({ command: "registerCapability", generation });
  }

  showMessage(
    message: string,
    options: { generation?: number; type?: number } = {},
  ): void {
    this.appendControl({ command: "showMessage", message, ...options });
  }

  showMessageRequest(
    message: string,
    options: { generation?: number; type?: number } = {},
  ): void {
    this.appendControl({ command: "showMessageRequest", message, ...options });
  }

  showDocument(uri: string, options: { generation?: number } = {}): void {
    this.appendControl({ command: "showDocument", uri, ...options });
  }

  applyWorkspaceEdit(
    edit: unknown,
    options: { generation?: number } = {},
  ): void {
    this.appendControl({ command: "applyWorkspaceEdit", edit, ...options });
  }

  workDoneProgress(
    message: string,
    options: { generation?: number } = {},
  ): void {
    this.appendControl({ command: "workDoneProgress", message, ...options });
  }

  finishWorkDoneProgress(generation?: number): void {
    this.appendControl({ command: "finishWorkDoneProgress", generation });
  }

  async waitForCapture(
    predicate: (capture: MockLspCapture) => boolean,
    options: WaitForMockLspOptions = {},
  ): Promise<MockLspCapture> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const after = options.afterCaptureCount ?? 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const captures = this.captures();
      for (let index = after; index < captures.length; index += 1) {
        const capture = captures[index];
        if (capture && predicate(capture)) return capture;
      }
      await delay(20);
    }
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for mock LSP capture`,
    );
  }

  async waitForClientMethod(
    method: string,
    options?: WaitForMockLspOptions,
  ): Promise<MockLspMessageCapture> {
    const capture = await this.waitForCapture(
      (item) => item.direction === "client" && methodOf(item) === method,
      options,
    );
    if (capture.direction !== "client")
      throw new Error("mock LSP capture direction changed");
    return capture;
  }

  async waitForServerMethod(
    method: string,
    options?: WaitForMockLspOptions,
  ): Promise<MockLspMessageCapture> {
    const capture = await this.waitForCapture(
      (item) => item.direction === "server" && methodOf(item) === method,
      options,
    );
    if (capture.direction !== "server")
      throw new Error("mock LSP capture direction changed");
    return capture;
  }

  async waitForResponse(
    id: string | number | null,
    options?: WaitForMockLspOptions,
  ): Promise<MockLspMessageCapture> {
    const capture = await this.waitForCapture(
      (item) =>
        item.direction === "server" &&
        responseIdOf(item) === id &&
        methodOf(item) === undefined,
      options,
    );
    if (capture.direction !== "server")
      throw new Error("mock LSP capture direction changed");
    return capture;
  }

  async waitForStartCount(count: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.startCount() >= count) return;
      await delay(20);
    }
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for ${count} mock LSP starts`,
    );
  }

  dispose(): void {
    if (!this.ownsRoot) return;
    fs.rmSync(this.rootDir, { recursive: true, force: true });
  }
}

export function createMockLspHarness(rootDir?: string): MockLspHarness {
  return new MockLspHarness(rootDir);
}

export function mockLspMessageMethod(message: unknown): string | undefined {
  return stringField(message, "method");
}

export function mockLspMessageField(message: unknown, key: string): unknown {
  return field(message, key);
}
