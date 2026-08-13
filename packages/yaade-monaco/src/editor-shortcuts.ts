export type PrimaryShortcutEvent = {
  key: string
  code?: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export type InterceptablePrimaryShortcutEvent = PrimaryShortcutEvent & {
  repeat: boolean
  preventDefault: () => void
  stopPropagation: () => void
}

function isApplePlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platform)
}

function isPrimaryModifier(
  event: PrimaryShortcutEvent,
  platform: string,
): boolean {
  return isApplePlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
}

function isPKey(event: PrimaryShortcutEvent): boolean {
  return event.key.toLowerCase() === "p" || event.code === "KeyP"
}

function isSKey(event: PrimaryShortcutEvent): boolean {
  return event.key.toLowerCase() === "s" || event.code === "KeyS"
}

export function isPrimaryQuickOpenShortcut(
  event: PrimaryShortcutEvent,
  platform: string,
): boolean {
  if (event.altKey || event.shiftKey || !isPKey(event)) return false
  return isPrimaryModifier(event, platform)
}

export function isPrimaryCommandPaletteShortcut(
  event: PrimaryShortcutEvent,
  platform: string,
): boolean {
  if (event.altKey || !event.shiftKey || !isPKey(event)) return false
  return isPrimaryModifier(event, platform)
}

export function isPrimarySaveShortcut(
  event: PrimaryShortcutEvent,
  platform: string,
): boolean {
  if (event.altKey || event.shiftKey || !isSKey(event)) return false
  return isPrimaryModifier(event, platform)
}

export function interceptPrimaryQuickOpenShortcut(
  event: InterceptablePrimaryShortcutEvent,
  platform: string,
  onQuickOpen: () => void,
): boolean {
  if (!isPrimaryQuickOpenShortcut(event, platform)) return false
  event.preventDefault()
  event.stopPropagation()
  if (!event.repeat) onQuickOpen()
  return true
}

export function interceptPrimarySaveShortcut(
  event: InterceptablePrimaryShortcutEvent,
  platform: string,
  onSave: () => void,
): boolean {
  if (!isPrimarySaveShortcut(event, platform)) return false
  event.preventDefault()
  event.stopPropagation()
  if (!event.repeat) onSave()
  return true
}

export function interceptPrimaryCommandPaletteShortcut(
  event: InterceptablePrimaryShortcutEvent,
  platform: string,
  onCommandPalette: () => void,
): boolean {
  if (!isPrimaryCommandPaletteShortcut(event, platform)) return false
  event.preventDefault()
  event.stopPropagation()
  if (!event.repeat) onCommandPalette()
  return true
}
