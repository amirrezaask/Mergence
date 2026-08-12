import type { IDisposable, Terminal } from "@xterm/xterm"
import { WebglAddon } from "@xterm/addon-webgl"

export type TerminalGpuRendererKind = "webgl" | "dom"

export type TerminalGpuRendererHandle = {
  kind: TerminalGpuRendererKind
  /** Prefer WebGL when true; drop to Dom when false (hidden / unfocused). */
  setHighPerformance: (enabled: boolean) => void
  dispose: () => void
}

/**
 * Prefer WebGL for agent/TUI paint storms; fall back to DomRenderer.
 * DomRenderer is the last resort when WebGL fails (headless CI, context loss).
 * xterm v6 removed the Canvas addon — WebGL or Dom only.
 * Call `setHighPerformance(false)` when the pane is off-screen to release the WebGL context.
 */
export function attachTerminalGpuRenderer(term: Terminal): TerminalGpuRendererHandle {
  let active: IDisposable | null = null
  let kind: TerminalGpuRendererKind = "dom"
  let disposed = false
  let highPerformance = true

  const syncPanelAttr = () => {
    const panel = term.element?.closest?.("[data-yaade-terminal-panel]") as
      | HTMLElement
      | null
      | undefined
    if (panel) panel.dataset.yaadeTerminalRenderer = kind
  }

  const clearActive = () => {
    try {
      active?.dispose()
    } catch {
      /* addon may already be torn down with the terminal */
    }
    active = null
  }

  const useDom = () => {
    clearActive()
    kind = "dom"
    syncPanelAttr()
  }

  const tryWebgl = (): boolean => {
    clearActive()
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        if (disposed) return
        try {
          webgl.dispose()
        } catch {
          /* ignore */
        }
        active = null
        useDom()
      })
      term.loadAddon(webgl)
      active = webgl
      kind = "webgl"
      syncPanelAttr()
      return true
    } catch {
      useDom()
      return false
    }
  }

  const applyMode = () => {
    if (disposed) return
    if (highPerformance) tryWebgl()
    else useDom()
  }

  applyMode()

  return {
    get kind() {
      return kind
    },
    setHighPerformance(enabled: boolean) {
      if (disposed || enabled === highPerformance) return
      highPerformance = enabled
      applyMode()
    },
    dispose() {
      disposed = true
      clearActive()
      kind = "dom"
    },
  }
}
