import type { JetKeyBinding } from "./keymaps.js"

export type KeymapContext = {
  editorFocus: boolean
  paletteOpen: boolean
  quickOpenOpen: boolean
  bufferListOpen: boolean
  openFileOpen: boolean
  cdOpen: boolean
  projectSwitcherOpen: boolean
  gotoLineOpen: boolean
  outlineOpen: boolean
  terminalListOpen: boolean
  agentCliPickerOpen: boolean
  settingsOpen: boolean
  workspaceOpen: boolean
  explorerFocus: boolean
  terminalExplorerFocus: boolean
  outputFocus: boolean
  terminalFocus: boolean
  listFocus: boolean
}

const MODIFIERS = new Set(["Mod", "Cmd", "Ctrl", "Alt", "Shift"])

export type ParsedKeyPart = {
  modifiers: Set<string>
  key: string
}

export function anyOverlayOpen(ctx: KeymapContext): boolean {
  return (
    ctx.paletteOpen ||
    ctx.quickOpenOpen ||
    ctx.bufferListOpen ||
    ctx.openFileOpen ||
    ctx.cdOpen ||
    ctx.projectSwitcherOpen ||
    ctx.gotoLineOpen ||
    ctx.outlineOpen ||
    ctx.terminalListOpen ||
    ctx.agentCliPickerOpen ||
    ctx.settingsOpen
  )
}

/** Primary chord modifier: ⌘ on Apple, Ctrl elsewhere. */
export function isMacPlatform(): boolean {
  if (typeof navigator !== "undefined" && navigator.platform) {
    return /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  }
  const proc =
    typeof globalThis !== "undefined"
      ? (globalThis as { process?: { platform?: string } }).process
      : undefined
  return proc?.platform === "darwin"
}

export function matchesWhen(binding: JetKeyBinding, ctx: KeymapContext): boolean {
  return binding.when?.(ctx) ?? true
}

/** True when binding only fires with editor focus (route via CM keymap, not window). */
export function isEditorKeyBinding(binding: JetKeyBinding, ctx: KeymapContext): boolean {
  if (!binding.when) return false
  return binding.when({ ...ctx, editorFocus: true }) && !binding.when({ ...ctx, editorFocus: false })
}

export function parseKeyPart(part: string): ParsedKeyPart {
  const segments = part.split("-").filter(Boolean)
  const modifiers = new Set<string>()
  let key = ""
  for (const segment of segments) {
    if (MODIFIERS.has(segment)) modifiers.add(segment)
    else key = segment
  }
  if (!key && part.endsWith("-")) key = "-"
  return { modifiers, key }
}

export function parseBindingKey(key: string): string[] {
  return key.trim().split(/\s+/).filter(Boolean)
}

export function isChordBinding(key: string): boolean {
  return parseBindingKey(key).length > 1
}

function normalizeBindingKey(key: string): string {
  if (key === "Backquote") return "`"
  return key.length === 1 ? key.toLowerCase() : key
}

function eventKeyMatches(expected: string, e: KeyboardEvent): boolean {
  const want = normalizeBindingKey(expected)
  const fromKey = normalizeBindingKey(e.key)
  if (fromKey === want) return true
  if (want === "`" && (e.code === "Backquote" || e.key === "`")) return true
  if (want === "-" && (e.key === "-" || e.key === "Minus" || e.code === "Minus")) return true
  if (want === "\\" && (e.key === "\\" || e.code === "Backslash")) return true
  return false
}

export function keyEventMatchesBindingPart(
  e: KeyboardEvent,
  part: string,
  opts?: { ignoreHeldMod?: boolean },
): boolean {
  const { modifiers, key } = parseKeyPart(part)
  const needsShift = modifiers.has("Shift")
  const needsAlt = modifiers.has("Alt")
  const needsMod = modifiers.has("Mod")
  const needsCmd = modifiers.has("Cmd")
  const needsCtrl = modifiers.has("Ctrl")

  if (needsShift !== e.shiftKey) return false
  if (needsAlt !== e.altKey) return false

  // After a Mod- prefix, users (and Playwright) often still hold ⌘/Ctrl.
  // Ignore leftover Mod unless this part itself asks for it.
  const ignoreHeldMod =
    opts?.ignoreHeldMod === true && !needsMod && !needsCmd && !needsCtrl
  const hasMeta = ignoreHeldMod ? false : e.metaKey
  const hasCtrl = ignoreHeldMod ? false : e.ctrlKey
  const mac = isMacPlatform()

  // Mod = platform primary (⌘ mac / Ctrl elsewhere). Cmd always means meta.
  let wantMeta = needsCmd
  let wantCtrl = needsCtrl
  if (needsMod) {
    if (mac) wantMeta = true
    else wantCtrl = true
  }

  if (wantMeta && wantCtrl) {
    if (!hasMeta || !hasCtrl) return false
  } else if (wantMeta) {
    if (!hasMeta) return false
  } else if (wantCtrl) {
    if (!hasCtrl || hasMeta) return false
  } else {
    if (hasMeta || hasCtrl) return false
  }

  return eventKeyMatches(key, e)
}

export function keyEventMatchesBinding(e: KeyboardEvent, key: string): boolean {
  const parts = parseBindingKey(key)
  if (parts.length !== 1) return false
  return keyEventMatchesBindingPart(e, parts[0]!)
}

export function keyEventMatchesChordSecond(e: KeyboardEvent, key: string, prefix: string): boolean {
  const parts = parseBindingKey(key)
  if (parts.length < 2 || parts[0] !== prefix) return false
  return keyEventMatchesBindingPart(e, parts[1]!, { ignoreHeldMod: true })
}

export function jetKeyToCodeMirrorKey(key: string): string | null {
  if (isChordBinding(key)) return null
  const part = parseBindingKey(key)[0]
  if (!part) return null
  const { modifiers, key: keyName } = parseKeyPart(part)
  const cmMods: string[] = []
  if (modifiers.has("Cmd") || modifiers.has("Mod")) cmMods.push("Mod")
  if (modifiers.has("Ctrl")) cmMods.push("Ctrl")
  if (modifiers.has("Alt")) cmMods.push("Alt")
  if (modifiers.has("Shift")) cmMods.push("Shift")
  const normalized = normalizeBindingKey(keyName)
  if (cmMods.length === 0) return normalized
  return `${cmMods.join("-")}-${normalized}`
}

export type ChordState = {
  prefix: string | null
  expiresAt: number
}

/**
 * Long enough for a prefix key to double as a menu (the which-key panel is
 * visible for this window), short enough that a stray prefix press does not
 * leave the shell swallowing input.
 */
export const CHORD_TIMEOUT_MS = 2500

export function createChordState(): ChordState {
  return { prefix: null, expiresAt: 0 }
}

export function chordIsActive(state: ChordState, now = Date.now()): boolean {
  return state.prefix != null && now < state.expiresAt
}

export function startChord(state: ChordState, prefix: string, now = Date.now()): void {
  state.prefix = prefix
  state.expiresAt = now + CHORD_TIMEOUT_MS
}

export function clearChord(state: ChordState): void {
  state.prefix = null
  state.expiresAt = 0
}

export function resolveKeydownBinding(
  e: KeyboardEvent,
  bindings: JetKeyBinding[],
  ctx: KeymapContext,
  chordState: ChordState,
  now = Date.now(),
): JetKeyBinding | "chord-started" | null {
  if (!chordIsActive(chordState, now)) clearChord(chordState)

  const active = bindings.filter(b => matchesWhen(b, ctx))

  if (chordIsActive(chordState, now) && chordState.prefix) {
    const prefix = chordState.prefix
    for (const binding of active) {
      if (!isChordBinding(binding.key)) continue
      if (!keyEventMatchesChordSecond(e, binding.key, prefix)) continue
      clearChord(chordState)
      return binding
    }
    clearChord(chordState)
    return null
  }

  for (const binding of active) {
    if (!isChordBinding(binding.key)) continue
    const prefix = parseBindingKey(binding.key)[0]
    if (!prefix) continue
    if (!keyEventMatchesBindingPart(e, prefix)) continue
    startChord(chordState, prefix, now)
    return "chord-started"
  }

  for (const binding of active) {
    if (isChordBinding(binding.key)) continue
    if (!keyEventMatchesBinding(e, binding.key)) continue
    return binding
  }

  return null
}
