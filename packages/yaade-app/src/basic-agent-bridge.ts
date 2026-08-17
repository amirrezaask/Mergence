import type { YaadeAgentAPI } from "./agent-bridge.js"
import { getEditorDiagnostics } from "./runtime-diagnostics.js"
import {
  findTerminalBufferMatch,
  focusRegisteredTerminal,
  readTerminalBufferText,
  readTerminalCellHeight,
  readTerminalCellSize,
  readTerminalCursor,
  readTerminalDims,
  readTerminalViewportY,
  scrollTerminalLines,
} from "@yaade/ui/terminal-registry"
import {
  focusRegisteredNeovim,
  readNeovimCursor,
  readNeovimDiagnostics,
  readNeovimRegistryDiagnostics,
  readNeovimDims,
  readNeovimText,
  dispatchNeovimTestInput,
} from "@yaade/ui/neovim"

export type HqCounts = {
  projects: number
  agents: number
  attention: number
  unread: number
}

export function basicAgentBridge(input: {
  route: "hq" | "project"
  workspace: string | null
  hqCounts?: HqCounts
  executeCommand?: (id: string) => void | Promise<void>
  createProjectSession?: YaadeAgentAPI["createProjectSession"]
  listProjectSessions?: YaadeAgentAPI["listProjectSessions"]
  openProjectSession?: YaadeAgentAPI["openProjectSession"]
  backToProject?: YaadeAgentAPI["backToProject"]
  createSession?: YaadeAgentAPI["createSession"]
  selectSession?: YaadeAgentAPI["selectSession"]
  createTab?: YaadeAgentAPI["createTab"]
  selectTab?: YaadeAgentAPI["selectTab"]
  closeTab?: YaadeAgentAPI["closeTab"]
  createToolUse?: YaadeAgentAPI["createToolUse"]
  selectToolUse?: YaadeAgentAPI["selectToolUse"]
  closeToolUse?: YaadeAgentAPI["closeToolUse"]
  closeSession?: YaadeAgentAPI["closeSession"]
}): YaadeAgentAPI {
  const workspace = input.workspace
  return {
    openWorkspace: async () => undefined,
    addWorkspace: async () => undefined,
    listWorkspaces: () =>
      workspace ? [{ id: "project", path: workspace, name: workspace }] : [],
    openFile: async () => undefined,
    executeCommand: async id => {
      await input.executeCommand?.(id)
    },
    getState: () => ({
      workspace,
      activeWorkspace: workspace,
      workspaces: workspace
        ? [{ id: "project", path: workspace, name: workspace }]
        : [],
      message: null,
      paletteOpen: false,
      focusedPanel: null,
      openBuffers: [],
      panels: [],
      fontSize: 13,
      activeEditorDirty: false,
      searchReady: false,
      shellView: "home",
      sessionLayout: "sidebar",
      sessionMode: null,
      route: input.route,
      sessionId: null,
      sessionCwd: null,
      ...(input.hqCounts ? { hqCounts: input.hqCounts } : {}),
    }),
    waitForReady: async () => undefined,
    waitForEditor: async () => undefined,
    setFontSize: () => undefined,
    getEditorText: () => null,
    setEditorSelection: () => undefined,
    getCursorPosition: () => null,
    getSelectionRangeCount: () => null,
    getEditorDiagnostics: () =>
      getEditorDiagnostics({ activeDirty: false, openBuffers: [] }),
    acceptConfirm: async () => undefined,
    dismissConfirm: async () => undefined,
    readFixtureFile: async () => "",
    waitForListRows: async () => undefined,
    getPerfMeasures: () => [],
    clearPerf: () => undefined,
    markPerf: () => undefined,
    measurePerf: () => undefined,
    dropFilesOnTerminal: async () => false,
    dropFilesOnEditor: async () => false,
    getTerminalText: tabId => readTerminalBufferText(tabId),
    getTerminalCellHeight: tabId => readTerminalCellHeight(tabId),
    getTerminalCellSize: tabId => readTerminalCellSize(tabId),
    getTerminalDims: tabId => readTerminalDims(tabId),
    getTerminalCursor: tabId => readTerminalCursor(tabId),
    getTerminalViewportY: tabId => readTerminalViewportY(tabId),
    scrollTerminalLines: (amount, tabId) => scrollTerminalLines(amount, tabId),
    focusTerminal: tabId => focusRegisteredTerminal(tabId),
    findTerminalText: (needle, tabId) => findTerminalBufferMatch(needle, tabId),
    getNeovimText: toolUseId => readNeovimText(toolUseId),
    getNeovimCursor: toolUseId => readNeovimCursor(toolUseId),
    getNeovimDims: toolUseId => readNeovimDims(toolUseId),
    getNeovimDiagnostics: toolUseId => readNeovimDiagnostics(toolUseId),
    getNeovimRegistryDiagnostics: () => readNeovimRegistryDiagnostics(),
    focusNeovim: toolUseId => focusRegisteredNeovim(toolUseId),
    async dispatchNeovimInput(toolUseId, value) {
      return dispatchNeovimTestInput(toolUseId, value)
    },
    createProjectSession: input.createProjectSession,
    listProjectSessions: input.listProjectSessions,
    openProjectSession: input.openProjectSession,
    backToProject: input.backToProject,
    createSession: input.createSession,
    selectSession: input.selectSession,
    createTab: input.createTab,
    selectTab: input.selectTab,
    closeTab: input.closeTab,
    createToolUse: input.createToolUse,
    selectToolUse: input.selectToolUse,
    closeToolUse: input.closeToolUse,
    closeSession: input.closeSession,
  }
}
