/**
 * Signed-off Tool Session keymap. One command → one prefix key.
 *
 * Browser-reserved chords stay unbound. Shell actions live behind Ctrl-a
 * (send-prefix inside xterm with Ctrl-a Ctrl-a). Direct chords are limited to
 * platform conventions the browser actually delivers: settings and the
 * navigation sidebar visibility toggle.
 *
 *   Open     a/t/s/e/g   Agent / Terminal / Search / Editor / Git
 *   Move     j/k/u/w     next / previous / switch tool / switch session
 *   Jump     1–9         ToolUse at that index (one HUD row, not nine)
 *   Session  c/x/X/,     new session / close tool / close session / settings
 *
 * Dual-path exception: settings is Ctrl-a , (HUD completeness) and Mod-,
 * (OS convention). No other command has two keys.
 *
 * Removed aliases (do not reintroduce):
 *   Ctrl-a p, Mod-k, Mod-Shift-p
 */

import { keyEventMatchesBinding } from "@yaade/workspace"

export const TOOL_SESSION_PREFIX = "Ctrl-a"

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

export const TOOL_SESSION_PREFIX_GROUPS: readonly {
  readonly id: ToolSessionPrefixGroupId
  readonly label: string
}[] = [
  { id: "open", label: "Open" },
  { id: "move", label: "Move" },
  { id: "session", label: "Session" },
]

export const TOOL_SESSION_PREFIX_BINDINGS: readonly ToolSessionPrefixBinding[] = [
  { key: "a", command: "tool.newAgent", desc: "New Agent", group: "open" },
  { key: "t", command: "tool.newTerminal", desc: "New Terminal", group: "open" },
  { key: "s", command: "tool.newSearch", desc: "New Search", group: "open" },
  { key: "e", command: "tool.newEditor", desc: "New Editor", group: "open" },
  { key: "g", command: "tool.newGit", desc: "New Git", group: "open" },
  { key: "j", command: "tool.next", desc: "Next tool", group: "move" },
  { key: "k", command: "tool.previous", desc: "Previous tool", group: "move" },
  { key: "u", command: "tool.switch", desc: "Switch tool", group: "move" },
  { key: "w", command: "session.switch", desc: "Switch session", group: "move" },
  { key: "1", command: "tool.jump", desc: "Jump tool 1–9", group: "move" },
  { key: "c", command: "session.new", desc: "New session", group: "session" },
  { key: "x", command: "tool.close", desc: "Close tool", group: "session" },
  { key: "Shift-X", command: "session.close", desc: "Close session", group: "session" },
  { key: ",", command: "settings.show", desc: "Settings", group: "session" },
]

/** Direct chords. Everything else is prefix or context-local. */
export const TOOL_SESSION_DIRECT_BINDINGS: readonly ToolSessionDirectBinding[] = [
  {
    key: "Mod-b",
    command: "sidebar.toggle",
    desc: "Toggle navigation sidebar(s)",
  },
  { key: "Mod-,", command: "settings.show", desc: "Settings" },
]

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
