import type { WorkspaceFolder } from "./workspace-manager.js"
import type { WorkspaceService } from "./workspace.js"

export type WorkspaceFolderPickOptions = {
  /** Prefer the folder that owns this id when it is still open. */
  preferredFolderId?: string
}

export type WorkspaceFolderPicker = (
  folders: WorkspaceFolder[],
) => Promise<WorkspaceFolder | null>

/** Resolve a workspace folder — auto-picks when N=1, prompts when N>1. */
export async function resolveWorkspaceFolder(
  workspace: WorkspaceService,
  pickFolder: WorkspaceFolderPicker,
  opts?: WorkspaceFolderPickOptions,
): Promise<WorkspaceFolder | null> {
  const folders = workspace.folders
  if (folders.length === 0) return null
  if (folders.length === 1) return folders[0]!
  if (opts?.preferredFolderId) {
    const preferred = folders.find(f => f.id === opts.preferredFolderId)
    if (preferred) return preferred
  }
  return pickFolder(folders)
}

/** Folder that owns a file URI, if any. */
export function folderForFileUri(
  workspace: WorkspaceService,
  fileUri: string,
): WorkspaceFolder | null {
  const state = workspace.folderStateForUri(fileUri)
  if (!state) return null
  return workspace.folders.find(f => f.id === state.id) ?? null
}

/** Open workspace folder matching a root URI, if any. */
export function folderForRootUri(
  workspace: WorkspaceService,
  rootUri: string,
): WorkspaceFolder | null {
  if (!rootUri) return null
  return workspace.folders.find(f => f.root.uri === rootUri) ?? null
}
