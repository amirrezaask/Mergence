import type { Terminal } from "@xterm/xterm"

const instances = new Map<string, Terminal>()

export function registerTerminalInstance(tabId: string, term: Terminal): void {
  instances.set(tabId, term)
}

export function getRegisteredTerminal(tabId: string): Terminal | undefined {
  return instances.get(tabId)
}

export function unregisterTerminalInstance(tabId: string, term?: Terminal): void {
  if (term && instances.get(tabId) !== term) return
  instances.delete(tabId)
}

function resolveTerminal(tabId?: string): Terminal | undefined {
  if (tabId) return instances.get(tabId)
  // Prefer the focused/running panel when no tab id is given.
  const running = document.querySelector<HTMLElement>(
    '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
  )
  const fromDom = running?.dataset.yaadeTerminalTabId
  if (fromDom && instances.has(fromDom)) return instances.get(fromDom)
  const last = [...instances.values()]
  return last[last.length - 1]
}

/**
 * Buffer-backed terminal text for E2E / agent bridge.
 * WebGL renderer does not keep readable `.xterm-rows` DOM text.
 */
export function readTerminalBufferText(tabId?: string): string {
  const term = resolveTerminal(tabId)
  if (!term) return ""
  const buf = term.buffer.active
  // Tail the buffer — markers in benches/E2E land near the bottom.
  const keep = Math.max(term.rows * 8, 200)
  const start = Math.max(0, buf.length - keep)
  const lines: string[] = []
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i)
    if (line) lines.push(line.translateToString(true))
  }
  return lines.join("\n")
}

export function readTerminalDims(
  tabId?: string,
): { cols: number; rows: number } | null {
  const term = resolveTerminal(tabId)
  if (!term) return null
  return { cols: term.cols, rows: term.rows }
}

/** Buffer viewportY (scroll position in lines) for E2E — xterm v6 scroll owner. */
export function readTerminalViewportY(tabId?: string): number | null {
  const term = resolveTerminal(tabId)
  if (!term) return null
  return term.buffer.active.viewportY
}

/** Scroll the active terminal by N lines (E2E / agent). */
export function scrollTerminalLines(amount: number, tabId?: string): boolean {
  const term = resolveTerminal(tabId)
  if (!term || !Number.isFinite(amount) || amount === 0) return false
  term.scrollLines(amount)
  return true
}

/** Focus the active terminal via xterm.focus() (E2E). */
export function focusRegisteredTerminal(tabId?: string): boolean {
  const term = resolveTerminal(tabId)
  if (!term) return false
  term.focus()
  return true
}

export function readTerminalCursor(
  tabId?: string,
): { x: number; y: number; hidden: boolean } | null {
  const term = resolveTerminal(tabId)
  if (!term) return null
  const buf = term.buffer.active
  const core = (
    term as Terminal & {
      _core?: { _coreService?: { isCursorHidden?: boolean }; coreService?: { isCursorHidden?: boolean } }
    }
  )._core
  const hidden =
    core?._coreService?.isCursorHidden === true ||
    core?.coreService?.isCursorHidden === true
  return {
    x: buf.cursorX,
    y: buf.cursorY,
    hidden,
  }
}

/** Locate visible needle for E2E click/hover (viewport-relative row). */
export function findTerminalBufferMatch(
  needle: string,
  tabId?: string,
): {
  col: number
  viewportRow: number
  cols: number
  rows: number
} | null {
  const term = resolveTerminal(tabId)
  if (!term || !needle) return null
  const buf = term.buffer.active
  const viewportY = buf.viewportY
  for (let i = buf.length - 1; i >= 0; i--) {
    const line = buf.getLine(i)?.translateToString(true) ?? ""
    const col = line.indexOf(needle)
    if (col < 0) continue
    const viewportRow = i - viewportY
    if (viewportRow < 0 || viewportRow >= term.rows) continue
    return { col, viewportRow, cols: term.cols, rows: term.rows }
  }
  return null
}

/** Cell width/height in CSS px from the active renderer (E2E hit-testing). */
export function readTerminalCellSize(
  tabId?: string,
): { width: number; height: number } | null {
  const term = resolveTerminal(tabId)
  if (!term) return null
  const cell = (
    term as Terminal & {
      _core?: {
        _renderService?: {
          dimensions?: { css?: { cell?: { width?: number; height?: number } } }
        }
      }
    }
  )._core?._renderService?.dimensions?.css?.cell
  const width = cell?.width ?? 0
  const height = cell?.height ?? 0
  if (width < 1 || height < 4) return null
  return { width, height }
}

/** Cell height in CSS px from the active renderer, or 0 when unavailable. */
export function readTerminalCellHeight(tabId?: string): number {
  return readTerminalCellSize(tabId)?.height ?? 0
}
