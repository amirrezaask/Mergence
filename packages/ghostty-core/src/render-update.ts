import type {
  GhosttyCell,
  GhosttyColor,
  GhosttySnapshot,
} from "./core.js";

/** Increment whenever the packed layout or its semantics change. */
export const GHOSTTY_RENDER_UPDATE_VERSION = 1 as const;

/**
 * Cell style layout. Width occupies bits 0..1, underline occupies bits 8..10.
 * Keeping style in one u16 makes updates compact and directly uploadable.
 */
export const GHOSTTY_RENDER_STYLE = {
  widthMask: 0b11,
  bold: 1 << 2,
  italic: 1 << 3,
  invisible: 1 << 4,
  strikethrough: 1 << 5,
  overline: 1 << 6,
  selected: 1 << 7,
  underlineShift: 8,
  underlineMask: 0b111 << 8,
} as const;

export const GHOSTTY_RENDER_ROW = {
  wrapContinuation: 1 << 0,
  wrapsToNext: 1 << 1,
} as const;

export interface GhosttyRenderUpdate {
  readonly version: typeof GHOSTTY_RENDER_UPDATE_VERSION;
  readonly frameId: number;
  readonly generation: number;
  readonly cols: number;
  readonly rows: number;
  readonly full: boolean;
  readonly foreground: number;
  readonly background: number;
  readonly cursor: number;
  readonly cursorX: number;
  readonly cursorY: number;
  readonly cursorVisible: boolean;
  readonly cursorBlinking: boolean;
  readonly cursorStyle: number;
  /** Sorted, unique viewport row indices. */
  readonly dirtyRows: Uint32Array;
  /** One flag byte for each dirty row. */
  readonly rowFlags: Uint8Array;
  /** Dirty-row-major cell data; every included row contributes `cols` cells. */
  readonly graphemeOffsets: Uint32Array;
  readonly graphemeLengths: Uint32Array;
  readonly foregrounds: Uint32Array;
  readonly backgrounds: Uint32Array;
  readonly styles: Uint16Array;
  /** UTF-8 payload addressed by graphemeOffsets/graphemeLengths. */
  readonly graphemes: Uint8Array;
}

export function packGhosttyColor(color: GhosttyColor): number {
  return ((color.r & 0xff) << 16) | ((color.g & 0xff) << 8) | (color.b & 0xff);
}

export function unpackGhosttyColor(color: number): GhosttyColor {
  return {
    r: (color >>> 16) & 0xff,
    g: (color >>> 8) & 0xff,
    b: color & 0xff,
  };
}

export function packGhosttyCellStyle(cell: GhosttyCell): number {
  return (
    (cell.wide & GHOSTTY_RENDER_STYLE.widthMask) |
    (cell.bold ? GHOSTTY_RENDER_STYLE.bold : 0) |
    (cell.italic ? GHOSTTY_RENDER_STYLE.italic : 0) |
    (cell.invisible ? GHOSTTY_RENDER_STYLE.invisible : 0) |
    (cell.strikethrough ? GHOSTTY_RENDER_STYLE.strikethrough : 0) |
    (cell.overline ? GHOSTTY_RENDER_STYLE.overline : 0) |
    (cell.selected ? GHOSTTY_RENDER_STYLE.selected : 0) |
    ((cell.underline & 0b111) << GHOSTTY_RENDER_STYLE.underlineShift)
  );
}

interface BuilderSlot {
  busy: boolean;
  dirtyRows: Uint32Array;
  rowFlags: Uint8Array;
  graphemeOffsets: Uint32Array;
  graphemeLengths: Uint32Array;
  foregrounds: Uint32Array;
  backgrounds: Uint32Array;
  styles: Uint16Array;
  graphemes: Uint8Array;
}

const textEncoder = new TextEncoder();

function nextCapacity(required: number): number {
  let capacity = 1;
  while (capacity < required) capacity *= 2;
  return capacity;
}

function ensureU8(value: Uint8Array, required: number): Uint8Array {
  return value.length >= required ? value : new Uint8Array(nextCapacity(required));
}

function ensureU16(value: Uint16Array, required: number): Uint16Array {
  return value.length >= required ? value : new Uint16Array(nextCapacity(required));
}

function ensureU32(value: Uint32Array, required: number): Uint32Array {
  return value.length >= required ? value : new Uint32Array(nextCapacity(required));
}

function createSlot(): BuilderSlot {
  return {
    busy: false,
    dirtyRows: new Uint32Array(1),
    rowFlags: new Uint8Array(1),
    graphemeOffsets: new Uint32Array(1),
    graphemeLengths: new Uint32Array(1),
    foregrounds: new Uint32Array(1),
    backgrounds: new Uint32Array(1),
    styles: new Uint16Array(1),
    graphemes: new Uint8Array(1),
  };
}

/**
 * Reuses backing buffers across frames. A returned update owns its views until
 * `release` is called; building while all slots are borrowed allocates another
 * slot rather than mutating an in-flight update.
 */
export class GhosttyRenderUpdateBuilder {
  private readonly slots: BuilderSlot[] = [createSlot()];
  private readonly owners = new WeakMap<GhosttyRenderUpdate, BuilderSlot>();

  build(options: {
    readonly snapshot: GhosttySnapshot;
    readonly frameId: number;
    readonly generation: number;
    readonly full: boolean;
  }): GhosttyRenderUpdate {
    const { snapshot, frameId, generation, full } = options;
    const rows = full
      ? Array.from({ length: snapshot.rows }, (_, row) => row)
      : [...snapshot.dirtyRows].sort((left, right) => left - right);
    const cellCount = rows.length * snapshot.cols;
    let graphemeCapacity = 0;
    for (const rowIndex of rows) {
      const row = snapshot.rowData[rowIndex];
      if (!row) continue;
      for (let column = 0; column < snapshot.cols; column += 1) {
        // UTF-8 needs at most three bytes per UTF-16 code unit (surrogate pairs
        // use four bytes for two units). Reserve once, then encode directly
        // into the reusable payload instead of allocating per-cell byte arrays.
        graphemeCapacity += (row.cells[column]?.text.length ?? 0) * 3;
      }
    }

    const slot = this.slots.find((candidate) => !candidate.busy) ?? createSlot();
    if (!this.slots.includes(slot)) this.slots.push(slot);
    slot.busy = true;
    slot.dirtyRows = ensureU32(slot.dirtyRows, rows.length);
    slot.rowFlags = ensureU8(slot.rowFlags, rows.length);
    slot.graphemeOffsets = ensureU32(slot.graphemeOffsets, cellCount);
    slot.graphemeLengths = ensureU32(slot.graphemeLengths, cellCount);
    slot.foregrounds = ensureU32(slot.foregrounds, cellCount);
    slot.backgrounds = ensureU32(slot.backgrounds, cellCount);
    slot.styles = ensureU16(slot.styles, cellCount);
    slot.graphemes = ensureU8(slot.graphemes, graphemeCapacity);

    let cellIndex = 0;
    let graphemeOffset = 0;
    for (let includedRow = 0; includedRow < rows.length; includedRow += 1) {
      const rowIndex = rows[includedRow] ?? 0;
      const row = snapshot.rowData[rowIndex];
      slot.dirtyRows[includedRow] = rowIndex;
      slot.rowFlags[includedRow] =
        (row?.isWrapContinuation ? GHOSTTY_RENDER_ROW.wrapContinuation : 0) |
        (row?.wrapsToNext ? GHOSTTY_RENDER_ROW.wrapsToNext : 0);
      for (let column = 0; column < snapshot.cols; column += 1) {
        const cell = row?.cells[column];
        const text = cell?.text ?? "";
        const encoded = text.length === 0
          ? { read: 0, written: 0 }
          : textEncoder.encodeInto(text, slot.graphemes.subarray(graphemeOffset));
        slot.graphemeOffsets[cellIndex] = graphemeOffset;
        slot.graphemeLengths[cellIndex] = encoded.written;
        graphemeOffset += encoded.written;
        slot.foregrounds[cellIndex] = packGhosttyColor(cell?.foreground ?? snapshot.foreground);
        slot.backgrounds[cellIndex] = packGhosttyColor(cell?.background ?? snapshot.background);
        slot.styles[cellIndex] = cell ? packGhosttyCellStyle(cell) : 0;
        cellIndex += 1;
      }
    }

    const update: GhosttyRenderUpdate = {
      version: GHOSTTY_RENDER_UPDATE_VERSION,
      frameId,
      generation,
      cols: snapshot.cols,
      rows: snapshot.rows,
      full,
      foreground: packGhosttyColor(snapshot.foreground),
      background: packGhosttyColor(snapshot.background),
      cursor: packGhosttyColor(snapshot.cursor),
      cursorX: snapshot.cursorX,
      cursorY: snapshot.cursorY,
      cursorVisible: snapshot.cursorVisible,
      cursorBlinking: snapshot.cursorBlinking,
      cursorStyle: snapshot.cursorStyle,
      dirtyRows: slot.dirtyRows.subarray(0, rows.length),
      rowFlags: slot.rowFlags.subarray(0, rows.length),
      graphemeOffsets: slot.graphemeOffsets.subarray(0, cellCount),
      graphemeLengths: slot.graphemeLengths.subarray(0, cellCount),
      foregrounds: slot.foregrounds.subarray(0, cellCount),
      backgrounds: slot.backgrounds.subarray(0, cellCount),
      styles: slot.styles.subarray(0, cellCount),
      graphemes: slot.graphemes.subarray(0, graphemeOffset),
    };
    this.owners.set(update, slot);
    return update;
  }

  release(update: GhosttyRenderUpdate): void {
    const slot = this.owners.get(update);
    if (!slot) return;
    this.owners.delete(update);
    slot.busy = false;
  }
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isColor(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0 && value <= 0xffffff;
}

/** Validate packed data before it crosses into a viewport model or renderer. */
export function validateGhosttyRenderUpdate(value: unknown): value is GhosttyRenderUpdate {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("version" in value) || value.version !== GHOSTTY_RENDER_UPDATE_VERSION ||
    !("frameId" in value) || !isSafeInteger(value.frameId) || value.frameId < 1 ||
    !("generation" in value) || !isSafeInteger(value.generation) || value.generation < 1 ||
    !("cols" in value) || !isSafeInteger(value.cols) || value.cols < 1 || value.cols > 65_535 ||
    !("rows" in value) || !isSafeInteger(value.rows) || value.rows < 1 || value.rows > 65_535 ||
    !("full" in value) || typeof value.full !== "boolean" ||
    !("foreground" in value) || !isColor(value.foreground) ||
    !("background" in value) || !isColor(value.background) ||
    !("cursor" in value) || !isColor(value.cursor) ||
    !("cursorX" in value) || !isSafeInteger(value.cursorX) ||
    !("cursorY" in value) || !isSafeInteger(value.cursorY) ||
    !("cursorVisible" in value) || typeof value.cursorVisible !== "boolean" ||
    !("cursorBlinking" in value) || typeof value.cursorBlinking !== "boolean" ||
    !("cursorStyle" in value) || !isSafeInteger(value.cursorStyle) ||
    !("dirtyRows" in value) || !(value.dirtyRows instanceof Uint32Array) ||
    !("rowFlags" in value) || !(value.rowFlags instanceof Uint8Array) ||
    !("graphemeOffsets" in value) || !(value.graphemeOffsets instanceof Uint32Array) ||
    !("graphemeLengths" in value) || !(value.graphemeLengths instanceof Uint32Array) ||
    !("foregrounds" in value) || !(value.foregrounds instanceof Uint32Array) ||
    !("backgrounds" in value) || !(value.backgrounds instanceof Uint32Array) ||
    !("styles" in value) || !(value.styles instanceof Uint16Array) ||
    !("graphemes" in value) || !(value.graphemes instanceof Uint8Array)
  ) return false;

  const rowCount = value.dirtyRows.length;
  const cellCount = rowCount * value.cols;
  if (
    value.rowFlags.length !== rowCount ||
    value.graphemeOffsets.length !== cellCount ||
    value.graphemeLengths.length !== cellCount ||
    value.foregrounds.length !== cellCount ||
    value.backgrounds.length !== cellCount ||
    value.styles.length !== cellCount ||
    (value.full && rowCount !== value.rows)
  ) return false;
  let previousRow = -1;
  for (const row of value.dirtyRows) {
    if (row <= previousRow || row >= value.rows) return false;
    previousRow = row;
  }
  for (let index = 0; index < cellCount; index += 1) {
    const offset = value.graphemeOffsets[index];
    const length = value.graphemeLengths[index];
    if (offset === undefined || length === undefined || offset + length > value.graphemes.length) {
      return false;
    }
    if (!isColor(value.foregrounds[index]) || !isColor(value.backgrounds[index])) return false;
  }
  return true;
}
