import type { EditorDiagnostics } from "./runtime-diagnostics.js";

export type JetAgentState = {
  workspace: string | null;
  activeWorkspace: string | null;
  workspaces: { id: string; path: string; name: string }[];
  message: string | null;
  paletteOpen: boolean;
  focusedPanel: number | null;
  openBuffers: string[];
  panels: { id: number; kind: string }[];
  fontSize: number;
  activeEditorDirty: boolean;
  searchReady: boolean;
  shellView: "home" | "workspace";
  sessionLayout: "sidebar";
  sessionMode: "terminal" | "git" | null;
  route: "hq" | "project" | "session";
  sessionId: string | null;
  sessionCwd: string | null;
  activeSessionId?: string | null;
  activeTabId?: string | null;
  activeToolUseId?: string | null;
  sessions?: readonly unknown[];
  tabs?: readonly unknown[];
  toolUses?: readonly unknown[];
  connection?: string;
  hqCounts?: { projects: number; agents: number; attention: number; unread: number };
};

export type YaadeAgentAPI = {
  openWorkspace(folderPath: string): Promise<void>;
  addWorkspace(folderPath: string): Promise<void>;
  listWorkspaces(): { id: string; path: string; name: string }[];
  openFile(relativeOrUri: string): Promise<void>;
  executeCommand(commandId: string): Promise<void>;
  getState(): JetAgentState;
  waitForReady(): Promise<void>;
  waitForEditor(timeoutMs?: number): Promise<void>;
  setFontSize(px: number): void;
  getEditorText(): string | null;
  setEditorSelection(line: number, column: number): void;
  getCursorPosition(): { line: number; column: number } | null;
  getSelectionRangeCount(): number | null;
  getEditorDiagnostics(): EditorDiagnostics;
  acceptConfirm(): Promise<void>;
  dismissConfirm(): Promise<void>;
  readFixtureFile(relativePath: string): Promise<string>;
  waitForListRows(panel: string, minItems: number, timeoutMs?: number): Promise<void>;
  getPerfMeasures(names?: string[]): { name: string; durationMs: number }[];
  clearPerf(): void;
  markPerf(name: string): void;
  measurePerf(name: string, startMark: string, endMark?: string): void;
  dropFilesOnTerminal(paths: string[]): Promise<boolean>;
  dropFilesOnEditor(paths: string[]): Promise<boolean>;
  getTerminalText(tabId?: string): string;
  getTerminalCellHeight(tabId?: string): number;
  getTerminalCellSize(tabId?: string): { width: number; height: number } | null;
  getTerminalDims(tabId?: string): { cols: number; rows: number } | null;
  getTerminalCursor(tabId?: string): { x: number; y: number; hidden: boolean } | null;
  getTerminalViewportY(tabId?: string): number | null;
  scrollTerminalLines(amount: number, tabId?: string): boolean;
  focusTerminal(tabId?: string): boolean;
  findTerminalText(
    needle: string,
    tabId?: string,
  ): { col: number; viewportRow: number; cols: number; rows: number } | null;
  createSession?(): Promise<void>;
  selectSession?(sessionId: string): Promise<void>;
  createTab?(): Promise<void>;
  selectTab?(tabId: string): Promise<void>;
  closeTab?(tabId: string): Promise<void>;
  createToolUse?(kind: "terminal" | "git"): Promise<void>;
  selectToolUse?(toolUseId: string): Promise<void>;
  closeToolUse?(toolUseId: string): Promise<void>;
  closeSession?(sessionId: string, mode?: "keep-running" | "stop-tools"): Promise<void>;
};

declare global {
  interface Window {
    __yaadeAgent?: YaadeAgentAPI;
  }
}
