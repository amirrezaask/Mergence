import type { JetCommandFn } from "./commands.js"
import { Emitter } from "@yaade/shared"
import { findReservedBindings } from "./browser-reserved-keys.js"

export type { JetCommandFn } from "./commands.js"

export type JetKeyBinding = {
  key: string
  run: JetCommandFn
  when?: (ctx: import("./context-keys.js").KeymapContext) => boolean
}

export function bind(
  key: string,
  run: JetCommandFn,
  when?: (ctx: import("./context-keys.js").KeymapContext) => boolean,
): JetKeyBinding {
  return { key, run, when }
}

function isDevLikeEnvironment(): boolean {
  const proc =
    typeof globalThis !== "undefined"
      ? (globalThis as { process?: { env?: Record<string, string | undefined> } })
          .process
      : undefined
  return proc?.env?.NODE_ENV !== "production"
}

/**
 * Reserved chords are silent no-ops in a browser tab, so a typo here surfaces
 * as "that shortcut just doesn't work" months later. Fail loudly instead.
 */
function assertNoReservedChords(
  layer: string,
  bindings: readonly JetKeyBinding[],
): void {
  const reserved = findReservedBindings(bindings)
  if (reserved.length === 0) return
  const message =
    `Keymap layer "${layer}" binds browser-reserved chords that the page ` +
    `will never receive: ${reserved.join(", ")}. Route them through a ` +
    `prefix key instead.`
  if (isDevLikeEnvironment()) throw new Error(message)
  console.error(message)
}

export class KeymapService {
  private layers: JetKeyBinding[][] = [[], [], []]
  private cachedAll: JetKeyBinding[] | null = null
  readonly onDidChange = new Emitter<void>()

  registerUser(bindings: JetKeyBinding[]): void {
    assertNoReservedChords("user", bindings)
    this.layers[1] = bindings
    this.cachedAll = null
    this.onDidChange.fire()
  }

  registerExtension(bindings: JetKeyBinding[]): void {
    assertNoReservedChords("extension", bindings)
    this.layers[2] = bindings
    this.cachedAll = null
    this.onDidChange.fire()
  }

  /** Stable snapshot until the next register* — safe to call per keydown. */
  allBindings(): JetKeyBinding[] {
    if (!this.cachedAll) {
      this.cachedAll = [...this.layers[2], ...this.layers[1], ...this.layers[0]]
    }
    return this.cachedAll
  }
}

export { createDefaultKeybindings } from "./default-keybindings.js"
export { type JetCommands } from "./yaade-commands.js"
