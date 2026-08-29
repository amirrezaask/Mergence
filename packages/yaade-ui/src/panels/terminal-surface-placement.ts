import type { GhosttyTerminalSurface } from "@yaade/ghostty-react"

type ResidentSurface = {
  readonly terminalId: string
  readonly mount: HTMLDivElement
  readonly home: HTMLElement
  readonly surface: GhosttyTerminalSurface
  placement: HTMLElement | null
  generation: number
}

const residentSurfaces = new Map<string, ResidentSurface>()
const listeners = new Map<string, Set<() => void>>()

function notify(terminalId: string): void {
  for (const listener of listeners.get(terminalId) ?? []) listener()
}

export function registerResidentTerminalSurface(options: {
  readonly terminalId: string
  readonly mount: HTMLDivElement
  readonly home: HTMLElement
  readonly surface: GhosttyTerminalSurface
}): () => void {
  const existing = residentSurfaces.get(options.terminalId)
  if (existing && existing.surface !== options.surface) {
    // A terminal ID has one active client surface. Dispose is owned by the
    // registering controller; never create a second placement owner silently.
    throw new Error(`terminal surface already registered: ${options.terminalId}`)
  }
  const resident: ResidentSurface = {
    ...options,
    placement: null,
    generation: 1,
  }
  residentSurfaces.set(options.terminalId, resident)
  options.home.append(options.mount)
  notify(options.terminalId)
  return () => {
    if (residentSurfaces.get(options.terminalId) !== resident) return
    residentSurfaces.delete(options.terminalId)
    resident.placement = null
    notify(options.terminalId)
  }
}

export function acquireTerminalSurfacePlacement(
  terminalId: string,
  slot: HTMLElement,
  visible = true,
): (() => void) | null {
  const resident = residentSurfaces.get(terminalId)
  if (!resident) return null
  const generation = ++resident.generation
  resident.placement = slot
  slot.replaceChildren(resident.mount)
  resident.surface.setVisible(visible)
  if (visible) resident.surface.ensureFitted()
  return () => {
    const current = residentSurfaces.get(terminalId)
    if (current !== resident || resident.generation !== generation) return
    resident.placement = null
    resident.home.append(resident.mount)
    resident.surface.ensureFitted()
  }
}

export function subscribeResidentTerminalSurface(
  terminalId: string,
  listener: () => void,
): () => void {
  const set = listeners.get(terminalId) ?? new Set<() => void>()
  set.add(listener)
  listeners.set(terminalId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(terminalId)
  }
}

export function readResidentTerminalSurfaceCount(): number {
  return residentSurfaces.size
}
