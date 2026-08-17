import {
  NeovimProtocolError,
  forEachRedrawEvent,
  optionalNumber,
  tupleArray,
  tupleBoolean,
  tupleNumber,
  tupleString,
  type RedrawEvent,
} from "./protocol.js"

export const CELL_CONTINUATION = 1
export const CELL_WIDE = 2
export const CELL_UNDERLINE = 4
export const CELL_UNDERCURL = 8
export const CELL_UNDERDOUBLE = 16
export const CELL_UNDERDOTTED = 32
export const CELL_UNDERDASHED = 64
export const CELL_STRIKETHROUGH = 128

/** Bounds are deliberately dimensions + bytes, not a permissive cell count. */
export const MAX_GRID_WIDTH = 4_096
export const MAX_GRID_HEIGHT = 2_048
export const GRID_CELL_MODEL_BYTES = 4 + 4 + 1
export const GRID_CELL_PACKET_BYTES = 32
export const MAX_GRID_CPU_BYTES = 8 * 1024 * 1024
export const MAX_GLYPHS = 65_536
export const MAX_HIGHLIGHTS = 8_192
export const MAX_CURSOR_MODES = 256
export const MAX_TITLE_LENGTH = 4_096
export const MAX_MODE_LENGTH = 256

export type CursorShape = "block" | "vertical" | "horizontal"

export type CursorModeInfo = {
  readonly shape: CursorShape
  readonly cellPercentage: number
  readonly blinkWaitMs: number
  readonly blinkOnMs: number
  readonly blinkOffMs: number
}

export type HighlightAttributes = {
  readonly foreground?: number
  readonly background?: number
  readonly special?: number
  readonly reverse?: boolean
  readonly italic?: boolean
  readonly bold?: boolean
  readonly underline?: boolean
  readonly undercurl?: boolean
  readonly underdouble?: boolean
  readonly underdotted?: boolean
  readonly underdashed?: boolean
  readonly strikethrough?: boolean
  readonly blend?: number
  readonly groupName?: string
}

/** A render-time view. The typed arrays are model-owned and never copied. */
export type GridFrame = {
  readonly frameId: number
  readonly width: number
  readonly height: number
  readonly glyphIds: Uint32Array
  readonly highlightIds: Uint32Array
  readonly cellFlags: Uint8Array
  readonly dirtyRows: Uint8Array
  readonly cursorX: number
  readonly cursorY: number
  readonly cursorVisible: boolean
  readonly cursorMode: CursorModeInfo
  readonly visualBell: number
}

export type RedrawApplyResult = {
  readonly flushes: number
  readonly frameId: number
  readonly visualBell: number
  readonly visualBellChanged: boolean
  readonly stateChanged: boolean
}

export type LineGridDiagnostics = {
  readonly frames: number
  readonly redrawEvents: number
  readonly unknownEvents: number
  readonly malformedEvents: number
  readonly rejectedBounds: number
  readonly cellsWritten: number
  readonly scrolls: number
  readonly internedGlyphs: number
  readonly peakGlyphs: number
  readonly glyphCompactions: number
  readonly highlights: number
  readonly peakHighlights: number
  readonly modelBytes: number
  readonly cpuBytes: number
}

export type LineGridState = {
  readonly width: number
  readonly height: number
  readonly title: string
  readonly icon: string
  readonly mode: string
  readonly modeIndex: number
  readonly mouseEnabled: boolean
  readonly busy: boolean
  readonly defaultForeground?: number
  readonly defaultBackground?: number
  readonly defaultSpecial?: number
  readonly cursorX: number
  readonly cursorY: number
  readonly cursorVisible: boolean
  readonly cursorMode: CursorModeInfo
  readonly styleGeneration: number
}

const DEFAULT_CURSOR_MODE: CursorModeInfo = {
  shape: "block",
  cellPercentage: 100,
  blinkWaitMs: 0,
  blinkOnMs: 0,
  blinkOffMs: 0,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function numberProperty(value: Record<string, unknown>, key: string): number | undefined {
  const next = value[key]
  return typeof next === "number" && Number.isSafeInteger(next) ? next : undefined
}

function booleanProperty(value: Record<string, unknown>, key: string): boolean | undefined {
  const next = value[key]
  return typeof next === "boolean" ? next : undefined
}

function groupName(value: unknown): string | undefined {
  const items = Array.isArray(value) ? value : [value]
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (!isRecord(item)) continue
    for (const key of ["hi_name", "ui_name", "name"]) {
      const name = item[key]
      if (typeof name === "string" && name.length > 0) return name.slice(0, MAX_MODE_LENGTH)
    }
  }
  return undefined
}

function readHighlight(value: unknown, info: unknown): HighlightAttributes {
  if (!isRecord(value)) throw new NeovimProtocolError("hl_attr_define attributes must be a map")
  const readColor = (key: string): number | undefined => {
    const next = numberProperty(value, key)
    if (next === undefined) return undefined
    if (next < 0 || next > 0xffffff) throw new NeovimProtocolError(`hl_attr_define ${key} is outside RGB range`)
    return next
  }
  const blend = numberProperty(value, "blend")
  if (blend !== undefined && (blend < 0 || blend > 100)) {
    throw new NeovimProtocolError("hl_attr_define blend is outside 0..100")
  }
  return {
    foreground: readColor("foreground"),
    background: readColor("background"),
    special: readColor("special"),
    reverse: booleanProperty(value, "reverse"),
    italic: booleanProperty(value, "italic"),
    bold: booleanProperty(value, "bold"),
    underline: booleanProperty(value, "underline"),
    undercurl: booleanProperty(value, "undercurl"),
    underdouble: booleanProperty(value, "underdouble"),
    underdotted: booleanProperty(value, "underdotted"),
    underdashed: booleanProperty(value, "underdashed"),
    strikethrough: booleanProperty(value, "strikethrough"),
    blend,
    groupName: groupName(info),
  }
}

function cursorShape(value: unknown): CursorShape {
  if (value === "vertical" || value === "horizontal" || value === "block") return value
  return "block"
}

function nonNegative(value: number | undefined): number {
  return value !== undefined && value >= 0 ? value : 0
}

function readCursorMode(value: unknown): CursorModeInfo {
  if (!isRecord(value)) throw new NeovimProtocolError("mode_info_set entries must be maps")
  const shape = cursorShape(value.cursor_shape)
  const percentage = numberProperty(value, "cell_percentage")
  const defaultPercentage = shape === "block" ? 100 : 25
  return {
    shape,
    cellPercentage: Math.max(1, Math.min(100, percentage ?? defaultPercentage)),
    blinkWaitMs: nonNegative(numberProperty(value, "blinkwait")),
    blinkOnMs: nonNegative(numberProperty(value, "blinkon")),
    blinkOffMs: nonNegative(numberProperty(value, "blinkoff")),
  }
}

function assertGrid(grid: number, eventName: string): void {
  if (grid !== 1) throw new NeovimProtocolError(`${eventName} only supports grid 1 in this client`)
}

function assertRange(value: number, minimum: number, maximum: number, message: string): void {
  if (value < minimum || value > maximum) throw new NeovimProtocolError(message)
}

function checkedCellCount(width: number, height: number): number {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_GRID_WIDTH ||
    height > MAX_GRID_HEIGHT
  ) {
    throw new NeovimProtocolError("grid_resize dimensions are outside the supported range")
  }
  const cells = width * height
  if (!Number.isSafeInteger(cells)) {
    throw new NeovimProtocolError("grid_resize cell count overflowed")
  }
  const cpuBytes = cells * (GRID_CELL_MODEL_BYTES + GRID_CELL_PACKET_BYTES) + height
  if (!Number.isSafeInteger(cpuBytes) || cpuBytes > MAX_GRID_CPU_BYTES) {
    throw new NeovimProtocolError("grid_resize exceeds the bounded model and packet budget")
  }
  return cells
}

/** Compact authoritative ext_linegrid model. Mutations become visible at flush. */
export class LineGridModel {
  private width = 1
  private height = 1
  private glyphIds = new Uint32Array(1)
  private highlightIds = new Uint32Array(1)
  private cellFlags = new Uint8Array(1)
  private dirtyRows = new Uint8Array([1])
  private glyphs: string[] = [" "]
  private readonly glyphIdsByText = new Map<string, number>([[" ", 0]])
  private readonly highlights = new Map<number, HighlightAttributes>()
  private cursorModes: readonly CursorModeInfo[] = []
  private cursorStyleEnabled = false
  private frameId = 0
  private fullRepaint = true
  private cursorDirty = true
  private title = ""
  private icon = ""
  private mode = "normal"
  private modeIndex = 0
  private mouseEnabled = false
  private busy = false
  private cursorX = 0
  private cursorY = 0
  private cursorVisible = true
  private defaultForeground: number | undefined
  private defaultBackground: number | undefined
  private defaultSpecial: number | undefined
  private visualBell = 0
  private styleGeneration = 0
  private unknownEvents = 0
  private malformedEvents = 0
  private rejectedBounds = 0
  private redrawEvents = 0
  private cellsWritten = 0
  private scrolls = 0
  private frames = 0
  private peakGlyphs = 1
  private glyphCompactions = 0
  private peakHighlights = 0
  private applyBellBaseline = 0

  state(): LineGridState {
    return {
      width: this.width,
      height: this.height,
      title: this.title,
      icon: this.icon,
      mode: this.mode,
      modeIndex: this.modeIndex,
      mouseEnabled: this.mouseEnabled,
      busy: this.busy,
      ...(this.defaultForeground === undefined ? {} : { defaultForeground: this.defaultForeground }),
      ...(this.defaultBackground === undefined ? {} : { defaultBackground: this.defaultBackground }),
      ...(this.defaultSpecial === undefined ? {} : { defaultSpecial: this.defaultSpecial }),
      cursorX: this.cursorX,
      cursorY: this.cursorY,
      cursorVisible: this.cursorVisible,
      cursorMode: this.currentCursorMode(),
      styleGeneration: this.styleGeneration,
    }
  }

  /** A render-time view. This is the only place a frame descriptor is made. */
  frame(): GridFrame {
    return {
      frameId: this.frameId,
      width: this.width,
      height: this.height,
      glyphIds: this.glyphIds,
      highlightIds: this.highlightIds,
      cellFlags: this.cellFlags,
      dirtyRows: this.dirtyRows,
      cursorX: this.cursorX,
      cursorY: this.cursorY,
      cursorVisible: this.cursorVisible,
      cursorMode: this.currentCursorMode(),
      visualBell: this.visualBell,
    }
  }

  consumeFullRepaint(): boolean {
    const full = this.fullRepaint
    this.fullRepaint = false
    return full
  }

  consumeCursorRepaint(): boolean {
    const dirty = this.cursorDirty
    this.cursorDirty = false
    return dirty
  }

  requestFullRepaint(): void {
    this.fullRepaint = true
    this.markAllDirty()
  }

  requestCursorRepaint(): void {
    this.cursorDirty = true
  }

  /** Iterate dirty row runs without allocating a row array. */
  forEachDirtyRowRun(visit: (startRow: number, endRowExclusive: number) => void): void {
    let row = 0
    while (row < this.height) {
      if (this.dirtyRows[row] !== 1) {
        row += 1
        continue
      }
      const start = row
      row += 1
      while (row < this.height && this.dirtyRows[row] === 1) row += 1
      visit(start, row)
    }
  }

  clearDirtyRows(): void {
    this.dirtyRows.fill(0)
  }

  dirtyRowCount(): number {
    let count = 0
    for (const dirty of this.dirtyRows) if (dirty === 1) count += 1
    return count
  }

  reset(): void {
    this.width = 1
    this.height = 1
    this.glyphIds = new Uint32Array(1)
    this.highlightIds = new Uint32Array(1)
    this.cellFlags = new Uint8Array(1)
    this.dirtyRows = new Uint8Array([1])
    this.highlights.clear()
    this.cursorModes = []
    this.cursorStyleEnabled = false
    this.resetGlyphInterning()
    this.title = ""
    this.icon = ""
    this.mode = "normal"
    this.modeIndex = 0
    this.mouseEnabled = false
    this.busy = false
    this.cursorX = 0
    this.cursorY = 0
    this.cursorVisible = true
    this.defaultForeground = undefined
    this.defaultBackground = undefined
    this.defaultSpecial = undefined
    this.visualBell = 0
    this.styleGeneration += 1
    this.fullRepaint = true
    this.cursorDirty = true
  }

  glyphText(id: number): string {
    return this.glyphs[id] ?? " "
  }

  highlight(id: number): HighlightAttributes | undefined {
    return this.highlights.get(id)
  }

  text(): string {
    const lines: string[] = []
    for (let row = 0; row < this.height; row += 1) {
      let line = ""
      for (let col = 0; col < this.width; col += 1) {
        const index = row * this.width + col
        if ((this.cellFlags[index] ?? 0) & CELL_CONTINUATION) continue
        line += this.glyphText(this.glyphIds[index] ?? 0)
      }
      lines.push(line.replace(/\s+$/u, ""))
    }
    return lines.join("\n")
  }

  diagnostics(): LineGridDiagnostics {
    const modelBytes = this.glyphIds.byteLength + this.highlightIds.byteLength + this.cellFlags.byteLength + this.dirtyRows.byteLength
    const cpuBytes = this.width * this.height * (GRID_CELL_MODEL_BYTES + GRID_CELL_PACKET_BYTES) + this.height
    return {
      frames: this.frames,
      redrawEvents: this.redrawEvents,
      unknownEvents: this.unknownEvents,
      malformedEvents: this.malformedEvents,
      rejectedBounds: this.rejectedBounds,
      cellsWritten: this.cellsWritten,
      scrolls: this.scrolls,
      internedGlyphs: this.glyphs.length,
      peakGlyphs: this.peakGlyphs,
      glyphCompactions: this.glyphCompactions,
      highlights: this.highlights.size,
      peakHighlights: this.peakHighlights,
      modelBytes,
      cpuBytes,
    }
  }

  /** Apply a deterministic fixture. Flushes return counters, never frames. */
  apply(events: readonly RedrawEvent[]): RedrawApplyResult {
    this.applyBellBaseline = this.visualBell
    let result: RedrawApplyResult | undefined
    for (const event of events) result = this.applyTuple(event.name, event.args, result)
    return result ?? this.finishApply(0, false, false)
  }

  /** Apply a decoded wire notification without allocating event objects. */
  applyRedraw(args: readonly unknown[]): RedrawApplyResult {
    this.applyBellBaseline = this.visualBell
    let result: RedrawApplyResult | undefined
    forEachRedrawEvent(args, (name, eventArgs) => {
      result = this.applyTuple(name, eventArgs, result)
    })
    return result ?? this.finishApply(0, false, false)
  }

  private applyTuple(
    name: string,
    args: readonly unknown[],
    previous: RedrawApplyResult | undefined,
  ): RedrawApplyResult {
    this.redrawEvents += 1
    try {
      const flushed = this.applyEvent(name, args)
      if (!flushed) {
        return previous ?? this.finishApply(0, true, false)
      }
      return this.finishApply((previous?.flushes ?? 0) + 1, true, true)
    } catch (error) {
      this.malformedEvents += 1
      if (error instanceof NeovimProtocolError) {
        if (/outside the supported range|budget|overflow|exceeds/u.test(error.message)) this.rejectedBounds += 1
        throw error
      }
      throw new NeovimProtocolError(`${name} is malformed`)
    }
  }

  private finishApply(flushes: number, stateChanged: boolean, _flushed: boolean): RedrawApplyResult {
    return {
      flushes,
      frameId: this.frameId,
      visualBell: this.visualBell,
      visualBellChanged: this.visualBell !== this.applyBellBaseline,
      stateChanged,
    }
  }

  private applyEvent(name: string, args: readonly unknown[]): boolean {
    switch (name) {
      case "set_title":
        this.title = tupleString(name, args, 0).slice(0, MAX_TITLE_LENGTH)
        return false
      case "set_icon":
        this.icon = tupleString(name, args, 0).slice(0, MAX_TITLE_LENGTH)
        return false
      case "mode_info_set": {
        this.cursorStyleEnabled = tupleBoolean(name, args, 0)
        const rawModes = tupleArray(name, args, 1)
        if (rawModes.length > MAX_CURSOR_MODES) throw new NeovimProtocolError("mode_info_set has too many cursor modes")
        const modes: CursorModeInfo[] = []
        for (const rawMode of rawModes) modes.push(readCursorMode(rawMode))
        this.cursorModes = modes
        this.markCursorDirty()
        return false
      }
      case "mode_change":
        this.mode = tupleString(name, args, 0).slice(0, MAX_MODE_LENGTH)
        this.modeIndex = tupleNumber(name, args, 1)
        if (this.modeIndex < 0 || this.modeIndex >= MAX_CURSOR_MODES) throw new NeovimProtocolError("mode_change index is outside the supported range")
        this.markCursorDirty()
        return false
      case "mouse_on":
        this.mouseEnabled = true
        return false
      case "mouse_off":
        this.mouseEnabled = false
        return false
      case "busy_start":
        this.busy = true
        this.cursorVisible = false
        this.markCursorDirty()
        return false
      case "busy_stop":
        this.busy = false
        this.cursorVisible = true
        this.markCursorDirty()
        return false
      case "bell":
      case "visual_bell":
        this.visualBell += 1
        return false
      case "flush":
        this.frameId += 1
        this.frames += 1
        this.compactGlyphsIfNeeded()
        return true
      case "default_colors_set":
        this.defaultForeground = this.rgbTuple(name, args, 0)
        this.defaultBackground = this.rgbTuple(name, args, 1)
        this.defaultSpecial = this.rgbTuple(name, args, 2)
        this.styleGeneration += 1
        this.markAllDirty()
        return false
      case "hl_attr_define": {
        const id = tupleNumber(name, args, 0)
        if (id < 0 || id > MAX_HIGHLIGHTS) throw new NeovimProtocolError("hl_attr_define id is outside the supported range")
        if (this.highlights.size >= MAX_HIGHLIGHTS && !this.highlights.has(id)) {
          throw new NeovimProtocolError("hl_attr_define exceeds the bounded highlight table")
        }
        this.highlights.set(id, readHighlight(args[1], args[3]))
        this.peakHighlights = Math.max(this.peakHighlights, this.highlights.size)
        this.styleGeneration += 1
        this.markAllDirty()
        return false
      }
      case "option_set":
        tupleString(name, args, 0).slice(0, MAX_MODE_LENGTH)
        if (args.length < 2) throw new NeovimProtocolError("option_set requires a value")
        return false
      case "grid_resize":
        this.resize(tupleNumber(name, args, 0), tupleNumber(name, args, 1), tupleNumber(name, args, 2))
        return false
      case "grid_clear":
        this.clear(tupleNumber(name, args, 0))
        return false
      case "grid_destroy":
        this.clear(tupleNumber(name, args, 0))
        return false
      case "grid_cursor_goto":
        this.cursorGoto(tupleNumber(name, args, 0), tupleNumber(name, args, 1), tupleNumber(name, args, 2))
        return false
      case "grid_line":
        this.gridLine(args)
        return false
      case "grid_scroll":
        this.gridScroll(args)
        return false
      default:
        this.unknownEvents += 1
        return false
    }
  }

  private currentCursorMode(): CursorModeInfo {
    if (!this.cursorStyleEnabled) return DEFAULT_CURSOR_MODE
    return this.cursorModes[this.modeIndex] ?? DEFAULT_CURSOR_MODE
  }

  private rgbTuple(eventName: string, args: readonly unknown[], index: number): number {
    const value = tupleNumber(eventName, args, index)
    if (value < 0 || value > 0xffffff) throw new NeovimProtocolError(`${eventName} color is outside RGB range`)
    return value
  }

  private resize(grid: number, width: number, height: number): void {
    assertGrid(grid, "grid_resize")
    const length = checkedCellCount(width, height)
    this.width = width
    this.height = height
    this.glyphIds = new Uint32Array(length)
    this.highlightIds = new Uint32Array(length)
    this.cellFlags = new Uint8Array(length)
    this.dirtyRows = new Uint8Array(height)
    this.resetGlyphInterning()
    this.fullRepaint = true
    this.cursorDirty = true
    this.markAllDirty()
    this.cursorX = Math.min(this.cursorX, width - 1)
    this.cursorY = Math.min(this.cursorY, height - 1)
  }

  private clear(grid: number): void {
    assertGrid(grid, "grid_clear")
    this.glyphIds.fill(0)
    this.highlightIds.fill(0)
    this.cellFlags.fill(0)
    this.resetGlyphInterning()
    this.markAllDirty()
  }

  private cursorGoto(grid: number, row: number, col: number): void {
    assertGrid(grid, "grid_cursor_goto")
    assertRange(row, 0, this.height - 1, "grid_cursor_goto row is outside the grid")
    assertRange(col, 0, this.width - 1, "grid_cursor_goto column is outside the grid")
    this.markCursorDirty()
    this.cursorY = row
    this.cursorX = col
    this.markCursorDirty()
  }

  private gridLine(args: readonly unknown[]): void {
    const grid = tupleNumber("grid_line", args, 0)
    assertGrid(grid, "grid_line")
    const row = tupleNumber("grid_line", args, 1)
    const startColumn = tupleNumber("grid_line", args, 2)
    assertRange(row, 0, this.height - 1, "grid_line row is outside the grid")
    assertRange(startColumn, 0, this.width, "grid_line column is outside the grid")
    const cells = tupleArray("grid_line", args, 3)
    if (args.length >= 5) tupleBoolean("grid_line", args, 4)
    if (cells.length > MAX_GRID_WIDTH * 2) throw new NeovimProtocolError("grid_line contains too many cells")
    let column = startColumn
    let currentHighlight = 0
    for (const rawCell of cells) {
      if (!Array.isArray(rawCell) || typeof rawCell[0] !== "string" || rawCell.length > 3) {
        throw new NeovimProtocolError("grid_line contains a malformed cell")
      }
      const text = rawCell[0]
      if (text.length > 4_096) throw new NeovimProtocolError("grid_line glyph cluster is too long")
      const highlight = optionalNumber(rawCell[1])
      if (rawCell.length >= 2 && rawCell[1] !== undefined && (highlight === undefined || highlight < 0 || highlight > MAX_HIGHLIGHTS)) {
        throw new NeovimProtocolError("grid_line highlight id is outside the supported range")
      }
      if (highlight !== undefined) currentHighlight = highlight
      const repeat = rawCell.length >= 3 && rawCell[2] !== undefined ? optionalNumber(rawCell[2]) : 1
      if (repeat === undefined || repeat < 0 || repeat > MAX_GRID_WIDTH) throw new NeovimProtocolError("grid_line repeat is outside the supported range")
      for (let count = 0; count < repeat && column < this.width; count += 1) {
        if (text.length === 0) this.writeContinuation(row, column, currentHighlight)
        else this.writeCell(row, column, text, currentHighlight)
        column += 1
      }
    }
  }

  private writeCell(row: number, column: number, text: string, highlight: number): void {
    const index = row * this.width + column
    this.glyphIds[index] = this.internGlyph(text)
    this.highlightIds[index] = highlight
    this.cellFlags[index] = this.flagsForHighlight(highlight)
    this.dirtyRows[row] = 1
    this.cellsWritten += 1
  }

  private writeContinuation(row: number, column: number, highlight: number): void {
    const index = row * this.width + column
    this.glyphIds[index] = 0
    this.highlightIds[index] = highlight
    this.cellFlags[index] = CELL_CONTINUATION
    if (column > 0) {
      const previous = index - 1
      if ((this.cellFlags[previous] ?? 0) !== CELL_CONTINUATION) this.cellFlags[previous] = (this.cellFlags[previous] ?? 0) | CELL_WIDE
    }
    this.dirtyRows[row] = 1
    this.cellsWritten += 1
  }

  private flagsForHighlight(highlight: number): number {
    const attributes = this.highlights.get(highlight)
    if (!attributes) return 0
    let flags = 0
    if (attributes.underline) flags |= CELL_UNDERLINE
    if (attributes.undercurl) flags |= CELL_UNDERCURL
    if (attributes.underdouble) flags |= CELL_UNDERDOUBLE
    if (attributes.underdotted) flags |= CELL_UNDERDOTTED
    if (attributes.underdashed) flags |= CELL_UNDERDASHED
    if (attributes.strikethrough) flags |= CELL_STRIKETHROUGH
    return flags
  }

  private gridScroll(args: readonly unknown[]): void {
    const grid = tupleNumber("grid_scroll", args, 0)
    assertGrid(grid, "grid_scroll")
    const top = tupleNumber("grid_scroll", args, 1)
    const bottom = tupleNumber("grid_scroll", args, 2)
    const left = tupleNumber("grid_scroll", args, 3)
    const right = tupleNumber("grid_scroll", args, 4)
    const rows = tupleNumber("grid_scroll", args, 5)
    const columns = args.length > 6 ? tupleNumber("grid_scroll", args, 6) : 0
    assertRange(top, 0, this.height, "grid_scroll top is outside the grid")
    assertRange(bottom, top, this.height, "grid_scroll bottom is outside the grid")
    assertRange(left, 0, this.width, "grid_scroll left is outside the grid")
    assertRange(right, left, this.width, "grid_scroll right is outside the grid")
    if (columns !== 0) throw new NeovimProtocolError("grid_scroll column movement is unsupported with ext_multigrid disabled")
    if (rows < -MAX_GRID_HEIGHT || rows > MAX_GRID_HEIGHT) throw new NeovimProtocolError("grid_scroll row movement is outside the supported range")
    if (rows === 0) return
    const distance = Math.min(Math.abs(rows), bottom - top)
    if (rows > 0) {
      for (let row = top; row < bottom - distance; row += 1) this.copyColumns(row + distance, row, left, right)
      for (let row = bottom - distance; row < bottom; row += 1) this.clearColumns(row, left, right)
    } else {
      for (let row = bottom - 1; row >= top + distance; row -= 1) this.copyColumns(row - distance, row, left, right)
      for (let row = top; row < top + distance; row += 1) this.clearColumns(row, left, right)
    }
    for (let row = top; row < bottom; row += 1) this.dirtyRows[row] = 1
    this.scrolls += 1
  }

  private copyColumns(sourceRow: number, targetRow: number, left: number, right: number): void {
    const source = sourceRow * this.width + left
    const target = targetRow * this.width + left
    this.glyphIds.copyWithin(target, source, source + right - left)
    this.highlightIds.copyWithin(target, source, source + right - left)
    this.cellFlags.copyWithin(target, source, source + right - left)
  }

  private clearColumns(row: number, left: number, right: number): void {
    const start = row * this.width + left
    this.glyphIds.fill(0, start, row * this.width + right)
    this.highlightIds.fill(0, start, row * this.width + right)
    this.cellFlags.fill(0, start, row * this.width + right)
  }

  private internGlyph(text: string): number {
    const existing = this.glyphIdsByText.get(text)
    if (existing !== undefined) return existing
    if (this.glyphs.length >= MAX_GLYPHS) {
      throw new NeovimProtocolError("grid glyph table exceeds the bounded interning limit")
    }
    const id = this.glyphs.length
    this.glyphs.push(text)
    this.glyphIdsByText.set(text, id)
    this.peakGlyphs = Math.max(this.peakGlyphs, this.glyphs.length)
    return id
  }

  private compactGlyphsIfNeeded(): void {
    const softLimit = 128
    if (this.glyphs.length <= softLimit) return
    const live = new Uint8Array(this.glyphs.length)
    live[0] = 1
    for (const id of this.glyphIds) if (id < live.length) live[id] = 1
    let liveCount = 0
    for (const value of live) liveCount += value
    if (this.glyphs.length <= Math.max(softLimit, liveCount * 2)) return
    const remap = new Uint32Array(this.glyphs.length)
    const nextGlyphs: string[] = [" "]
    const nextMap = new Map<string, number>([[" ", 0]])
    for (let oldId = 1; oldId < live.length; oldId += 1) {
      if (live[oldId] !== 1) continue
      const text = this.glyphs[oldId]
      if (text === undefined) continue
      const nextId = nextGlyphs.length
      remap[oldId] = nextId
      nextGlyphs.push(text)
      nextMap.set(text, nextId)
    }
    for (let index = 0; index < this.glyphIds.length; index += 1) {
      this.glyphIds[index] = remap[this.glyphIds[index] ?? 0] ?? 0
    }
    this.glyphs = nextGlyphs
    this.glyphIdsByText.clear()
    for (const [text, id] of nextMap) this.glyphIdsByText.set(text, id)
    this.glyphCompactions += 1
  }

  private resetGlyphInterning(): void {
    this.glyphs = [" "]
    this.glyphIdsByText.clear()
    this.glyphIdsByText.set(" ", 0)
  }

  private markCursorDirty(): void {
    this.cursorDirty = true
  }

  private markAllDirty(): void {
    this.dirtyRows.fill(1)
  }
}
