export type AtlasRect = {
  readonly layer: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type GlyphAtlasEntry = AtlasRect & {
  readonly key: string | number
  readonly glyph: string
  readonly offsetX: number
  readonly offsetY: number
  bitmap?: Uint8Array
}

export type GlyphAtlasDiagnostics = {
  readonly glyphs: number
  readonly layers: number
  readonly rebuilds: number
  readonly occupancy: number
  readonly gpuBytes: number
  readonly pendingUploads: number
  readonly pendingBitmapBytes: number
  readonly peakBitmapBytes: number
  readonly generation: number
  readonly rasterCpuMs: number
}

type Row = { x: number; y: number; height: number }
type RasterContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
type RasterCanvas = HTMLCanvasElement | OffscreenCanvas

export const MAX_PENDING_BITMAP_BYTES = 2 * 1024 * 1024

/** Deterministic row packer used by both browser atlas and pure tests. */
export class AtlasPacker {
  private readonly rows: Row[][]
  private cursorLayer = 0

  constructor(
    readonly width: number,
    readonly height: number,
    readonly layers: number,
  ) {
    if (width < 1 || height < 1 || layers < 1) throw new Error("invalid atlas dimensions")
    this.rows = Array.from({ length: layers }, () => [])
  }

  allocate(width: number, height: number): AtlasRect | null {
    if (width < 1 || height < 1 || width > this.width || height > this.height) return null
    for (let layer = this.cursorLayer; layer < this.layers; layer += 1) {
      const rows = this.rows[layer]
      for (const row of rows) {
        if (height <= row.height && row.x + width <= this.width) {
          const result = { layer, x: row.x, y: row.y, width, height }
          row.x += width
          this.cursorLayer = layer
          return result
        }
      }
      const y = rows.length === 0 ? 0 : rows[rows.length - 1]!.y + rows[rows.length - 1]!.height
      if (y + height <= this.height) {
        const row = { x: width, y, height }
        rows.push(row)
        this.cursorLayer = layer
        return { layer, x: 0, y, width, height }
      }
    }
    return null
  }

  reset(): void {
    for (const rows of this.rows) rows.length = 0
    this.cursorLayer = 0
  }

  usedArea(): number {
    let area = 0
    for (const rows of this.rows) {
      for (const row of rows) area += row.x * row.height
    }
    return area
  }
}

function createRasterCanvas(width: number, height: number): RasterCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height)
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    return canvas
  }
  throw new Error("glyph rasterization requires a browser canvas")
}

function contextFor(canvas: RasterCanvas): RasterContext {
  const context = canvas.getContext("2d")
  if (!context) throw new Error("could not create a glyph rasterizer")
  return context
}

function finiteMetric(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function signedMetric(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/** Place a tightly packed glyph bitmap so the text origin sits at the cell left + shared baseline. */
export function glyphCellPlacement(input: {
  readonly padding: number
  readonly left: number
  readonly ascent: number
  readonly baseline: number
}): { readonly offsetX: number; readonly offsetY: number } {
  const leftBearing = Math.max(0, input.left)
  return {
    offsetX: Math.round(-input.padding - leftBearing),
    offsetY: Math.round(input.baseline - input.padding - input.ascent),
  }
}

/**
 * A bounded alpha atlas.  It owns one reusable raster canvas per surface and
 * emits uploads only for misses; the renderer releases each bitmap after the
 * corresponding `texSubImage3D` succeeds.
 */
export class GlyphAtlas {
  private packer: AtlasPacker
  private readonly entries = new Map<string | number, GlyphAtlasEntry>()
  private readonly pending: GlyphAtlasEntry[] = []
  private pendingHead = 0
  private rebuildCount = 0
  private fontKey = ""
  private generationValue = 0
  private pendingBitmapBytesValue = 0
  private peakBitmapBytesValue = 0
  private rasterCanvas: RasterCanvas | undefined
  private rasterContext: RasterContext | undefined
  private rasterWidth = 1
  private rasterHeight = 1
  private rasterCpuMsValue = 0
  private readonly padding = 2

  constructor(
    private readonly width = 2048,
    private readonly height = 2048,
    private readonly layerCount = 1,
    private readonly maxGlyphs = 4096,
  ) {
    if (width < 64 || height < 64 || layerCount < 1 || maxGlyphs < 1) {
      throw new Error("invalid glyph atlas bounds")
    }
    this.packer = new AtlasPacker(width, height, layerCount)
  }

  get generation(): number {
    return this.generationValue
  }

  setFont(fontKey: string): void {
    if (fontKey === this.fontKey) return
    this.fontKey = fontKey
    this.clear()
  }

  /** Compatibility API for callers that already have a complete font key. */
  get(
    glyph: string,
    font: string,
    cellWidth: number,
    cellHeight: number,
    baseline: number,
    cellSpan = 1,
  ): GlyphAtlasEntry {
    const key = `${this.fontKey}\u0000${font}\u0000${Math.max(1, Math.min(2, Math.trunc(cellSpan)))}\u0000${glyph}`
    return this.getByKey(key, glyph, font, cellWidth, cellHeight, baseline, cellSpan)
  }

  /** Numeric-key path used by the retained packet builder (no per-cell key strings). */
  getById(
    key: number,
    glyph: string,
    font: string,
    cellWidth: number,
    cellHeight: number,
    baseline: number,
    cellSpan = 1,
  ): GlyphAtlasEntry {
    return this.getByKey(key, glyph, font, cellWidth, cellHeight, baseline, cellSpan)
  }

  forEachPendingUpload(visit: (entry: GlyphAtlasEntry) => void): void {
    for (let index = this.pendingHead; index < this.pending.length; index += 1) {
      const entry = this.pending[index]
      if (entry) visit(entry)
    }
  }

  markUploaded(entry: GlyphAtlasEntry): void {
    if (!entry.bitmap) return
    this.pendingBitmapBytesValue = Math.max(0, this.pendingBitmapBytesValue - entry.bitmap.byteLength)
    entry.bitmap = undefined
    while (this.pendingHead < this.pending.length && this.pending[this.pendingHead]?.bitmap === undefined) this.pendingHead += 1
  }

  compactPendingUploads(): void {
    if (this.pendingHead < 64 || this.pendingHead * 2 < this.pending.length) return
    this.pending.splice(0, this.pendingHead)
    this.pendingHead = 0
  }

  clear(): void {
    this.entries.clear()
    this.packer.reset()
    this.pending.length = 0
    this.pendingHead = 0
    this.pendingBitmapBytesValue = 0
    this.generationValue += 1
    this.rebuildCount += 1
  }

  diagnostics(): GlyphAtlasDiagnostics {
    return {
      glyphs: this.entries.size,
      layers: this.layerCount,
      rebuilds: this.rebuildCount,
      occupancy: this.packer.usedArea() / (this.width * this.height * this.layerCount),
      gpuBytes: this.width * this.height * this.layerCount,
      pendingUploads: Math.max(0, this.pending.length - this.pendingHead),
      pendingBitmapBytes: this.pendingBitmapBytesValue,
      peakBitmapBytes: this.peakBitmapBytesValue,
      generation: this.generationValue,
      rasterCpuMs: this.rasterCpuMsValue,
    }
  }

  private getByKey(
    key: string | number,
    glyph: string,
    font: string,
    cellWidth: number,
    cellHeight: number,
    baseline: number,
    cellSpan: number,
  ): GlyphAtlasEntry {
    const existing = this.entries.get(key)
    if (existing) return existing
    if (this.entries.size >= this.maxGlyphs) this.clear()

    const span = Math.max(1, Math.min(2, Math.trunc(cellSpan)))
    const metrics = this.rasterize(glyph, font, cellWidth * span, cellHeight, baseline)
    if (metrics.bitmap.byteLength > MAX_PENDING_BITMAP_BYTES) {
      throw new Error("Neovim glyph bitmap exceeds the pending atlas budget")
    }
    if (this.pendingBitmapBytesValue + metrics.bitmap.byteLength > MAX_PENDING_BITMAP_BYTES) {
      throw new Error("Neovim pending glyph bitmap budget exceeded")
    }
    let rect = this.packer.allocate(metrics.bitmapWidth, metrics.bitmapHeight)
    if (!rect) {
      this.clear()
      rect = this.packer.allocate(metrics.bitmapWidth, metrics.bitmapHeight)
    }
    if (!rect) throw new Error("glyph does not fit in the bounded Neovim atlas")
    const entry: GlyphAtlasEntry = {
      ...rect,
      key,
      glyph,
      offsetX: metrics.offsetX,
      offsetY: metrics.offsetY,
      bitmap: metrics.bitmap,
    }
    this.entries.set(key, entry)
    this.pending.push(entry)
    this.pendingBitmapBytesValue += metrics.bitmap.byteLength
    this.peakBitmapBytesValue = Math.max(this.peakBitmapBytesValue, this.pendingBitmapBytesValue)
    return entry
  }

  private rasterize(
    glyph: string,
    font: string,
    _cellWidth: number,
    cellHeight: number,
    baseline: number,
  ): {
    readonly bitmap: Uint8Array
    readonly bitmapWidth: number
    readonly bitmapHeight: number
    readonly offsetX: number
    readonly offsetY: number
  } {
    const startedAt = performance.now()
    if (!this.rasterCanvas || !this.rasterContext) {
      this.rasterCanvas = createRasterCanvas(1, 1)
      this.rasterContext = contextFor(this.rasterCanvas)
    }
    const context = this.rasterContext
    context.font = font
    context.textAlign = "left"
    context.textBaseline = "alphabetic"
    const measurement = context.measureText(glyph)
    const left = signedMetric(measurement.actualBoundingBoxLeft, 0)
    const right = finiteMetric(measurement.actualBoundingBoxRight, Math.max(1, measurement.width))
    const ascent = finiteMetric(measurement.actualBoundingBoxAscent, Math.max(1, baseline))
    const descent = finiteMetric(measurement.actualBoundingBoxDescent, Math.max(1, cellHeight - baseline))
    const leftBearing = Math.max(0, left)
    const contentWidth = Math.max(1, Math.ceil(leftBearing + right))
    const contentHeight = Math.max(1, Math.ceil(ascent + descent))
    const bitmapWidth = contentWidth + this.padding * 2
    const bitmapHeight = contentHeight + this.padding * 2
    this.ensureRasterSize(bitmapWidth, bitmapHeight)
    context.clearRect(0, 0, bitmapWidth, bitmapHeight)
    context.font = font
    context.textAlign = "left"
    context.textBaseline = "alphabetic"
    context.fillStyle = "white"
    context.fillText(glyph, this.padding + leftBearing, this.padding + ascent)
    const image = context.getImageData(0, 0, bitmapWidth, bitmapHeight)
    const alpha = new Uint8Array(bitmapWidth * bitmapHeight)
    for (let index = 0; index < alpha.length; index += 1) alpha[index] = image.data[index * 4 + 3] ?? 0
    this.rasterCpuMsValue += performance.now() - startedAt
    const placement = glyphCellPlacement({
      padding: this.padding,
      left,
      ascent,
      baseline,
    })
    return {
      bitmap: alpha,
      bitmapWidth,
      bitmapHeight,
      offsetX: placement.offsetX,
      offsetY: placement.offsetY,
    }
  }

  private ensureRasterSize(width: number, height: number): void {
    if (!this.rasterCanvas) return
    if (width > this.rasterWidth) {
      this.rasterWidth = width
      this.rasterCanvas.width = width
    }
    if (height > this.rasterHeight) {
      this.rasterHeight = height
      this.rasterCanvas.height = height
    }
  }
}
