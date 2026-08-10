import { EXPLORER_TAB_ID, PROBLEMS_TAB_ID } from "@yaade/workspace"

/** Persistent tiled tools. Renderers may land independently of the layout model. */
export const MUX_TOOL_KINDS = [
  "explorer",
  "search",
  "problems",
  "references",
  "definitions",
  "outline",
  "buffers",
  "workspaceSymbols",
  "callHierarchy",
  "typeHierarchy",
  "lspOutput",
] as const

export type MuxToolKind = (typeof MUX_TOOL_KINDS)[number]

export type MuxToolPaneDefinition = {
  readonly kind: MuxToolKind
  readonly tabId: string
  readonly label: string
}

export const MUX_TOOL_PANES: readonly MuxToolPaneDefinition[] = [
  { kind: "explorer", tabId: EXPLORER_TAB_ID, label: "Explorer" },
  { kind: "search", tabId: "yaade:tool:search", label: "Search" },
  { kind: "problems", tabId: PROBLEMS_TAB_ID, label: "Problems" },
  { kind: "references", tabId: "yaade:tool:references", label: "References" },
  { kind: "definitions", tabId: "yaade:tool:definitions", label: "Definitions" },
  { kind: "outline", tabId: "yaade:tool:outline", label: "Outline" },
  { kind: "buffers", tabId: "yaade:tool:buffers", label: "Buffers" },
  {
    kind: "workspaceSymbols",
    tabId: "yaade:tool:workspace-symbols",
    label: "Workspace Symbols",
  },
  {
    kind: "callHierarchy",
    tabId: "yaade:tool:call-hierarchy",
    label: "Call Hierarchy",
  },
  {
    kind: "typeHierarchy",
    tabId: "yaade:tool:type-hierarchy",
    label: "Type Hierarchy",
  },
  { kind: "lspOutput", tabId: "yaade:tool:lsp-output", label: "LSP Output" },
]

const toolById = new Map(MUX_TOOL_PANES.map(tool => [tool.tabId, tool]))
const toolByKind = new Map(MUX_TOOL_PANES.map(tool => [tool.kind, tool]))

export function muxToolPaneForTab(tabId: string): MuxToolPaneDefinition | null {
  return toolById.get(tabId) ?? null
}

export function muxToolPane(kind: MuxToolKind): MuxToolPaneDefinition {
  const tool = toolByKind.get(kind)
  if (!tool) throw new Error(`Unknown mux tool pane: ${kind}`)
  return tool
}

export function muxToolKind(tabId: string): MuxToolKind | null {
  return muxToolPaneForTab(tabId)?.kind ?? null
}

export function isMuxToolTabId(tabId: string): boolean {
  return toolById.has(tabId)
}
