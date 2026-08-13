/**
 * Tool Session keymap. Browser-reserved chords stay unbound; actions live behind
 * a tmux-style Ctrl-a prefix (send-prefix inside xterm with Ctrl-a Ctrl-a).
 */

export const TOOL_SESSION_PREFIX = "Ctrl-a"

export type ToolSessionPrefixBinding = {
  readonly key: string
  readonly command: string
  readonly desc: string
}

export const TOOL_SESSION_PREFIX_BINDINGS: readonly ToolSessionPrefixBinding[] = [
  { key: "c", command: "session.new", desc: "New Session" },
  { key: "t", command: "tool.new", desc: "New ToolUse" },
  { key: "w", command: "session.switch", desc: "Switch Session" },
  { key: "j", command: "tool.next", desc: "Next ToolUse" },
  { key: "k", command: "tool.previous", desc: "Previous ToolUse" },
  { key: "x", command: "tool.close", desc: "Close ToolUse" },
  { key: "Shift-X", command: "session.close", desc: "Close Session" },
  { key: "p", command: "ui.showCommandPalette", desc: "Command palette" },
  { key: ",", command: "settings.show", desc: "Settings" },
]

export const TOOL_SESSION_DIRECT_BINDINGS: readonly ToolSessionPrefixBinding[] = [
  { key: "Mod-Shift-p", command: "ui.showCommandPalette", desc: "Command palette" },
  { key: "Mod-,", command: "settings.show", desc: "Settings" },
]

export function toolSessionPrefixBindingKey(key: string, prefix = TOOL_SESSION_PREFIX): string {
  return `${prefix} ${key}`
}
