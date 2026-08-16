import { pathToFileUri } from "@yaade/shared"
import type {
  CommandRegistry,
  JetCommandContext,
  JetCommands,
  JetKeyBinding,
  WorkspaceService,
} from "@yaade/workspace"

/** Handles passed to `.yaade/editorrc.ts` — same registries Yaade uses internally. Import `bind` from `@yaade/workspace` in init code. */
export type JetInitContext = {
  workspace: WorkspaceService
  commands: CommandRegistry
  appCommands: JetCommands
  getCommandContext: () => JetCommandContext
  addKeybindings(bindings: JetKeyBinding[]): void
  /** Kept for init script API stability while browser editing is disabled. */
  addEditorExtensions(extensions: unknown[]): void
  openFile(uri: string): Promise<void>
  showMessage(message: string): void
}

const INIT_FILES = ["init.ts", "init.js", "editorrc.ts"] as const

export async function loadWorkspaceInit(
  jetDir: string,
  ctx: JetInitContext,
): Promise<void> {
  const fs = typeof window !== "undefined" ? window.yaade?.fs : undefined
  for (const file of INIT_FILES) {
    const path = `${jetDir}/${file}`
    if (fs) {
      try {
        const uri = pathToFileUri(path)
        if (fs.exists) {
          if (!(await fs.exists(uri))) continue
        } else {
          await fs.stat(uri)
        }
      } catch {
        continue
      }
    }
    try {
      const mod = await import(/* @vite-ignore */ path)
      const setup = mod.default ?? mod.setup
      if (typeof setup === "function") {
        await setup(ctx)
        return
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes("Failed to fetch") || msg.includes("Cannot find module")) continue
      console.warn(`Workspace init failed (${path}):`, e)
      return
    }
  }
}
