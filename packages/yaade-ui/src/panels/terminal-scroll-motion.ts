import type { Terminal } from "@xterm/xterm"
import { terminalKeybindingData } from "./terminal-keybindings.js"

/**
 * xterm v6 owns wheel/smooth-scroll via DomScrollableElement + smoothScrollDuration.
 * This adapter only keeps Yaade's macOS readline keybindings and PageUp/PageDown.
 */
export class TerminalScrollMotion {
  constructor(private readonly term: Terminal) {
    term.attachCustomKeyEventHandler(this.onKey)
  }

  /** No-op: scroll position lives in xterm's ScrollableElement, not our controller. */
  sync(): void {}

  private readonly onKey = (event: KeyboardEvent): boolean => {
    const input = terminalKeybindingData(event, navigator.platform)
    if (input !== null) {
      event.preventDefault()
      event.stopPropagation()
      this.term.input(input)
      return false
    }
    if (event.key !== "PageUp" && event.key !== "PageDown") return true
    event.preventDefault()
    this.term.scrollPages(event.key === "PageUp" ? -1 : 1)
    return false
  }

  dispose(): void {
    /* Custom key handler is disposed with the terminal. */
  }
}
