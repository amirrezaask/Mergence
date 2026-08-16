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

export type JetUI = {
  showMessage(message: string): void
  showCommandPalette(): void
  setCommandPaletteOpen(open: boolean): void
}

export type JetCommandContext = {
  workspace: WorkspaceService
  ui: JetUI
  /** Active code-editor handle (or null). Typed as unknown for integration neutrality. */
  getActiveEditorView: () => unknown
}

export type JetCommand = (ctx: JetCommandContext, args?: unknown) => unknown | Promise<unknown>

export type JetCommandFn = (ctx: JetCommandContext) => void | Promise<void>

export type CommandInfo = {
  id: string
  title: string
  category?: string
  aliases?: string[]
  keywords?: string[]
  when?: (ctx: JetCommandContext) => boolean
}

export class CommandRegistry {
  private commands = new Map<string, JetCommand>()
  private infos = new Map<string, CommandInfo>()

  register(id: string, command: JetCommand, info: CommandInfo): { dispose: () => void } {
    this.commands.set(id, command)
    this.infos.set(id, info)
    return {
      dispose: () => {
        this.commands.delete(id)
        this.infos.delete(id)
      },
    }
  }

  has(id: string): boolean {
    return this.commands.has(id)
  }

  async execute(id: string, ctx: JetCommandContext, args?: unknown): Promise<unknown> {
    const cmd = this.commands.get(id)
    if (!cmd) throw new Error(`Unknown command: ${id}`)
    return cmd(ctx, args)
  }

  list(ctx?: JetCommandContext): CommandInfo[] {
    const infos = [...this.infos.values()]
    if (!ctx) return infos
    return infos.filter(info => info.when?.(ctx) ?? true)
  }
}
