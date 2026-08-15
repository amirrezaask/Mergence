/** Shell-escape a filesystem path for paste into a PTY (iTerm2 / Terminal.app style). */
export function quoteShellPath(path: string, windows = isWindowsPlatform()): string {
  if (windows) {
    return `"${path.replace(/"/g, '""')}"`
  }
  return `'${path.replace(/'/g, `'\\''`)}'`
}

/** Space-separated quoted paths with a trailing space so the next arg is ready. */
export function formatDroppedPaths(paths: string[], windows = isWindowsPlatform()): string {
  if (paths.length === 0) return ""
  return `${paths.map(p => quoteShellPath(p, windows)).join(" ")} `
}

export function isWindowsPlatform(): boolean {
  if (typeof navigator === "undefined") return false
  const platform = navigator.platform || ""
  if (/Win/i.test(platform)) return true
  return /Windows/i.test(navigator.userAgent || "")
}

export function findTerminalPanelAtPoint(clientX: number, clientY: number): HTMLElement | null {
  const hit = document.elementFromPoint(clientX, clientY)
  if (!hit) return null
  const panel = hit.closest<HTMLElement>("[data-yaade-terminal-panel]")
  if (!panel) return null
  const status = panel.getAttribute("data-yaade-terminal-status")
  if (status === "exited" || status === "failed") return null
  const ptyId = panel.getAttribute("data-yaade-terminal-pty-id")
  if (!ptyId) return null
  return panel
}

export async function insertDroppedPathsIntoTerminal(
  panel: HTMLElement,
  paths: string[],
): Promise<boolean> {
  const ptyId = panel.getAttribute("data-yaade-terminal-pty-id")
  const terminal = window.yaade?.terminal
  if (!ptyId || !terminal) return false
  const text = formatDroppedPaths(paths)
  if (!text) return false
  await terminal.write(ptyId, text)
  panel.querySelector<HTMLTextAreaElement>("[data-yaade-terminal-input]")?.focus()
  return true
}

/** Hit-test client coords → write shell-quoted paths into that terminal's PTY. */
export async function handleTerminalFileDropAt(
  paths: string[],
  clientX: number,
  clientY: number,
): Promise<boolean> {
  if (paths.length === 0) return false
  const panel = findTerminalPanelAtPoint(clientX, clientY)
  if (!panel) return false
  return insertDroppedPathsIntoTerminal(panel, paths)
}
