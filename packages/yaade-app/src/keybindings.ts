/**
 * YAADE keybinding catalog — the only file that assigns keys to commands.
 *
 * Dispatch, HUD, shortcut labels, and tests import from here. Do not add
 * chords in components. Prefix commands have one key each; direct layout
 * commands are explicit exceptions (settings is the sole dual-path command).
 *
 *   Tool Session (`/`)           canonical — edit TOOL_SESSION_* tables
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
 *   Dead dump      packages/yaade-workspace/src/default-keybindings.ts
 *                  (VS Code leftover; layer 0 is empty in the live app)
 */

import {
  chordIsActive,
  clearChord,
  createChordState,
  keyEventMatchesBinding,
  keyEventMatchesChordSecond,
  startChord,
  type ChordState,
  type KeyEventLike,
} from "@yaade/workspace";

export const SHELL_PREFIX = "Mod-k";
export const TOOL_SESSION_PREFIX = SHELL_PREFIX;

export type ToolSessionCommand =
  | "tool.newTerminal"
  | "tool.newGit"
  | "tool.next"
  | "tool.previous"
  | "tab.next"
  | "tab.previous"
  | "pane.zoom"
  | "pane.splitRight"
  | "pane.splitDown"
  | "tool.switch"
  | "sidebar.toggle"
  | "session.switch"
  | "tool.jump"
  | "session.new"
  | "tab.new"
  | "tool.close"
  | "session.close"
  | "settings.show";

export type ToolSessionPrefixGroupId = "open" | "move" | "session";

export type ToolSessionPrefixBinding = {
  readonly key: string;
  readonly command: ToolSessionCommand;
  readonly desc: string;
  readonly group: ToolSessionPrefixGroupId;
  /** When false, the binding still works but stays off the HUD. */
  readonly hud?: boolean;
  /** Whether holding the key may repeat the command. Defaults to true. */
  readonly repeatable?: boolean;
};

export type ToolSessionDirectBinding = {
  readonly key: string;
  readonly command: ToolSessionCommand;
  readonly desc: string;
  /** Whether holding the key may repeat the command. Defaults to true. */
  readonly repeatable?: boolean;
  /** Required when the chord intentionally collides with a browser action. */
  readonly riskyReason?: string;
};

export type ToolSessionContextKind = never;

export type ToolSessionContextBinding = {
  readonly key: string;
  readonly command: ToolSessionCommand;
  readonly desc: string;
  readonly when: readonly ToolSessionContextKind[];
  /** Risky chord — only legal with a written reason. */
  readonly riskyReason?: string;
  /** Whether holding the key may repeat the command. Defaults to true. */
  readonly repeatable?: boolean;
};

export const TOOL_SESSION_PREFIX_GROUPS: readonly {
  readonly id: ToolSessionPrefixGroupId;
  readonly label: string;
}[] = [
  { id: "open", label: "Open" },
  { id: "move", label: "Move" },
  { id: "session", label: "Session" },
];

export const TOOL_SESSION_PREFIX_BINDINGS: readonly ToolSessionPrefixBinding[] =
  [
    {
      key: "t",
      command: "tool.newTerminal",
      desc: "New Terminal",
      group: "open",
    },
    { key: "g", command: "tool.newGit", desc: "New Git", group: "open" },
    { key: "j", command: "tool.next", desc: "Next tool", group: "move" },
    {
      key: "k",
      command: "tool.previous",
      desc: "Previous tool",
      group: "move",
    },
    { key: "l", command: "tab.next", desc: "Next tab", group: "move" },
    { key: "h", command: "tab.previous", desc: "Previous tab", group: "move" },
    { key: "z", command: "pane.zoom", desc: "Zoom pane", group: "move" },
    { key: "u", command: "tool.switch", desc: "Switch tool", group: "move" },
    {
      key: "b",
      command: "sidebar.toggle",
      desc: "Toggle sidebar",
      group: "move",
    },
    {
      key: "w",
      command: "session.switch",
      desc: "Switch session",
      group: "move",
    },
    { key: "1", command: "tool.jump", desc: "Jump tool 1–9", group: "move" },
    { key: "c", command: "session.new", desc: "New session", group: "session" },
    { key: "n", command: "tab.new", desc: "New tab", group: "session" },
    { key: "x", command: "tool.close", desc: "Close tool", group: "session" },
    {
      key: "Shift-X",
      command: "session.close",
      desc: "Close session",
      group: "session",
    },
    { key: ",", command: "settings.show", desc: "Settings", group: "session" },
  ];

/**
 * Direct layout chords are deliberately supported even though browsers label
 * them as risky: Chromium/Electron delivers these keydowns and the app has
 * visible context-menu fallbacks. Structural commands never repeat on hold.
 */
export const TOOL_SESSION_DIRECT_BINDINGS: readonly ToolSessionDirectBinding[] =
  [
    { key: "Mod-,", command: "settings.show", desc: "Settings" },
    {
      key: "Mod-d",
      command: "pane.splitRight",
      desc: "Split right",
      repeatable: false,
      riskyReason:
        "Direct pane layout is a high-frequency desktop action; the context menu remains available if a browser claims the chord.",
    },
    {
      key: "Mod-Shift-d",
      command: "pane.splitDown",
      desc: "Split down",
      repeatable: false,
      riskyReason:
        "Direct pane layout is a high-frequency desktop action; the context menu remains available if a browser claims the chord.",
    },
  ];

export const TOOL_SESSION_CONTEXT_BINDINGS: readonly ToolSessionContextBinding[] =
  [];

/** Commands allowed both as prefix (HUD) and as a direct chord. */
export const TOOL_SESSION_DUAL_PATH_COMMANDS: readonly ToolSessionCommand[] = [
  "settings.show",
];

const PREFIX_BINDING_BY_KEY = new Map(
  TOOL_SESSION_PREFIX_BINDINGS.map((binding) => [binding.key, binding]),
);

export type ToolSessionKeyEvent = KeyEventLike &
  Pick<KeyboardEvent, "repeat" | "isComposing">;

export type ToolSessionKeymapState = ChordState;

export function createToolSessionKeymapState(): ToolSessionKeymapState {
  return createChordState();
}

export function clearToolSessionKeymapState(
  state: ToolSessionKeymapState,
): void {
  clearChord(state);
}

export function toolSessionPrefixBindingKey(
  key: string,
  prefix = TOOL_SESSION_PREFIX,
): string {
  return `${prefix} ${key}`;
}

export function toolSessionShortcutFor(command: string): string | undefined {
  const binding = TOOL_SESSION_PREFIX_BINDINGS.find(
    (item) => item.command === command && item.hud !== false,
  );
  return binding ? toolSessionPrefixBindingKey(binding.key) : undefined;
}

export function toolSessionDirectShortcutFor(
  command: string,
): string | undefined {
  return TOOL_SESSION_DIRECT_BINDINGS.find((item) => item.command === command)
    ?.key;
}

export function toolSessionHudBindings(): readonly ToolSessionPrefixBinding[] {
  return TOOL_SESSION_PREFIX_BINDINGS.filter((item) => item.hud !== false);
}

export function serializeToolSessionPrefixKey(
  event: Pick<KeyEventLike, "key" | "shiftKey">,
): string {
  if (event.shiftKey && event.key.length === 1) {
    return `Shift-${event.key.toUpperCase()}`;
  }
  if (event.key.length === 1) return event.key.toLowerCase();
  return event.key;
}

export function isToolSessionJumpKey(key: string): boolean {
  return /^[1-9]$/.test(key);
}

export function matchToolSessionPrefixBinding(
  key: string,
): ToolSessionPrefixBinding | undefined {
  return PREFIX_BINDING_BY_KEY.get(key);
}

export function matchToolSessionDirectBinding(
  event: KeyEventLike,
): ToolSessionDirectBinding | undefined {
  return TOOL_SESSION_DIRECT_BINDINGS.find((item) =>
    keyEventMatchesBinding(event, item.key),
  );
}

export function matchToolSessionContextBinding(
  _event: KeyEventLike,
  _kind: string | undefined,
): ToolSessionContextBinding | undefined {
  return undefined;
}

export type ToolSessionKeydownContext = {
  readonly overlayOpen: boolean;
  readonly inEditable: boolean;
  readonly inTerminal: boolean;
  readonly inPrefixButton: boolean;
  readonly zoomed: boolean;
  readonly contextKind?: string;
};

export type ToolSessionKeydownResult =
  | { readonly type: "prefix-started"; readonly prefix: string }
  | {
      readonly type: "command";
      readonly command: ToolSessionCommand;
      readonly jumpIndex?: number;
    }
  | { readonly type: "prefix-literal"; readonly byte: string }
  | { readonly type: "prefix-cancelled" }
  | { readonly type: "consume" };

function isModifierOnlyKey(key: string): boolean {
  return (
    key === "Alt" ||
    key === "Control" ||
    key === "Meta" ||
    key === "Shift" ||
    key === "OS" ||
    key === "CapsLock" ||
    key === "Fn"
  );
}

function commandResult(
  binding:
    | ToolSessionPrefixBinding
    | ToolSessionDirectBinding
    | ToolSessionContextBinding,
  event: ToolSessionKeyEvent,
): ToolSessionKeydownResult {
  if (binding.repeatable === false && event.repeat) return { type: "consume" };
  return { type: "command", command: binding.command };
}

/**
 * Resolve one keydown without touching React or the DOM. The caller owns
 * preventDefault/stopPropagation and command execution; this function only
 * mutates the small chord state machine so stale closures cannot dispatch a
 * second command after the timeout.
 */
export function resolveToolSessionKeydown(
  event: ToolSessionKeyEvent,
  state: ToolSessionKeymapState,
  context: ToolSessionKeydownContext,
  now = Date.now(),
): ToolSessionKeydownResult | null {
  if (event.isComposing || isModifierOnlyKey(event.key)) return null;
  if (!chordIsActive(state, now)) clearChord(state);
  if (context.overlayOpen) return null;

  const prefixActive = chordIsActive(state, now) && state.prefix != null;
  if (context.inEditable && !context.inTerminal) {
    if (prefixActive) {
      clearChord(state);
      return { type: "prefix-cancelled" };
    }
    return null;
  }

  if (prefixActive && state.prefix) {
    const prefix = state.prefix;
    if (
      event.key === "Tab" ||
      (context.inPrefixButton && (event.key === "Enter" || event.key === " "))
    ) {
      return null;
    }
    if (event.key === "Escape") {
      clearChord(state);
      return { type: "prefix-cancelled" };
    }
    // Holding Mod-k must not be interpreted as the terminal literal prefix.
    if (event.repeat && keyEventMatchesBinding(event, prefix)) {
      return { type: "consume" };
    }
    if (
      context.inTerminal &&
      keyEventMatchesChordSecond(event, `${prefix} k`, prefix)
    ) {
      clearChord(state);
      const byte = prefixLiteralByte(prefix);
      return byte ? { type: "prefix-literal", byte } : { type: "consume" };
    }

    const key = serializeToolSessionPrefixKey(event);
    if (isToolSessionJumpKey(key)) {
      clearChord(state);
      return {
        type: "command",
        command: "tool.jump",
        jumpIndex: Number(key) - 1,
      };
    }
    const binding = matchToolSessionPrefixBinding(key);
    clearChord(state);
    return binding ? commandResult(binding, event) : { type: "consume" };
  }

  const direct = matchToolSessionDirectBinding(event);
  if (direct) return commandResult(direct, event);

  const contextBinding = matchToolSessionContextBinding(
    event,
    context.contextKind,
  );
  if (contextBinding) return commandResult(contextBinding, event);

  if (context.zoomed && event.key === "Escape") {
    return { type: "command", command: "pane.zoom" };
  }

  if (event.repeat && keyEventMatchesBinding(event, TOOL_SESSION_PREFIX)) {
    return { type: "consume" };
  }
  if (keyEventMatchesBinding(event, TOOL_SESSION_PREFIX)) {
    startChord(state, TOOL_SESSION_PREFIX, now);
    return { type: "prefix-started", prefix: TOOL_SESSION_PREFIX };
  }

  return null;
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
