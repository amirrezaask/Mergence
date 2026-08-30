/**
 * YAADE keybinding catalog — the only file that assigns keys to commands.
 *
 * Dispatch, HUD, shortcut labels, and tests import from here. Do not add
 * chords in components. Prefix commands have one key each; direct layout
 * commands are explicit exceptions (settings is the sole dual-path command).
 *
 *   Terminal Session (`/`)           canonical — edit MUX_SESSION_* tables
 *
 * Browser-reserved chords stay unbound in normal keymaps. Shell actions live behind Mod-k
 * (⌘K on macOS, Ctrl+K elsewhere). Press the prefix twice in a terminal to
 * send ^K (kill-line). Mod-k is risky (Chrome omnibox) on purpose: Chromium
 * delivers it and preventDefault wins; it is the only free-enough multiplexer
 * chord that matches editor muscle memory.
 *
 * Removed Terminal Session aliases (do not reintroduce):
 *   prefix p, Mod-k as a direct chord, Mod-Shift-p
 *
 * Not command bindings (stay local, listed so this file is the inventory):
 *   Widget nav     arrows / Home / End / Enter / Space / Escape in listers,
 *                  tab strips, rename fields, sidebar resize
 *   Overlay        Escape closes; terminal overlays handle their own confirmation
 *   Terminal PTY   packages/yaade-ui/src/panels/terminal-keybindings.ts
 *                  (Shift-Enter, Escape, mac Option/Cmd arrows + Backspace)
 */

import {
  clearChord,
  createChordState,
  keyEventMatchesBinding,
  type ChordState,
  type KeyEventLike,
} from "@yaade/workspace";

export const SHELL_PREFIX = "Mod-k";
export const MUX_SESSION_PREFIX = SHELL_PREFIX;

export type MuxSessionCommand =
  | "terminal.newTerminal"
  | "terminal.next"
  | "terminal.previous"
  | "tab.next"
  | "tab.previous"
  | "pane.zoom"
  | "pane.splitRight"
  | "pane.splitDown"
  | "terminal.switch"
  | "sidebar.toggle"
  | "session.switch"
  | "terminal.jump"
  | "session.new"
  | "tab.new"
  | "tab.close"
  | "terminal.close"
  | "session.close"
  | "settings.show";

export type MuxSessionPrefixGroupId = "open" | "move" | "session";

export type MuxSessionPrefixBinding = {
  readonly key: string;
  readonly command: MuxSessionCommand;
  readonly desc: string;
  readonly group: MuxSessionPrefixGroupId;
  /** When false, the binding still works but stays off the HUD. */
  readonly hud?: boolean;
  /** Whether holding the key may repeat the command. Defaults to true. */
  readonly repeatable?: boolean;
};

export type MuxSessionDirectBinding = {
  readonly key: string;
  readonly command: MuxSessionCommand;
  readonly desc: string;
  /** Whether holding the key may repeat the command. Defaults to true. */
  readonly repeatable?: boolean;
  /** Required when the chord intentionally collides with a browser action. */
  readonly riskyReason?: string;
};

export type MuxSessionContextKind = never;

export type MuxSessionContextBinding = {
  readonly key: string;
  readonly command: MuxSessionCommand;
  readonly desc: string;
  readonly when: readonly MuxSessionContextKind[];
  /** Risky chord — only legal with a written reason. */
  readonly riskyReason?: string;
  /** Whether holding the key may repeat the command. Defaults to true. */
  readonly repeatable?: boolean;
};

export const MUX_SESSION_PREFIX_GROUPS: readonly {
  readonly id: MuxSessionPrefixGroupId;
  readonly label: string;
}[] = [];

export const MUX_SESSION_PREFIX_BINDINGS: readonly MuxSessionPrefixBinding[] = [];

/**
 * Direct layout chords are deliberately supported even though browsers label
 * them as risky: Chromium delivers these keydowns and the app has
 * visible context-menu fallbacks. Structural commands never repeat on hold.
 */
export const MUX_SESSION_DIRECT_BINDINGS: readonly MuxSessionDirectBinding[] = [
  {
    key: "Mod-d",
    command: "pane.splitRight",
    desc: "Split right",
    repeatable: false,
    riskyReason: "Mod-d is the terminal multiplexer split chord.",
  },
  {
    key: "Mod-Shift-d",
    command: "pane.splitDown",
    desc: "Split down",
    repeatable: false,
    riskyReason: "Mod-Shift-d is the terminal multiplexer split chord.",
  },
  {
    key: "Mod-b",
    command: "sidebar.toggle",
    desc: "Toggle sidebar",
    repeatable: false,
    riskyReason: "Mod-b is the terminal multiplexer sidebar toggle chord.",
  },
  {
    key: "Mod-,",
    command: "settings.show",
    desc: "Open settings",
    repeatable: false,
  },
];

export const MUX_SESSION_CONTEXT_BINDINGS: readonly MuxSessionContextBinding[] =
  [];

/** Commands allowed both as prefix (HUD) and as a direct chord. */
export const MUX_SESSION_DUAL_PATH_COMMANDS: readonly MuxSessionCommand[] = [];

const PREFIX_BINDING_BY_KEY = new Map(
  MUX_SESSION_PREFIX_BINDINGS.map((binding) => [binding.key, binding]),
);

export type MuxSessionKeyEvent = KeyEventLike &
  Pick<KeyboardEvent, "repeat" | "isComposing">;

export type MuxSessionKeymapState = ChordState;

export function createMuxSessionKeymapState(): MuxSessionKeymapState {
  return createChordState();
}

export function clearMuxSessionKeymapState(
  state: MuxSessionKeymapState,
): void {
  clearChord(state);
}

export function muxSessionPrefixBindingKey(
  key: string,
  prefix = MUX_SESSION_PREFIX,
): string {
  return `${prefix} ${key}`;
}

export function muxSessionShortcutFor(command: string): string | undefined {
  const binding = MUX_SESSION_PREFIX_BINDINGS.find(
    (item) => item.command === command && item.hud !== false,
  );
  return binding ? muxSessionPrefixBindingKey(binding.key) : undefined;
}

export function muxSessionDirectShortcutFor(
  command: string,
): string | undefined {
  return MUX_SESSION_DIRECT_BINDINGS.find((item) => item.command === command)
    ?.key;
}

export function muxSessionHudBindings(): readonly MuxSessionPrefixBinding[] {
  return MUX_SESSION_PREFIX_BINDINGS.filter((item) => item.hud !== false);
}

export function serializeMuxSessionPrefixKey(
  event: Pick<KeyEventLike, "key" | "shiftKey">,
): string {
  if (event.shiftKey && event.key.length === 1) {
    return `Shift-${event.key.toUpperCase()}`;
  }
  if (event.key.length === 1) return event.key.toLowerCase();
  return event.key;
}

export function isMuxSessionJumpKey(key: string): boolean {
  return /^[1-9]$/.test(key);
}

export function matchMuxSessionPrefixBinding(
  key: string,
): MuxSessionPrefixBinding | undefined {
  return PREFIX_BINDING_BY_KEY.get(key);
}

export function matchMuxSessionDirectBinding(
  event: KeyEventLike,
): MuxSessionDirectBinding | undefined {
  return MUX_SESSION_DIRECT_BINDINGS.find((item) =>
    keyEventMatchesBinding(event, item.key),
  );
}

export function matchMuxSessionContextBinding(
  _event: KeyEventLike,
  _kind: string | undefined,
): MuxSessionContextBinding | undefined {
  return undefined;
}

export type MuxSessionKeydownContext = {
  readonly overlayOpen: boolean;
  readonly inEditable: boolean;
  readonly inTerminal: boolean;
  readonly inPrefixButton: boolean;
  readonly zoomed: boolean;
  /** Whether a layout with a toggleable vertical sidebar is active. */
  readonly sidebarLayout?: boolean;
  readonly contextKind?: string;
};

export type MuxSessionKeydownResult =
  | { readonly type: "prefix-started"; readonly prefix: string }
  | {
      readonly type: "command";
      readonly command: MuxSessionCommand;
      readonly jumpIndex?: number;
    }
  | { readonly type: "prefix-literal"; readonly byte: string }
  | { readonly type: "prefix-cancelled" }
  | { readonly type: "consume" };

function commandResult(
  binding:
    | MuxSessionPrefixBinding
    | MuxSessionDirectBinding
    | MuxSessionContextBinding,
  event: MuxSessionKeyEvent,
): MuxSessionKeydownResult {
  if (binding.repeatable === false && event.repeat) return { type: "consume" };
  return { type: "command", command: binding.command };
}

/**
 * Resolve one keydown without touching React or the DOM. The caller owns
 * preventDefault/stopPropagation and command execution; this function only
 * mutates the small chord state machine so stale closures cannot dispatch a
 * second command after the timeout.
 */
export function resolveMuxSessionKeydown(
  event: MuxSessionKeyEvent,
  _state: MuxSessionKeymapState,
  context: MuxSessionKeydownContext,
): MuxSessionKeydownResult | null {
  if (context.overlayOpen || context.inEditable || context.inPrefixButton) return null;
  const binding = matchMuxSessionDirectBinding(event);
  if (binding?.command === "sidebar.toggle" && context.sidebarLayout === false) return null;
  return binding ? commandResult(binding, event) : null;
}

/**
 * Control byte a `Ctrl-<letter>` / `Mod-<letter>` prefix would have sent to
 * the PTY, so pressing the prefix twice passes it through (tmux send-prefix).
 * `Mod-k` sends `^K` (kill-line) on every platform. Returns `null` when the
 * prefix has no control-code equivalent.
 */
export function prefixLiteralByte(prefix = SHELL_PREFIX): string | null {
  const match = /^(?:Ctrl|Mod)-([a-z])$/i.exec(prefix.trim());
  if (!match) return null;
  const letter = match[1]!.toLowerCase();
  const code = letter.charCodeAt(0) - 96;
  if (code < 1 || code > 26) return null;
  return String.fromCharCode(code);
}
