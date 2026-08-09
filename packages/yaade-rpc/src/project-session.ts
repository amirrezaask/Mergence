import { Schema } from "effect"
import {
  EMPTY_WORKSPACE_SESSION_LAYOUT,
  WorkspaceSessionEditorFile,
  WorkspaceSessionLayout,
  WorkspaceSessionLeaf,
  type WorkspaceSessionEditorFile as WorkspaceSessionEditorFileType,
  type WorkspaceSessionLayout as WorkspaceSessionLayoutType,
  type WorkspaceSessionLeaf as WorkspaceSessionLeafType,
} from "./workspace-session.js"

/** Layout payload for a project session (pane tree + focus/zoom). */
export const ProjectSessionLayout = WorkspaceSessionLayout
export type ProjectSessionLayout = WorkspaceSessionLayoutType

/** Terminal leaf persisted inside a project session. */
export const ProjectSessionLeaf = WorkspaceSessionLeaf
export type ProjectSessionLeaf = WorkspaceSessionLeafType

/** Monaco editor file target keyed by tab id. */
export const ProjectSessionEditorFile = WorkspaceSessionEditorFile
export type ProjectSessionEditorFile = WorkspaceSessionEditorFileType

/** Persisted agent-chat pane metadata. Conversation content remains runtime-owned. */
export const ProjectSessionAgentChatPane = Schema.Struct({
  agentThreadId: Schema.String,
})
export type ProjectSessionAgentChatPane = Schema.Schema.Type<
  typeof ProjectSessionAgentChatPane
>

export const EMPTY_PROJECT_SESSION_LAYOUT: ProjectSessionLayout = {
  ...EMPTY_WORKSPACE_SESSION_LAYOUT,
}

/** Layout + pane state stored in `project_sessions.payload_json`. */
export const ProjectSessionPayload = Schema.Struct({
  version: Schema.Literal(2),
  layout: ProjectSessionLayout,
  sessions: Schema.Array(ProjectSessionLeaf),
  gitRoots: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
  editorFiles: Schema.optional(
    Schema.Record({ key: Schema.String, value: ProjectSessionEditorFile }),
  ),
  editorViewStates: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
  agentChatPanes: Schema.optional(
    Schema.Record({ key: Schema.String, value: ProjectSessionAgentChatPane }),
  ),
})
export type ProjectSessionPayload = Schema.Schema.Type<typeof ProjectSessionPayload>

/** Summary row for the project page session list. */
export const ProjectSessionSummary = Schema.Struct({
  id: Schema.String,
  machine: Schema.String,
  projectPath: Schema.String,
  cwdPath: Schema.String,
  title: Schema.String,
  worktreeBranch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
})
export type ProjectSessionSummary = Schema.Schema.Type<typeof ProjectSessionSummary>

/** Full project session (summary + layout payload). */
export const ProjectSession = Schema.Struct({
  id: Schema.String,
  machine: Schema.String,
  projectPath: Schema.String,
  cwdPath: Schema.String,
  title: Schema.String,
  worktreeBranch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
  payload: ProjectSessionPayload,
})
export type ProjectSession = Schema.Schema.Type<typeof ProjectSession>

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

function parseLeaf(raw: unknown): ProjectSessionLeaf | null {
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

function parseLayout(raw: unknown): ProjectSessionLayout | null {
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
 * Validate + normalize a project-session layout payload.
 * Returns `null` when structurally invalid.
 */
export function tryDecodeProjectSessionPayload(
  raw: unknown,
): ProjectSessionPayload | null {
  if (!raw || typeof raw !== "object") return null
  const body = raw as Record<string, unknown>
  if (body.version !== 1 && body.version !== 2) return null
  const layout = parseLayout(body.layout)
  if (!layout) return null
  if (!Array.isArray(body.sessions)) return null
  const seen = new Set<string>()
  const sessions: ProjectSessionLeaf[] = []
  for (const item of body.sessions) {
    const leaf = parseLeaf(item)
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
  let editorFiles: Record<string, ProjectSessionEditorFile> | undefined
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
  let editorViewStates: Record<string, unknown> | undefined
  if (body.editorViewStates && typeof body.editorViewStates === "object") {
    editorViewStates = {}
    for (const [key, value] of Object.entries(
      body.editorViewStates as Record<string, unknown>,
    )) {
      if (!key || value == null || typeof value !== "object") continue
      editorViewStates[key] = value
    }
  }
  let agentChatPanes: Record<string, ProjectSessionAgentChatPane> | undefined
  if (body.version === 2 && body.agentChatPanes && typeof body.agentChatPanes === "object") {
    agentChatPanes = {}
    for (const [key, value] of Object.entries(body.agentChatPanes as Record<string, unknown>)) {
      if (!key || !value || typeof value !== "object") continue
      const agentThreadId = asNonEmptyString((value as Record<string, unknown>).agentThreadId)
      if (agentThreadId) agentChatPanes[key] = { agentThreadId }
    }
  }
  return {
    version: 2,
    layout,
    sessions,
    ...(gitRoots && Object.keys(gitRoots).length > 0 ? { gitRoots } : {}),
    ...(editorFiles && Object.keys(editorFiles).length > 0
      ? { editorFiles }
      : {}),
    ...(editorViewStates && Object.keys(editorViewStates).length > 0
      ? { editorViewStates }
      : {}),
    ...(agentChatPanes && Object.keys(agentChatPanes).length > 0
      ? { agentChatPanes }
      : {}),
  }
}

export function emptyProjectSessionPayload(): ProjectSessionPayload {
  return {
    version: 2,
    layout: { ...EMPTY_PROJECT_SESSION_LAYOUT },
    sessions: [],
  }
}
