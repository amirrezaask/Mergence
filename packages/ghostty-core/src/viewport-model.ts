import type {
  GhosttyColor,
  GhosttyRow,
  GhosttySnapshot,
} from "./core.js";
import {
  GHOSTTY_RENDER_ROW,
  GHOSTTY_RENDER_STYLE,
  type GhosttyRenderUpdate,
  unpackGhosttyColor,
  validateGhosttyRenderUpdate,
} from "./render-update.js";

type MutableColor = { r: number; g: number; b: number };
type MutableCell = {
  text: string;
  wide: number;
  foreground: MutableColor;
  background: MutableColor;
  bold: boolean;
  italic: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
  underline: number;
  selected: boolean;
};
type MutableRow = {
  cells: MutableCell[];
  text: string;
  isWrapContinuation: boolean;
  wrapsToNext: boolean;
};

const decoder = new TextDecoder();
const EMPTY_DIRTY_ROWS: ReadonlySet<number> = new Set();

function copyColor(target: MutableColor, source: GhosttyColor): void {
  target.r = source.r;
  target.g = source.g;
  target.b = source.b;
}

function createCell(foreground: GhosttyColor, background: GhosttyColor): MutableCell {
  return {
    text: "",
    wide: 0,
    foreground: { ...foreground },
    background: { ...background },
    bold: false,
    italic: false,
    invisible: false,
    strikethrough: false,
    overline: false,
    underline: 0,
    selected: false,
  };
}

function createRow(cols: number, foreground: GhosttyColor, background: GhosttyColor): MutableRow {
  return {
    cells: Array.from({ length: cols }, () => createCell(foreground, background)),
    text: "",
    isWrapContinuation: false,
    wrapsToNext: false,
  };
}

/**
 * Main-thread retained grid. Applying an update copies strings and scalar cell
 * state, so callers may return or transfer the update buffers immediately.
 */
export class GhosttyViewportModel {
  private frameId = 0;
  private generation = 0;
  private colsValue = 0;
  private rowsValue = 0;
  private foregroundValue: GhosttyColor = { r: 229, g: 231, b: 235 };
  private backgroundValue: GhosttyColor = { r: 0, g: 0, b: 0 };
  private cursorValue: GhosttyColor = this.foregroundValue;
  private cursorXValue = -1;
  private cursorYValue = -1;
  private cursorVisibleValue = false;
  private cursorBlinkingValue = false;
  private cursorStyleValue = 0;
  private rowDataValue: MutableRow[] = [];
  private dirtyRowsValue: ReadonlySet<number> = EMPTY_DIRTY_ROWS;

  get cols(): number { return this.colsValue; }
  get rows(): number { return this.rowsValue; }
  get currentFrameId(): number { return this.frameId; }
  get currentGeneration(): number { return this.generation; }
  get rowData(): readonly GhosttyRow[] { return this.rowDataValue; }
  get foreground(): GhosttyColor { return this.foregroundValue; }
  get background(): GhosttyColor { return this.backgroundValue; }
  get cursor(): GhosttyColor { return this.cursorValue; }
  get cursorX(): number { return this.cursorXValue; }
  get cursorY(): number { return this.cursorYValue; }
  get cursorVisible(): boolean { return this.cursorVisibleValue; }
  get cursorBlinking(): boolean { return this.cursorBlinkingValue; }
  get cursorStyle(): number { return this.cursorStyleValue; }
  get dirtyRows(): ReadonlySet<number> { return this.dirtyRowsValue; }

  apply(update: GhosttyRenderUpdate): boolean {
    if (!validateGhosttyRenderUpdate(update)) return false;
    if (update.generation < this.generation) return false;
    if (update.generation === this.generation && update.frameId <= this.frameId) return false;
    if (update.generation > this.generation && !update.full) return false;
    if (
      update.full ||
      update.cols !== this.colsValue ||
      update.rows !== this.rowsValue
    ) {
      if (!update.full) return false;
      const foreground = unpackGhosttyColor(update.foreground);
      const background = unpackGhosttyColor(update.background);
      this.rowDataValue = Array.from(
        { length: update.rows },
        () => createRow(update.cols, foreground, background),
      );
      this.colsValue = update.cols;
      this.rowsValue = update.rows;
    }

    this.frameId = update.frameId;
    this.generation = update.generation;
    this.foregroundValue = unpackGhosttyColor(update.foreground);
    this.backgroundValue = unpackGhosttyColor(update.background);
    this.cursorValue = unpackGhosttyColor(update.cursor);
    this.cursorXValue = update.cursorX;
    this.cursorYValue = update.cursorY;
    this.cursorVisibleValue = update.cursorVisible;
    this.cursorBlinkingValue = update.cursorBlinking;
    this.cursorStyleValue = update.cursorStyle;

    const dirty = new Set<number>();
    for (let includedRow = 0; includedRow < update.dirtyRows.length; includedRow += 1) {
      const rowIndex = update.dirtyRows[includedRow];
      if (rowIndex === undefined) return false;
      const row = this.rowDataValue[rowIndex];
      if (!row) return false;
      const flags = update.rowFlags[includedRow] ?? 0;
      row.isWrapContinuation = (flags & GHOSTTY_RENDER_ROW.wrapContinuation) !== 0;
      row.wrapsToNext = (flags & GHOSTTY_RENDER_ROW.wrapsToNext) !== 0;
      let rowText = "";
      for (let column = 0; column < update.cols; column += 1) {
        const packedIndex = includedRow * update.cols + column;
        const cell = row.cells[column];
        const offset = update.graphemeOffsets[packedIndex];
        const length = update.graphemeLengths[packedIndex];
        const foreground = update.foregrounds[packedIndex];
        const background = update.backgrounds[packedIndex];
        const style = update.styles[packedIndex];
        if (
          !cell || offset === undefined || length === undefined ||
          foreground === undefined || background === undefined || style === undefined
        ) return false;
        cell.text = decoder.decode(update.graphemes.subarray(offset, offset + length));
        cell.wide = style & GHOSTTY_RENDER_STYLE.widthMask;
        copyColor(cell.foreground, unpackGhosttyColor(foreground));
        copyColor(cell.background, unpackGhosttyColor(background));
        cell.bold = (style & GHOSTTY_RENDER_STYLE.bold) !== 0;
        cell.italic = (style & GHOSTTY_RENDER_STYLE.italic) !== 0;
        cell.invisible = (style & GHOSTTY_RENDER_STYLE.invisible) !== 0;
        cell.strikethrough = (style & GHOSTTY_RENDER_STYLE.strikethrough) !== 0;
        cell.overline = (style & GHOSTTY_RENDER_STYLE.overline) !== 0;
        cell.underline =
          (style & GHOSTTY_RENDER_STYLE.underlineMask) >>> GHOSTTY_RENDER_STYLE.underlineShift;
        cell.selected = (style & GHOSTTY_RENDER_STYLE.selected) !== 0;
        rowText += cell.text || " ";
      }
      row.text = rowText.trimEnd();
      dirty.add(rowIndex);
    }
    this.dirtyRowsValue = dirty;
    return true;
  }

  snapshot(): GhosttySnapshot {
    return {
      cols: this.colsValue,
      rows: this.rowsValue,
      foreground: this.foregroundValue,
      background: this.backgroundValue,
      cursor: this.cursorValue,
      cursorX: this.cursorXValue,
      cursorY: this.cursorYValue,
      cursorVisible: this.cursorVisibleValue,
      cursorBlinking: this.cursorBlinkingValue,
      cursorStyle: this.cursorStyleValue,
      dirtyRows: this.dirtyRowsValue,
      rowData: this.rowDataValue,
    };
  }

  bufferText(): string {
    return this.rowDataValue.map((row) => row.text).join("\n");
  }
}
