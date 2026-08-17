import type { NeovimSurface, NeovimSurfaceLocation } from "./surface.js"

// ToolSession currently allows six panes in a window. Keep a small amount of
// headroom for a remount during a tab transition, but never let this process
// grow an unbounded global surface registry.
const MAX_SURFACES = 8
const MAX_PENDING_LOCATIONS = 32
const surfaces = new Map<string, NeovimSurface>()
const pendingLocations = new Map<string, NeovimSurfaceLocation>()

function rememberPendingLocation(toolUseId: string, location: NeovimSurfaceLocation): void {
  pendingLocations.delete(toolUseId)
  pendingLocations.set(toolUseId, location)
  while (pendingLocations.size > MAX_PENDING_LOCATIONS) {
    const oldest = pendingLocations.keys().next().value
    if (typeof oldest !== "string") break
    pendingLocations.delete(oldest)
  }
}

function evictUnreachableSurface(): boolean {
  for (const [toolUseId, surface] of surfaces) {
    const element = document.querySelector<HTMLElement>(`[data-yaade-neovim-tool-use="${CSS.escape(toolUseId)}"]`)
    if (element?.isConnected) continue
    surfaces.delete(toolUseId)
    surface.dispose()
    return true
  }
  return false
}

export function registerNeovimSurface(toolUseId: string, surface: NeovimSurface): void {
  const previous = surfaces.get(toolUseId)
  if (previous && previous !== surface) previous.dispose()
  surfaces.delete(toolUseId)
  while (surfaces.size >= MAX_SURFACES && !evictUnreachableSurface()) {
    // The pane cap should make this unreachable. Refuse the new lease rather
    // than evicting a mounted surface that Search or input can still target.
    surface.dispose()
    return
  }
  surfaces.set(toolUseId, surface)
  const pending = pendingLocations.get(toolUseId)
  if (pending) {
    pendingLocations.delete(toolUseId)
    void surface.openLocation(pending).catch(() => {
      rememberPendingLocation(toolUseId, pending)
    })
  }
}

export function unregisterNeovimSurface(toolUseId: string, surface?: NeovimSurface): void {
  if (surface && surfaces.get(toolUseId) !== surface) return
  surfaces.delete(toolUseId)
}

export function getRegisteredNeovimSurface(toolUseId: string): NeovimSurface | undefined {
  return surfaces.get(toolUseId)
}

export function queueNeovimLocation(toolUseId: string, location: NeovimSurfaceLocation): void {
  rememberPendingLocation(toolUseId, location)
  const surface = surfaces.get(toolUseId)
  if (!surface) return
  pendingLocations.delete(toolUseId)
  void surface.openLocation(location).catch(() => {
    rememberPendingLocation(toolUseId, location)
  })
}

export function openRegisteredNeovimLocation(
  toolUseId: string,
  location: NeovimSurfaceLocation,
): boolean {
  const surface = surfaces.get(toolUseId)
  if (!surface) {
    queueNeovimLocation(toolUseId, location)
    return false
  }
  void surface.openLocation(location).catch(() => {
    rememberPendingLocation(toolUseId, location)
  })
  surface.focus()
  return true
}

export function readNeovimText(toolUseId?: string): string {
  return resolveSurface(toolUseId)?.getText() ?? ""
}

export function readNeovimCursor(toolUseId?: string): { x: number; y: number; hidden: boolean } | null {
  return resolveSurface(toolUseId)?.getCursor() ?? null
}

export function readNeovimDims(toolUseId?: string): { cols: number; rows: number } | null {
  return resolveSurface(toolUseId)?.getDims() ?? null
}

export function readNeovimDiagnostics(toolUseId?: string) {
  return resolveSurface(toolUseId)?.getDiagnostics() ?? null
}

export function readNeovimRegistryDiagnostics(): {
  readonly surfaceCount: number
  readonly pendingLocationCount: number
  readonly surfaceIds: readonly string[]
} {
  return {
    surfaceCount: surfaces.size,
    pendingLocationCount: pendingLocations.size,
    surfaceIds: [...surfaces.keys()],
  }
}

export function sendLiteralNeovimInput(toolUseId: string, value: string): boolean {
  const surface = surfaces.get(toolUseId)
  if (!surface) return false
  surface.sendLiteralControl(value)
  return true
}

export async function dispatchNeovimTestInput(toolUseId: string, value: string): Promise<number> {
  const surface = surfaces.get(toolUseId)
  if (!surface) throw new Error("Neovim surface is not mounted")
  return surface.dispatchTestInput(value)
}

export function focusRegisteredNeovim(toolUseId?: string): boolean {
  const surface = resolveSurface(toolUseId)
  if (!surface) return false
  surface.focus()
  return true
}

function resolveSurface(toolUseId?: string): NeovimSurface | undefined {
  if (toolUseId) return surfaces.get(toolUseId)
  const elements = [...document.querySelectorAll<HTMLElement>("[data-yaade-neovim-surface]")]
  const visible = elements.find(element => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && element.closest("[data-focused]")
  }) ?? elements.find(element => element.getBoundingClientRect().width > 0)
  const id = visible?.dataset.yaadeNeovimToolUse
  if (id) return surfaces.get(id)
  return [...surfaces.values()].at(-1)
}
