export type NeovimKeyboardNotation = {
  readonly kind: "input" | "browser-action"
  readonly value?: string
}

const SPECIAL_KEYS: ReadonlyMap<string, string> = new Map([
  ["Escape", "Esc"],
  ["Enter", "CR"],
  ["Tab", "Tab"],
  ["Backspace", "BS"],
  ["Delete", "Del"],
  ["Insert", "Insert"],
  ["ArrowUp", "Up"],
  ["ArrowDown", "Down"],
  ["ArrowLeft", "Left"],
  ["ArrowRight", "Right"],
  ["Home", "Home"],
  ["End", "End"],
  ["PageUp", "PageUp"],
  ["PageDown", "PageDown"],
  ["ContextMenu", "Menu"],
  ["Help", "Help"],
])

export type NeovimKeyEvent = {
  readonly key: string
  readonly isComposing?: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  /** True when the browser has already combined Ctrl+Alt into AltGraph text. */
  readonly altGraphKey?: boolean
  /** Navigator platform, used only to distinguish macOS Option text. */
  readonly platform?: string
}

function modifierNotation(event: NeovimKeyEvent): string[] {
  const modifiers: string[] = []
  if (event.ctrlKey) modifiers.push("C")
  if (event.altKey) modifiers.push("M")
  if (event.metaKey) modifiers.push("D")
  if (event.shiftKey) modifiers.push("S")
  return modifiers
}

function notationWithModifiers(key: string, event: NeovimKeyEvent): string {
  const modifiers = modifierNotation(event)
  if (modifiers.length === 0) return key
  return `<${modifiers.join("-")}-${key}>`
}

function isMacOptionText(event: NeovimKeyEvent): boolean {
  return event.altKey && !event.ctrlKey && !event.metaKey && /Mac|iPhone|iPad/u.test(event.platform ?? "")
}

/** Pure KeyboardEvent encoder using Neovim's key notation (not terminal bytes). */
export function encodeNeovimKey(event: NeovimKeyEvent): NeovimKeyboardNotation {
  if (event.isComposing || event.key === "Process" || event.key === "Dead" || event.key === "Unidentified") {
    return { kind: "input" }
  }
  if (event.key === "F11" || event.key === "F12") return { kind: "browser-action" }
  // AltGraph and macOS Option produce their printable character through the
  // native input surface. Sending a Meta mapping as well would duplicate it.
  if (event.altGraphKey || isMacOptionText(event)) return { kind: "input" }
  const special = SPECIAL_KEYS.get(event.key)
  if (special) {
    const modifiers = modifierNotation(event)
    return { kind: "input", value: modifiers.length === 0 ? `<${special}>` : notationWithModifiers(special, event) }
  }
  if (event.key.length === 1) {
    const key = event.key === "<" ? "LT" : event.key === " " ? "Space" : event.key
    if (!event.ctrlKey && !event.altKey && !event.metaKey) {
      // Let the hidden textarea's input event carry printable Unicode and IME
      // text. This avoids sending a keydown and input duplicate.
      return { kind: "input" }
    }
    return { kind: "input", value: notationWithModifiers(key === "LT" || key === "Space" ? key : key.toLowerCase(), event) }
  }
  if (/^F(?:[1-9]|1[0-2])$/.test(event.key)) {
    const modifiers = modifierNotation(event)
    return { kind: "input", value: modifiers.length === 0 ? `<${event.key}>` : notationWithModifiers(event.key, event) }
  }
  return { kind: "input", value: notationWithModifiers(event.key, event) }
}

export function encodeNeovimText(text: string): string {
  return text.replaceAll("<", "<LT>")
}

export type NeovimMouseAction = "press" | "release" | "drag" | "move" | "wheel"

export type NeovimMouseEvent = {
  readonly action: NeovimMouseAction
  readonly button: "left" | "right" | "middle" | "wheel"
  readonly modifier: string
  readonly row: number
  readonly col: number
}

export function mouseButton(button: number): "left" | "right" | "middle" | "wheel" {
  if (button === 2) return "right"
  if (button === 1) return "middle"
  return "left"
}

export function mouseModifier(event: Pick<MouseEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string {
  const modifiers: string[] = []
  if (event.shiftKey) modifiers.push("S")
  if (event.ctrlKey) modifiers.push("C")
  if (event.altKey) modifiers.push("A")
  if (event.metaKey) modifiers.push("D")
  return modifiers.join("-")
}
