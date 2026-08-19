import { Schema } from "effect"

/** One terminal leaf persisted for a workspace session (mux pane). */
export const WorkspaceSessionLeaf = Schema.Struct({
  ptyTabId: Schema.String,
  cwdRootUri: Schema.String,
  ptyId: Schema.optional(Schema.String),
  liveCwdUri: Schema.optional(Schema.String),
  launchCommand: Schema.optional(Schema.String),
  launchArgs: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  label: Schema.optional(Schema.String),
  agentProvider: Schema.optional(Schema.String),
  agentTitle: Schema.optional(Schema.String),
})
export type WorkspaceSessionLeaf = Schema.Schema.Type<typeof WorkspaceSessionLeaf>

export const WorkspaceSessionLayout = Schema.Struct({
  tree: Schema.Unknown,
  focusedPaneId: Schema.NullOr(Schema.Number),
  zoomedPaneId: Schema.NullOr(Schema.String),
})
export type WorkspaceSessionLayout = Schema.Schema.Type<typeof WorkspaceSessionLayout>

/** Legacy browser-editor pane persisted for a workspace session (keyed by tab id). */
export const WorkspaceSessionEditorFile = Schema.Struct({
  uri: Schema.String,
  line: Schema.optional(Schema.Number),
})
export type WorkspaceSessionEditorFile = Schema.Schema.Type<
  typeof WorkspaceSessionEditorFile
>

export const WorkspaceSession = Schema.Struct({
  version: Schema.Literal(1),
  machine: Schema.String,
  rootPath: Schema.String,
  layout: WorkspaceSessionLayout,
  sessions: Schema.Array(WorkspaceSessionLeaf),
  gitRoots: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
  editorFiles: Schema.optional(
    Schema.Record({ key: Schema.String, value: WorkspaceSessionEditorFile }),
  ),
})
export type WorkspaceSession = Schema.Schema.Type<typeof WorkspaceSession>

export const EMPTY_WORKSPACE_SESSION_LAYOUT: WorkspaceSessionLayout = {
  tree: { root: null },
  focusedPaneId: null,
  zoomedPaneId: null,
}

export function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

export function parseSessionLeaf(raw: unknown): WorkspaceSessionLeaf | null {
  if (!raw || typeof raw !== "object") return null
  const item = raw as Record<string, unknown>
  const ptyTabId = asNonEmptyString(item.ptyTabId)
  const cwdRootUri = asNonEmptyString(item.cwdRootUri)
  if (!ptyTabId || !cwdRootUri) return null
  let launchArgs: string[] | undefined
  if (Array.isArray(item.launchArgs)) {
    const filtered = item.launchArgs.filter(
      (arg): arg is string => typeof arg === "string",
    )
    if (filtered.length > 0) launchArgs = filtered
  }
  return {
    ptyTabId,
    cwdRootUri,
    ...(asNonEmptyString(item.ptyId) ? { ptyId: asNonEmptyString(item.ptyId)! } : {}),
    ...(asNonEmptyString(item.liveCwdUri)
      ? { liveCwdUri: asNonEmptyString(item.liveCwdUri)! }
      : {}),
    ...(asNonEmptyString(item.launchCommand)
      ? { launchCommand: asNonEmptyString(item.launchCommand)! }
      : {}),
    ...(launchArgs ? { launchArgs } : {}),
    ...(asNonEmptyString(item.label) ? { label: asNonEmptyString(item.label)! } : {}),
    ...(asNonEmptyString(item.agentProvider)
      ? { agentProvider: asNonEmptyString(item.agentProvider)! }
      : {}),
    ...(asNonEmptyString(item.agentTitle)
      ? { agentTitle: asNonEmptyString(item.agentTitle)! }
      : {}),
  }
}

export function parseSessionLayout(raw: unknown): WorkspaceSessionLayout | null {
  if (!raw || typeof raw !== "object") return null
  const item = raw as Record<string, unknown>
  if (item.tree == null || typeof item.tree !== "object") return null
  const focusedPaneId =
    typeof item.focusedPaneId === "number" && Number.isFinite(item.focusedPaneId)
      ? item.focusedPaneId
      : null
  const zoomedPaneId =
    typeof item.zoomedPaneId === "string" ? item.zoomedPaneId : null
  return {
    tree: item.tree,
    focusedPaneId,
    zoomedPaneId,
  }
}

/**
 * Validate + normalize a workspace-session payload.
 * Returns `null` when structurally invalid.
 */
export function tryDecodeWorkspaceSession(raw: unknown): WorkspaceSession | null {
  if (!raw || typeof raw !== "object") return null
  const body = raw as Record<string, unknown>
  if (body.version !== 1) return null
  const machine = asNonEmptyString(body.machine)
  const rootPath = asNonEmptyString(body.rootPath)
  const layout = parseSessionLayout(body.layout)
  if (!machine || !rootPath || !layout) return null
  if (!Array.isArray(body.sessions)) return null
  const seen = new Set<string>()
  const sessions: WorkspaceSessionLeaf[] = []
  for (const item of body.sessions) {
    const leaf = parseSessionLeaf(item)
    if (!leaf || seen.has(leaf.ptyTabId)) continue
    seen.add(leaf.ptyTabId)
    sessions.push(leaf)
  }
  let gitRoots: Record<string, string> | undefined
  if (body.gitRoots && typeof body.gitRoots === "object") {
    gitRoots = {}
    for (const [k, v] of Object.entries(body.gitRoots as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > 0) gitRoots[k] = v
    }
  }
  let editorFiles: Record<string, WorkspaceSessionEditorFile> | undefined
  if (body.editorFiles && typeof body.editorFiles === "object") {
    editorFiles = {}
    for (const [k, v] of Object.entries(
      body.editorFiles as Record<string, unknown>,
    )) {
      if (!v || typeof v !== "object") continue
      const entry = v as Record<string, unknown>
      const uri = asNonEmptyString(entry.uri)
      if (!uri) continue
      const line =
        typeof entry.line === "number" && Number.isFinite(entry.line)
          ? entry.line
          : undefined
      editorFiles[k] = { uri, ...(line != null ? { line } : {}) }
    }
  }
  return {
    version: 1,
    machine,
    rootPath,
    layout,
    sessions,
    ...(gitRoots && Object.keys(gitRoots).length > 0 ? { gitRoots } : {}),
    ...(editorFiles && Object.keys(editorFiles).length > 0
      ? { editorFiles }
      : {}),
  }
}

export function emptyWorkspaceSession(
  machine: string,
  rootPath: string,
): WorkspaceSession {
  return {
    version: 1,
    machine,
    rootPath,
    layout: { ...EMPTY_WORKSPACE_SESSION_LAYOUT },
    sessions: [],
  }
}
