import { Emitter } from "@yaade/shared"

/** Registered Yaade tab type ids (mirrors `@yaade/ui` TabTypeRegistry). */
export type KnownTabKind =
  | "editor"
  | "explorer"
  | "output"
  | "terminal"
  | "terminal-explorer"
  | "agent-explorer"
  | "search"
  | "problems"
  | "references"
  | "definitions"
  | "task-errors"
  | "git"

export type TabKind = KnownTabKind

export const EXPLORER_TAB_ID = "yaade:explorer"
export const OUTPUT_TAB_ID = "yaade:output"
export const PROBLEMS_TAB_ID = "yaade:problems"
export const TERMINAL_TAB_ID_PREFIX = "yaade:terminal:"
export const GIT_TAB_ID_PREFIX = "yaade:git:"
export const EDITOR_TAB_ID_PREFIX = "yaade:editor:"

/** Current + pre-rename prefixes. Nested prefixes unwrap (bad hydrate double-prefix). */
export const TERMINAL_TAB_ID_PREFIXES = [
  TERMINAL_TAB_ID_PREFIX,
  "gharargah:terminal:",
  "jet:terminal:",
] as const

export function terminalTabId(sessionKey: string): string {
  return `${TERMINAL_TAB_ID_PREFIX}${sessionKey}`
}

export function gitTabId(key: string): string {
  return `${GIT_TAB_ID_PREFIX}${key}`
}

export function isGitTabId(tabId: string): boolean {
  return tabId.startsWith(GIT_TAB_ID_PREFIX)
}

export function editorTabId(key: string): string {
  return `${EDITOR_TAB_ID_PREFIX}${key}`
}

/** File / untitled buffers, plus legacy synthetic `yaade:editor:…` pane ids. */
export function isEditorTabId(tabId: string): boolean {
  return (
    tabId.startsWith(EDITOR_TAB_ID_PREFIX) ||
    tabId.startsWith("file:") ||
    tabId.startsWith("untitled:")
  )
}

/** True when the tab id is a filesystem or untitled buffer URI (not a synthetic pane key). */
export function isFileEditorTabId(tabId: string): boolean {
  return tabId.startsWith("file:") || tabId.startsWith("untitled:")
}

/**
 * Strip known terminal prefixes (including nested legacy wrappers) → session key.
 * `yaade:terminal:gharargah:terminal:session-1` → `session-1`.
 */
export function terminalSessionKeyFromTabId(tabId: string): string | null {
  let rest = tabId
  let matched = false
  for (;;) {
    let hit = false
    for (const prefix of TERMINAL_TAB_ID_PREFIXES) {
      if (rest.startsWith(prefix)) {
        rest = rest.slice(prefix.length)
        matched = true
        hit = true
        break
      }
    }
    if (!hit) break
  }
  return matched && rest.length > 0 ? rest : null
}

/** Map any legacy/nested terminal tab id onto the canonical `yaade:terminal:` form. */
export function canonicalizeTerminalTabId(tabId: string): string {
  const sessionKey = terminalSessionKeyFromTabId(tabId)
  return sessionKey ? terminalTabId(sessionKey) : tabId
}

export function isTerminalTabId(tabId: string): boolean {
  return terminalSessionKeyFromTabId(tabId) != null
}

export type TabDescriptor = {
  id: string
  kind: TabKind
  label: string
}

/**
 * Lightweight per-tab bookkeeping used by workspace helpers that need to look
 * up label/kind by tab id. The real render dispatch lives in `@yaade/ui`'s
 * `TabTypeRegistry`; this store is just a workspace-side companion so command
 * handlers can ask "what kind of tab is this?" without importing UI.
 */
export class TabRegistry {
  private tabs = new Map<string, TabDescriptor>()
  readonly onDidChange = new Emitter<{ id: string }>()

  register(tab: TabDescriptor): void {
    this.tabs.set(tab.id, tab)
    this.onDidChange.fire({ id: tab.id })
  }

  get(id: string): TabDescriptor | undefined {
    return this.tabs.get(id)
  }

  update(id: string, patch: Partial<Omit<TabDescriptor, "id">>): void {
    const existing = this.tabs.get(id)
    if (!existing) return
    this.tabs.set(id, { ...existing, ...patch })
    this.onDidChange.fire({ id })
  }

  dispose(id: string): void {
    if (!this.tabs.delete(id)) return
    this.onDidChange.fire({ id })
  }

  labelFor(id: string): string {
    return this.tabs.get(id)?.label ?? id
  }

  kindFor(id: string): TabKind | undefined {
    return this.tabs.get(id)?.kind
  }
}
