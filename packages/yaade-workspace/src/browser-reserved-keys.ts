/**
 * YAADE runs as a browser tab, so the keymap competes with the browser's own
 * shortcuts. Chords fall into three buckets:
 *
 *  - **Reserved** — the browser consumes the chord before the page sees a
 *    `keydown`, or ignores `preventDefault()`. Binding one is a silent no-op.
 *  - **Risky** — delivered and cancellable in Chromium, but taken by another
 *    major browser or by a behaviour users expect to keep (find, save, reload).
 *  - Everything else is free.
 *
 * `Mod` normalizes to ⌘ on Apple and Ctrl elsewhere, so a `Mod-` entry covers
 * both platforms. Entries are compared against the *first* part of a chord —
 * `Mod-k t` is fine even though `Mod-t` is reserved, because the browser never
 * sees a bare `Mod-t`.
 */

import { parseBindingKey, parseKeyPart } from "./context-keys.js"

/** Chords a browser never delivers to the page (Chromium baseline). */
export const BROWSER_RESERVED_CHORDS: readonly string[] = [
  // Tab & window lifecycle
  "Mod-t",
  "Mod-n",
  "Mod-w",
  "Mod-q",
  "Mod-Shift-t",
  "Mod-Shift-n",
  "Mod-Shift-w",
  "Mod-Shift-q",
  // Address bar
  "Mod-l",
  // Tab switching
  "Mod-1",
  "Mod-2",
  "Mod-3",
  "Mod-4",
  "Mod-5",
  "Mod-6",
  "Mod-7",
  "Mod-8",
  "Mod-9",
  "Ctrl-Tab",
  "Ctrl-Shift-Tab",
  "Mod-Alt-ArrowLeft",
  "Mod-Alt-ArrowRight",
  // Browser zoom (keyboard zoom is not cancellable)
  "Mod-=",
  "Mod--",
  "Mod-0",
  // DevTools
  "F11",
  "F12",
  "Mod-Alt-i",
  "Mod-Alt-j",
  "Mod-Alt-c",
  "Mod-Shift-i",
  "Mod-Shift-j",
  "Mod-Shift-c",
  // macOS app-level
  "Cmd-h",
  "Cmd-m",
]

/**
 * Chords that work in Chromium but collide elsewhere, or that override a
 * browser behaviour users rely on. Allowed, but worth a deliberate decision.
 */
export const BROWSER_RISKY_CHORDS: readonly string[] = [
  "Mod-k", // Chrome (Windows/Linux): search from address bar
  "Mod-Shift-p", // Firefox: private window
  "Mod-Shift-k", // Firefox: web console
  "Mod-s",
  "Mod-p",
  "Mod-f",
  "Mod-d",
  "Mod-Shift-d",
  "Mod-o",
  "Mod-r",
  "Mod-g",
]

function canonicalizeChordPart(part: string): string {
  const { modifiers, key } = parseKeyPart(part)
  const order = ["Mod", "Cmd", "Ctrl", "Alt", "Shift"]
  const mods = order.filter(m => modifiers.has(m))
  const normalizedKey = key.length === 1 ? key.toLowerCase() : key
  return [...mods, normalizedKey].join("-")
}

/**
 * Only the leading part matters: once a prefix key opens a namespace, the
 * browser is no longer a competitor for the keys that follow it.
 */
function leadingPart(key: string): string | null {
  const parts = parseBindingKey(key)
  if (parts.length === 0) return null
  return canonicalizeChordPart(parts[0]!)
}

function matchesAny(key: string, list: readonly string[]): boolean {
  const lead = leadingPart(key)
  if (lead == null) return false
  return list.some(entry => canonicalizeChordPart(entry) === lead)
}

/** True when the browser will swallow this chord before the page sees it. */
export function isBrowserReservedChord(key: string): boolean {
  return matchesAny(key, BROWSER_RESERVED_CHORDS)
}

/** True when the chord works in Chromium but collides with another browser. */
export function isBrowserRiskyChord(key: string): boolean {
  return matchesAny(key, BROWSER_RISKY_CHORDS)
}

/** Reserved chords found in `bindings`, in registration order. */
export function findReservedBindings(
  bindings: readonly { key: string }[],
): string[] {
  return bindings.filter(b => isBrowserReservedChord(b.key)).map(b => b.key)
}
