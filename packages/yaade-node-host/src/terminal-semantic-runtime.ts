import {
  GhosttyTerminalCore,
  type GhosttyCell,
  type GhosttyColor,
  type GhosttyMouseInput,
  type GhosttySnapshot,
  type GhosttyTheme,
} from "@yaade/ghostty-core"
import { nodeGhosttyWasmSource } from "@yaade/ghostty-core/loaders/node"
import type {
  TerminalCell,
  TerminalColor,
  TerminalHyperlink,
  TerminalModes,
  TerminalSemanticPatch,
  TerminalSemanticSnapshot,
} from "@yaade/rpc"
import { PtyWriteQueue } from "./pty-write-queue.js"

const DEFAULT_THEME: GhosttyTheme = {
  foreground: { r: 229, g: 231, b: 235 },
  background: { r: 0, g: 0, b: 0 },
  cursor: { r: 229, g: 231, b: 235 },
}

const DIAGNOSTIC_TRANSCRIPT_BYTES = 256 * 1024
const CELL_WIDTH = 8
const CELL_HEIGHT = 16
const REVISION_NOTIFY_DELAY_MS = 16

function color(value: GhosttyColor): TerminalColor {
  return { r: value.r, g: value.g, b: value.b }
}

function cell(value: GhosttyCell): TerminalCell {
  return {
    text: value.text,
    wide: value.wide,
    foreground: color(value.foreground),
    background: color(value.background),
    bold: value.bold,
    faint: false,
    italic: value.italic,
    blink: false,
    inverse: false,
    invisible: value.invisible,
    strikethrough: value.strikethrough,
    overline: value.overline,
    underline: value.underline,
  }
}

export type SemanticHistoryPage = {
  readonly firstRowId: string | null
  readonly lastRowId: string | null
  readonly rows: TerminalSemanticSnapshot["screenRows"]
  readonly offset: number
  readonly total: number
}

export type TerminalSemanticRuntimeOptions = {
  readonly cols: number
  readonly rows: number
  readonly terminalEpoch: string
  readonly writeToPty: (data: string) => void
  readonly onRevision: (revision: number) => void
}

/**
 * Ghostty-backed terminal model for a current-generation PTY. Parser state,
 * query responses, and semantic snapshots live here; raw replay stays in the
 * terminal entry as a diagnostic transcript only.
 */
export class TerminalSemanticRuntime {
  private readonly queue: PtyWriteQueue
  private core: GhosttyTerminalCore | null = null
  private outputSequence = 0
  private revision = 0
  private diagnostic: string[] = []
  private diagnosticBytes = 0
  private starting: Promise<void> | null = null
  private pendingOutput: string[] = []
  private notifyTimer: ReturnType<typeof setTimeout> | null = null
  private notifiedRevision = 0
  private disposed = false
  private lastUpdateSnapshot: TerminalSemanticSnapshot | null = null
  private cols: number
  private rows: number

  private constructor(
    private readonly options: TerminalSemanticRuntimeOptions,
  ) {
    this.cols = options.cols
    this.rows = options.rows
    this.queue = new PtyWriteQueue(options.writeToPty)
  }

  static start(options: TerminalSemanticRuntimeOptions): TerminalSemanticRuntime {
    const runtime = new TerminalSemanticRuntime(options)
    runtime.starting = runtime.boot()
    return runtime
  }

  get currentRevision(): number {
    return this.revision
  }

  get currentOutputSequence(): number {
    return this.outputSequence
  }

  enqueueUserInput(data: string): void {
    this.queue.enqueue(data)
  }

  feedOutput(data: string): void {
    if (this.disposed || data.length === 0) return
    this.outputSequence += 1
    this.appendDiagnostic(data)
    if (!this.core) {
      this.pendingOutput.push(data)
      return
    }
    this.core.write(data)
    this.bumpRevision()
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.core?.resize(cols, rows, CELL_WIDTH, CELL_HEIGHT)
    this.bumpRevision()
  }

  encodePaste(data: string): string {
    return this.core?.encodePaste(data) ?? data
  }

  encodeMouse(input: GhosttyMouseInput): string {
    return this.core?.encodeMouse(input) ?? ""
  }

  snapshot(): TerminalSemanticSnapshot | null {
    if (!this.core) return null
    // Attaches and RPC reads must not consume the dirty-row set used by the
    // realtime patch stream.
    return this.fromGhostty(this.core.snapshot(false))
  }

  takeUpdate(): TerminalSemanticSnapshot | TerminalSemanticPatch | null {
    if (!this.core) return null
    const ghostty = this.core.snapshot(true)
    const next = this.fromGhostty(ghostty)
    const previous = this.lastUpdateSnapshot
    this.lastUpdateSnapshot = next
    if (!previous) return next

    const fullReset =
      previous.cols !== next.cols ||
      previous.rows !== next.rows ||
      previous.activeScreen !== next.activeScreen
    const changedRows = fullReset
      ? next.screenRows
      : [...ghostty.dirtyRows].flatMap(index => {
          const row = next.screenRows[index]
          return row ? [row] : []
        })
    const deletedRowIds = previous.screenRows
      .slice(next.screenRows.length)
      .map(row => row.rowId)
    return {
      schemaVersion: 1,
      terminalEpoch: this.options.terminalEpoch,
      baseRevision: previous.revision,
      revision: next.revision,
      changedRows,
      deletedRowIds,
      cursor: next.cursor,
      cols: next.cols,
      rows: next.rows,
      activeScreen: next.activeScreen,
      scrollback: next.scrollback,
      modes: next.modes,
      title: next.title,
      palette: next.palette,
      hyperlinks: next.hyperlinks,
      ...(fullReset ? { fullReset: true } : {}),
    }
  }

  historyPage(offset: number, limit: number): SemanticHistoryPage {
    const core = this.core
    if (!core) {
      return { firstRowId: null, lastRowId: null, rows: [], offset: 0, total: 0 }
    }
    const bar = core.scrollbarState()
    const total = bar?.total ?? this.rows
    const pageLimit = Math.max(1, Math.min(this.rows, Math.trunc(limit)))
    const pageOffset = Math.max(0, Math.min(Math.max(0, total - pageLimit), Math.trunc(offset)))
    const previous = bar?.offset ?? 0
    const delta = pageOffset - previous
    if (delta !== 0) core.scroll(delta)
    const snap = core.snapshot(false)
    if (delta !== 0) core.scroll(-delta)
    const rows = snap.rowData.slice(0, pageLimit).map((row, index) => ({
      rowId: `history-${pageOffset + index}`,
      cells: row.cells.map(value => cell(value)),
      isWrapContinuation: row.isWrapContinuation,
      wrapsToNext: row.wrapsToNext,
    }))
    return {
      firstRowId: rows[0]?.rowId ?? null,
      lastRowId: rows.at(-1)?.rowId ?? null,
      rows,
      offset: pageOffset,
      total,
    }
  }

  diagnosticTranscript(): string {
    return this.diagnostic.join("")
  }

  ready(): Promise<void> {
    return this.starting ?? Promise.resolve()
  }

  dispose(): void {
    this.disposed = true
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    this.notifyTimer = null
    this.pendingOutput.length = 0
    this.queue.dispose()
    this.core?.dispose()
    this.core = null
  }

  private async boot(): Promise<void> {
    const source = await nodeGhosttyWasmSource()
    if (this.disposed) return
    const core = await GhosttyTerminalCore.create(
      this.cols,
      this.rows,
      CELL_WIDTH,
      CELL_HEIGHT,
      DEFAULT_THEME,
      data => {
        if (this.disposed) return
        try {
          this.queue.enqueue(data)
        } catch {
          /* Queue overflow is surfaced on the next user write. */
        }
      },
      source,
      "authoritative",
    )
    if (this.disposed) {
      core.dispose()
      return
    }
    this.core = core
    for (const chunk of this.pendingOutput) core.write(chunk)
    this.pendingOutput = []
    this.bumpRevision()
  }

  private bumpRevision(): void {
    this.revision += 1
    if (this.notifyTimer || this.disposed) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      if (this.disposed || !this.core || this.revision === this.notifiedRevision) return
      this.notifiedRevision = this.revision
      this.options.onRevision(this.revision)
    }, REVISION_NOTIFY_DELAY_MS)
    this.notifyTimer.unref?.()
  }

  private appendDiagnostic(data: string): void {
    const size = Buffer.byteLength(data, "utf8")
    this.diagnostic.push(data)
    this.diagnosticBytes += size
    while (this.diagnosticBytes > DIAGNOSTIC_TRANSCRIPT_BYTES && this.diagnostic.length > 1) {
      const removed = this.diagnostic.shift()
      if (removed === undefined) break
      this.diagnosticBytes -= Buffer.byteLength(removed, "utf8")
    }
  }

  private fromGhostty(snap: GhosttySnapshot): TerminalSemanticSnapshot {
    const core = this.core
    const screenRows = snap.rowData.map((row, index) => ({
      rowId: `screen-${index}`,
      cells: row.cells.map(value => cell(value)),
      isWrapContinuation: row.isWrapContinuation,
      wrapsToNext: row.wrapsToNext,
    }))
    const bar = core?.scrollbarState()
    const hyperlinks = this.collectHyperlinks(snap)
    return {
      schemaVersion: 1,
      cols: snap.cols,
      rows: snap.rows,
      activeScreen: core?.isAlternateScreen() ? "alternate" : "primary",
      revision: this.revision,
      cursor: {
        x: Math.max(0, snap.cursorX),
        y: Math.max(0, snap.cursorY),
        visible: snap.cursorVisible,
        blinking: snap.cursorBlinking,
        style: snap.cursorStyle,
      },
      screenRows,
      scrollback: {
        firstRowId: bar && bar.total > 0 ? "history-0" : null,
        lastRowId: bar && bar.total > 0 ? `history-${Math.max(0, bar.total - 1)}` : null,
        rowCount: bar?.total ?? 0,
      },
      modes: this.modes(),
      title: core?.title() || null,
      palette: [color(snap.foreground), color(snap.background), color(snap.cursor)],
      hyperlinks,
    }
  }

  private modes(): TerminalModes {
    const core = this.core
    return {
      bracketedPaste: core?.isModeEnabled(2004) ?? false,
      applicationCursorKeys: core?.isApplicationCursorKeys() ?? false,
      focusReporting: core?.isModeEnabled(1004) ?? false,
      mouseTracking: core?.isMouseTracking() ?? false,
      mouseSgr: core?.isModeEnabled(1006) ?? false,
      mouseSgrPixels: core?.isModeEnabled(1016) ?? false,
      synchronizedOutput: core?.isModeEnabled(2026) ?? false,
      kittyKeyboard: core?.isModeEnabled(2017) ?? false,
    }
  }

  private collectHyperlinks(snap: GhosttySnapshot): TerminalHyperlink[] {
    const core = this.core
    if (!core) return []
    const found = new Map<string, string>()
    for (let y = 0; y < snap.rowData.length; y++) {
      const row = snap.rowData[y]
      if (!row) continue
      for (let x = 0; x < row.cells.length; x++) {
        const uri = core.hyperlinkAt(x, y)
        if (uri && !found.has(uri)) found.set(uri, uri)
      }
    }
    return [...found.entries()].map(([id, uri]) => ({ id, uri }))
  }
}
