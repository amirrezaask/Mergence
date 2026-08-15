/**
 * YAADE keybinding catalog — the only file that assigns keys to commands.
 *
 * Dispatch, HUD, shortcut labels, and tests import from here. Do not add
 * chords in components. One command → one prefix key (settings is the sole
 * dual-path: prefix `,` plus `Mod-,`).
 *
 *   Tool Session (`/`)           canonical — edit TOOL_SESSION_* tables
 *   Legacy mux (`/_project`)     compat only — do not extend MUX_* tables
 *
 * Browser-reserved chords stay unbound. Shell actions live behind Mod-k
 * (⌘K on macOS, Ctrl+K elsewhere). Press the prefix twice in a terminal to
 * send ^K (kill-line). Mod-k is risky (Chrome omnibox) on purpose: Chromium
 * delivers it and preventDefault wins; it is the only free-enough multiplexer
 * chord that matches editor muscle memory.
 *
 * Removed Tool Session aliases (do not reintroduce):
 *   prefix p, Mod-k as a direct chord, Mod-Shift-p
 *
 * Not command bindings (stay local, listed so this file is the inventory):
 *   Widget nav     arrows / Home / End / Enter / Space / Escape in listers,
 *                  tab strips, rename fields, sidebar resize
 *   Overlay        Escape closes; CdOverlay confirms with Mod-Enter
 *   Terminal PTY   packages/yaade-ui/src/panels/terminal-keybindings.ts
 *                  (Shift-Enter, Escape, mac Option/Cmd arrows + Backspace)
 *   Monaco         packages/yaade-monaco/src/editor-shortcuts.ts
 *                  (Mod-p quick open, Mod-s save, Mod-Shift-p palette)
 *   Dead dump      packages/yaade-workspace/src/default-keybindings.ts
 *                  (VS Code leftover; layer 0 is empty in the live app)
 */

import { keyEventMatchesBinding } from "@yaade/workspace"

export const SHELL_PREFIX = "Mod-k"
export const TOOL_SESSION_PREFIX = SHELL_PREFIX
export const MUX_PREFIX = SHELL_PREFIX

export type ToolSessionPrefixGroupId = "open" | "move" | "session"

export type ToolSessionPrefixBinding = {
  readonly key: string
  readonly command: string
  readonly desc: string
  readonly group: ToolSessionPrefixGroupId
  /** When false, the binding still works but stays off the HUD. */
  readonly hud?: boolean
}

export type ToolSessionDirectBinding = {
  readonly key: string
  readonly command: string
  readonly desc: string
}

export type ToolSessionContextKind = "editor" | "search"

export type ToolSessionContextBinding = {
  readonly key: string
  readonly command: string
  readonly desc: string
  readonly when: readonly ToolSessionContextKind[]
  /** Risky chord — only legal with a written reason. */
  readonly riskyReason?: string
}

export type MuxPrefixBinding = {
  /** Second chord part, appended to {@link MUX_PREFIX}. */
  readonly key: string
  readonly command: string
  readonly desc: string
}

export type MuxDirectBinding = {
  readonly key: string
  readonly command: string
  readonly desc: string
}

export const TOOL_SESSION_PREFIX_GROUPS: readonly {
  readonly id: ToolSessionPrefixGroupId
  readonly label: string
}[] = [
  { id: "open", label: "Open" },
  { id: "move", label: "Move" },
  { id: "session", label: "Session" },
]

export const TOOL_SESSION_PREFIX_BINDINGS: readonly ToolSessionPrefixBinding[] =
  [
    { key: "t", command: "tool.newTerminal", desc: "New Terminal", group: "open" },
    { key: "s", command: "tool.newSearch", desc: "New Search", group: "open" },
    { key: "e", command: "tool.newEditor", desc: "New Editor", group: "open" },
    { key: "g", command: "tool.newGit", desc: "New Git", group: "open" },
    { key: "b", command: "sidebar.toggle", desc: "Toggle sidebars", group: "move" },
    { key: "j", command: "tool.next", desc: "Next tool", group: "move" },
    { key: "k", command: "tool.previous", desc: "Previous tool", group: "move" },
    { key: "u", command: "tool.switch", desc: "Switch tool", group: "move" },
    { key: "w", command: "session.switch", desc: "Switch session", group: "move" },
    { key: "1", command: "tool.jump", desc: "Jump tool 1–9", group: "move" },
    { key: "c", command: "session.new", desc: "New session", group: "session" },
    { key: "x", command: "tool.close", desc: "Close tool", group: "session" },
    {
      key: "Shift-X",
      command: "session.close",
      desc: "Close session",
      group: "session",
    },
    { key: ",", command: "settings.show", desc: "Settings", group: "session" },
  ]

/** Direct chords. Everything else is prefix or context-local. */
export const TOOL_SESSION_DIRECT_BINDINGS: readonly ToolSessionDirectBinding[] =
  [{ key: "Mod-,", command: "settings.show", desc: "Settings" }]

/**
 * Context-local chords. Not shell grammar. `Mod-p` is risky (print) on
 * purpose: VS Code quick-open, only while Editor or Search is focused.
 */
export const TOOL_SESSION_CONTEXT_BINDINGS: readonly ToolSessionContextBinding[] =
  [
    {
      key: "Mod-p",
      command: "editor.quickOpen",
      desc: "Quick open",
      when: ["editor", "search"],
      riskyReason:
        "VS Code quick-open while a file tool is focused. Prefix cannot own Mod-p.",
    },
  ]

/** Commands allowed both as prefix (HUD) and as a direct chord. */
export const TOOL_SESSION_DUAL_PATH_COMMANDS: readonly string[] = [
  "settings.show",
]

/**
 * Source of truth for both `registerUser` and the which-key panel, so the hint
 * overlay can never drift from what is actually bound.
 *
 * Compat-only. Do not add rows.
 */
export const MUX_PREFIX_BINDINGS: readonly MuxPrefixBinding[] = [
  { key: "c", command: "terminal.new", desc: "New pane" },
  { key: "d", command: "mux.splitRight", desc: "Split right" },
  { key: "Shift-D", command: "mux.splitDown", desc: "Split down" },
  { key: "x", command: "mux.closePane", desc: "Close pane" },
  { key: "z", command: "mux.zoomPane", desc: "Zoom pane" },
  { key: "h", command: "mux.focusLeft", desc: "Focus left" },
  { key: "j", command: "mux.focusDown", desc: "Focus down" },
  { key: "k", command: "mux.focusUp", desc: "Focus up" },
  { key: "l", command: "mux.focusRight", desc: "Focus right" },
  { key: "ArrowLeft", command: "mux.focusLeft", desc: "Focus left" },
  { key: "ArrowDown", command: "mux.focusDown", desc: "Focus down" },
  { key: "ArrowUp", command: "mux.focusUp", desc: "Focus up" },
  { key: "ArrowRight", command: "mux.focusRight", desc: "Focus right" },
  { key: "w", command: "terminal.list", desc: "Switch pane" },
  { key: "t", command: "mux.newWindow", desc: "New browser tab" },
  { key: "n", command: "mux.openNeovim", desc: "Open Neovim" },
  { key: "g", command: "mux.openGit", desc: "Open Git" },
  { key: "e", command: "explorer.focus", desc: "Explorer" },
  { key: "f", command: "editor.quickOpen", desc: "Quick open" },
  { key: "/", command: "search.focus", desc: "Project search" },
  { key: "b", command: "buffers.focus", desc: "Buffers" },
  { key: "o", command: "outline.focus", desc: "Outline" },
  { key: "r", command: "references.focus", desc: "References" },
  { key: "[", command: "editor.navigateBack", desc: "Go back" },
  { key: "]", command: "editor.navigateForward", desc: "Go forward" },
  { key: "s", command: "editor.save", desc: "Save" },
  { key: "p", command: "ui.showCommandPalette", desc: "Command palette" },
  { key: ".", command: "workspace.cd", desc: "Change directory" },
  { key: ",", command: "settings.show", desc: "Settings" },
  { key: "=", command: "ui.zoomIn", desc: "Font bigger" },
  { key: "-", command: "ui.zoomOut", desc: "Font smaller" },
]

/**
 * Chords bound without the prefix. Kept to the minimum that Chromium delivers
 * and that users already expect an app to own.
 */
export const MUX_DIRECT_BINDINGS: readonly MuxDirectBinding[] = [
  {
    key: "Mod-Shift-p",
    command: "ui.showCommandPalette",
    desc: "Command palette",
  },
  { key: "Mod-,", command: "settings.show", desc: "Settings" },
]

/**
 * Mux Escape is not in {@link MUX_DIRECT_BINDINGS} because it is gated on a
 * zoomed pane and focus outside the PTY. Listed here so it stays visible.
 */
export const MUX_UNZOOM_BINDING = {
  key: "Escape",
  command: "mux.unzoom",
  desc: "Unzoom pane",
} as const

/** Super+Shift+P on non-Mac, where `Mod` is Ctrl. */
const MUX_PALETTE_META_ALIAS = "Cmd-Shift-p"

export function toolSessionPrefixBindingKey(
  key: string,
  prefix = TOOL_SESSION_PREFIX,
): string {
  return `${prefix} ${key}`
}

export function toolSessionShortcutFor(command: string): string | undefined {
  const binding = TOOL_SESSION_PREFIX_BINDINGS.find(
    (item) => item.command === command && item.hud !== false,
  )
  return binding ? toolSessionPrefixBindingKey(binding.key) : undefined
}

export function toolSessionDirectShortcutFor(
  command: string,
): string | undefined {
  return TOOL_SESSION_DIRECT_BINDINGS.find((item) => item.command === command)
    ?.key
}

export function toolSessionHudBindings(): readonly ToolSessionPrefixBinding[] {
  return TOOL_SESSION_PREFIX_BINDINGS.filter((item) => item.hud !== false)
}

export function serializeToolSessionPrefixKey(event: KeyboardEvent): string {
  if (event.shiftKey && event.key.length === 1) {
    return `Shift-${event.key.toUpperCase()}`
  }
  if (event.key.length === 1) return event.key.toLowerCase()
  return event.key
}

export function isToolSessionJumpKey(key: string): boolean {
  return /^[1-9]$/.test(key)
}

export function matchToolSessionPrefixBinding(
  key: string,
): ToolSessionPrefixBinding | undefined {
  return TOOL_SESSION_PREFIX_BINDINGS.find((item) => item.key === key)
}

export function matchToolSessionDirectBinding(
  event: KeyboardEvent,
): ToolSessionDirectBinding | undefined {
  return TOOL_SESSION_DIRECT_BINDINGS.find((item) =>
    keyEventMatchesBinding(event, item.key),
  )
}

export function matchToolSessionContextBinding(
  event: KeyboardEvent,
  kind: string | undefined,
): ToolSessionContextBinding | undefined {
  if (kind !== "editor" && kind !== "search") return undefined
  return TOOL_SESSION_CONTEXT_BINDINGS.find(
    (item) =>
      item.when.includes(kind) && keyEventMatchesBinding(event, item.key),
  )
}

/** Full binding key for a prefix entry, e.g. `Mod-k z`. */
export function muxPrefixBindingKey(key: string, prefix = MUX_PREFIX): string {
  return `${prefix} ${key}`
}

/**
 * Control byte a `Ctrl-<letter>` / `Mod-<letter>` prefix would have sent to
 * the PTY, so pressing the prefix twice passes it through (tmux send-prefix).
 * `Mod-k` sends `^K` (kill-line) on every platform. Returns `null` when the
 * prefix has no control-code equivalent.
 */
export function prefixLiteralByte(prefix = SHELL_PREFIX): string | null {
  const match = /^(?:Ctrl|Mod)-([a-z])$/i.exec(prefix.trim())
  if (!match) return null
  const letter = match[1]!.toLowerCase()
  const code = letter.charCodeAt(0) - 96
  if (code < 1 || code > 26) return null
  return String.fromCharCode(code)
}

/** Palette chord that must work even if `registerUser` has not landed. */
export function isMuxPaletteHardwire(event: KeyboardEvent): boolean {
  return MUX_DIRECT_BINDINGS.some(
    (item) =>
      item.command === "ui.showCommandPalette" &&
      (keyEventMatchesBinding(event, item.key) ||
        keyEventMatchesBinding(event, MUX_PALETTE_META_ALIAS)),
  )
}
