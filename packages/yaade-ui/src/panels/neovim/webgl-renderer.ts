import { toSrgbColor, type YaadeTheme } from "@yaade/shared"
import { GlyphAtlas, type GlyphAtlasEntry } from "./atlas.js"
import {
  CELL_CONTINUATION,
  CELL_STRIKETHROUGH,
  CELL_UNDERCURL,
  CELL_UNDERDASHED,
  CELL_UNDERDOTTED,
  CELL_UNDERDOUBLE,
  CELL_UNDERLINE,
  CELL_WIDE,
  LineGridModel,
  type GridFrame,
  type HighlightAttributes,
} from "./line-grid.js"

export const CELL_PACKET_STRIDE = 32
export const CELL_PACKET_OFFSETS = {
  background: 0,
  foreground: 4,
  special: 8,
  atlas: 12,
  metadata: 20,
  bearing: 24,
} as const
export const PACKET_HAS_GLYPH = 1
export const PACKET_CONTINUATION = 2
export const PACKET_WIDE = 4

export type NeovimRendererDiagnostics = {
  readonly frames: number
  readonly fullFrames: number
  readonly dirtyRows: number
  readonly dirtyRuns: number
  readonly drawCalls: number
  readonly lastFrameDrawCalls: number
  readonly bytesUploaded: number
  readonly cellBytesUploaded: number
  readonly atlasBytesUploaded: number
  readonly atlasGlyphs: number
  readonly atlasLayers: number
  readonly atlasRebuilds: number
  readonly atlasOccupancy: number
  readonly atlasGpuBytes: number
  readonly pendingBitmapBytes: number
  readonly peakPendingBitmapBytes: number
  readonly packetCapacityBytes: number
  readonly modelBytes: number
  readonly contextLosses: number
  readonly lastFrameCpuMs: number
  readonly lastPacketBuildCpuMs: number
  readonly lastCellUploadCpuMs: number
  readonly lastAtlasUploadCpuMs: number
  readonly lastDrawSubmitCpuMs: number
  readonly lastAtlasRasterCpuMs: number
  readonly gpuTimeAvailable: boolean
  readonly lastGpuMs: number
  readonly gpuQueries: number
  readonly themeId: string
}

export type NeovimRenderMetrics = {
  readonly cellWidth: number
  readonly cellHeight: number
  readonly baseline: number
  readonly fontSize: number
  readonly fontFamily: string
  readonly pixelRatio: number
}

type Program = {
  readonly program: WebGLProgram
  readonly uniforms: {
    readonly viewport: WebGLUniformLocation
    readonly cell: WebGLUniformLocation
    readonly gridWidth: WebGLUniformLocation | null
    readonly atlas: WebGLUniformLocation | null
    readonly atlasSize: WebGLUniformLocation | null
    readonly cursor: WebGLUniformLocation | null
    readonly cursorInvert: WebGLUniformLocation | null
  }
}

type ColorVector = [number, number, number, number]

export type ResolvedColors = {
  readonly foreground: ColorVector
  readonly background: ColorVector
  readonly special: ColorVector
}

type PackedColor = {
  readonly red: number
  readonly green: number
  readonly blue: number
  readonly alpha: number
}

type PackedStyle = {
  readonly foreground: PackedColor
  readonly background: PackedColor
  readonly special: PackedColor
  readonly fontVariant: number
  readonly decorationFlags: number
}

type GpuTimerExtension = {
  readonly TIME_ELAPSED_EXT: GLenum
  readonly GPU_DISJOINT_EXT: GLenum
}

const UNIT_QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1])
const RECT_STRIDE = 11
const MAX_TIMER_QUERIES = 4
const MAX_ATLAS_TARGET_BYTES = 8 * 1024 * 1024
const MAX_ATLAS_HARD_BYTES = 16 * 1024 * 1024

const BACKGROUND_VERTEX = `#version 300 es
in vec2 aUnit;
in vec4 aBackground;
in vec4 aForeground;
uniform vec2 uViewport;
uniform vec2 uCell;
uniform int uGridWidth;
uniform ivec2 uCursor;
uniform int uCursorInvert;
out vec4 vColor;
void main() {
  int column = gl_InstanceID % uGridWidth;
  int row = gl_InstanceID / uGridWidth;
  vec2 px = (vec2(float(column), float(row)) + aUnit) * uCell;
  vec2 clip = vec2(px.x / uViewport.x * 2.0 - 1.0, 1.0 - px.y / uViewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vColor = uCursorInvert == 1 && column == uCursor.x && row == uCursor.y ? aForeground : aBackground;
}`

const SOLID_FRAGMENT = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }`

const GLYPH_VERTEX = `#version 300 es
in vec2 aUnit;
in vec4 aForeground;
in vec4 aBackground;
in uvec4 aAtlas;
in uvec4 aMetadata;
in ivec2 aBearing;
uniform vec2 uViewport;
uniform vec2 uCell;
uniform int uGridWidth;
uniform vec2 uAtlasSize;
uniform ivec2 uCursor;
uniform int uCursorInvert;
out vec2 vUv;
out vec4 vColor;
flat out int vLayer;
flat out uint vFlags;
void main() {
  int column = gl_InstanceID % uGridWidth;
  int row = gl_InstanceID / uGridWidth;
  vec2 size = vec2(float(aAtlas.z), float(aAtlas.w));
  vec2 px = vec2(float(column), float(row)) * uCell + vec2(aBearing) + aUnit * size;
  vec2 clip = vec2(px.x / uViewport.x * 2.0 - 1.0, 1.0 - px.y / uViewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vUv = (vec2(aAtlas.xy) + aUnit * vec2(aAtlas.zw)) / uAtlasSize;
  vColor = uCursorInvert == 1 && column == uCursor.x && row == uCursor.y ? aBackground : aForeground;
  vLayer = int(aMetadata.x);
  vFlags = aMetadata.z;
}`

const GLYPH_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vColor;
flat in int vLayer;
flat in uint vFlags;
uniform highp sampler2DArray uAtlas;
out vec4 outColor;
void main() {
  if ((vFlags & 1u) == 0u) discard;
  float alpha = texture(uAtlas, vec3(vUv, float(vLayer))).r;
  if (alpha <= 0.001) discard;
  outColor = vec4(vColor.rgb, vColor.a * alpha);
}`

const DECORATION_VERTEX = `#version 300 es
in vec2 aUnit;
in vec4 aSpecial;
in uvec4 aMetadata;
uniform vec2 uViewport;
uniform vec2 uCell;
uniform int uGridWidth;
out vec2 vUnit;
out vec4 vColor;
flat out uint vFlags;
void main() {
  int column = gl_InstanceID % uGridWidth;
  int row = gl_InstanceID / uGridWidth;
  vec2 px = (vec2(float(column), float(row)) + aUnit) * uCell;
  vec2 clip = vec2(px.x / uViewport.x * 2.0 - 1.0, 1.0 - px.y / uViewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vUnit = aUnit;
  vColor = aSpecial;
  vFlags = aMetadata.z;
}`

const DECORATION_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUnit;
in vec4 vColor;
flat in uint vFlags;
out vec4 outColor;
void main() {
  bool visible = false;
  if ((vFlags & 128u) != 0u) visible = visible || abs(vUnit.y - 0.52) < 0.075;
  if ((vFlags & 4u) != 0u) visible = visible || vUnit.y > 0.74 && vUnit.y < 0.90;
  if ((vFlags & 8u) != 0u) {
    float wave = 0.82 + sin(vUnit.x * 6.2831853) * 0.08;
    visible = visible || abs(vUnit.y - wave) < 0.10;
  }
  if ((vFlags & 16u) != 0u) visible = visible || (vUnit.y > 0.73 && vUnit.y < 0.78) || (vUnit.y > 0.84 && vUnit.y < 0.89);
  if ((vFlags & 32u) != 0u) {
    vec2 point = vec2(fract(vUnit.x * 3.0), vUnit.y) - vec2(0.5);
    visible = visible || dot(point, point) < 0.20;
  }
  if ((vFlags & 64u) != 0u) visible = visible || fract(vUnit.x * 2.0) < 0.34;
  if (!visible) discard;
  outColor = vColor;
}`

const RECT_VERTEX = `#version 300 es
in vec2 aUnit;
in vec2 aPosition;
in vec4 aRect;
in vec4 aColor;
in float aStyle;
uniform vec2 uViewport;
uniform vec2 uCell;
out vec2 vUnit;
out vec4 vColor;
flat out float vStyle;
void main() {
  vec2 point = aPosition + aRect.xy + aUnit * aRect.zw;
  vec2 px = point * uCell;
  vec2 clip = vec2(px.x / uViewport.x * 2.0 - 1.0, 1.0 - px.y / uViewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vUnit = aUnit;
  vColor = aColor;
  vStyle = aStyle;
}`

const CURSOR_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUnit;
in vec4 vColor;
flat in float vStyle;
uniform vec2 uCell;
out vec4 outColor;
void main() {
  float insetX = min(0.35, 1.25 / max(uCell.x, 1.0));
  float insetY = min(0.35, 1.25 / max(uCell.y, 1.0));
  if (vStyle > 0.5 && vUnit.x > insetX && vUnit.x < 1.0 - insetX && vUnit.y > insetY && vUnit.y < 1.0 - insetY) discard;
  outColor = vColor;
}`

function colorFromRgb(value: number): string {
  const rgb = value >>> 0
  return `#${(rgb & 0xffffff).toString(16).padStart(6, "0")}`
}

function cssColor(value: string): ColorVector {
  const normalized = value.trim()
  const hex = normalized.match(/^#([0-9a-f]{6}|[0-9a-f]{8})$/i)
  if (hex) {
    const digits = hex[1]!
    const alpha = digits.length === 8 ? Number.parseInt(digits.slice(6), 16) / 255 : 1
    return [
      Number.parseInt(digits.slice(0, 2), 16) / 255,
      Number.parseInt(digits.slice(2, 4), 16) / 255,
      Number.parseInt(digits.slice(4, 6), 16) / 255,
      alpha,
    ]
  }
  const rgb = normalized.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i)
  if (rgb) {
    return [
      Math.min(255, Number(rgb[1])) / 255,
      Math.min(255, Number(rgb[2])) / 255,
      Math.min(255, Number(rgb[3])) / 255,
      rgb[4] === undefined ? 1 : Math.min(1, Number(rgb[4])),
    ]
  }
  return [1, 1, 1, 1]
}

function colorVector(value: string): ColorVector {
  return cssColor(toSrgbColor(value))
}

function highlightColor(value: number | undefined, fallback: string): ColorVector {
  return colorVector(value === undefined || value < 0 ? fallback : colorFromRgb(value))
}

export type NeovimDefaultColors = {
  readonly foreground?: number
  readonly background?: number
  readonly special?: number
}

export function resolveNeovimHighlightColors(
  attributes: HighlightAttributes | undefined,
  theme: YaadeTheme,
  defaults: NeovimDefaultColors = {},
): ResolvedColors {
  const foreground = highlightColor(attributes?.foreground ?? defaults.foreground, theme.colors.text)
  const background = highlightColor(attributes?.background ?? defaults.background, theme.colors.bg)
  const special = highlightColor(attributes?.special ?? defaults.special, theme.colors.accent)
  const blend = Math.max(0, Math.min(100, attributes?.blend ?? 0)) / 100
  const base = highlightColor(defaults.background, theme.colors.bg)
  const composedBackground: ColorVector = [
    background[0] * (1 - blend) + base[0] * blend,
    background[1] * (1 - blend) + base[1] * blend,
    background[2] * (1 - blend) + base[2] * blend,
    1,
  ]
  if (attributes?.reverse) {
    return { foreground: composedBackground, background: foreground, special }
  }
  return { foreground, background: composedBackground, special }
}

function requireUniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name)
  if (location === null) throw new Error(`WebGL uniform is missing: ${name}`)
  return location
}

function optionalUniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation | null {
  return gl.getUniformLocation(program, name)
}

function compileProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
  label: string,
): Program {
  const vertex = gl.createShader(gl.VERTEX_SHADER)
  const fragment = gl.createShader(gl.FRAGMENT_SHADER)
  if (!vertex || !fragment) throw new Error(`WebGL could not allocate ${label} shaders`)
  gl.shaderSource(vertex, vertexSource)
  gl.compileShader(vertex)
  if (!gl.getShaderParameter(vertex, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(vertex) ?? "unknown vertex shader error"
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    throw new Error(`WebGL ${label} vertex shader failed: ${log}`)
  }
  gl.shaderSource(fragment, fragmentSource)
  gl.compileShader(fragment)
  if (!gl.getShaderParameter(fragment, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(fragment) ?? "unknown fragment shader error"
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    throw new Error(`WebGL ${label} fragment shader failed: ${log}`)
  }
  const program = gl.createProgram()
  if (!program) throw new Error(`WebGL could not allocate ${label} program`)
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "unknown program link error"
    gl.deleteProgram(program)
    throw new Error(`WebGL ${label} program failed: ${log}`)
  }
  return {
    program,
    uniforms: {
      viewport: requireUniform(gl, program, "uViewport"),
      cell: requireUniform(gl, program, "uCell"),
      gridWidth: optionalUniform(gl, program, "uGridWidth"),
      atlas: optionalUniform(gl, program, "uAtlas"),
      atlasSize: optionalUniform(gl, program, "uAtlasSize"),
      cursor: optionalUniform(gl, program, "uCursor"),
      cursorInvert: optionalUniform(gl, program, "uCursorInvert"),
    },
  }
}

function nextCapacity(capacity: number, required: number): number {
  if (required <= capacity) return capacity
  return Math.max(required, Math.max(256, capacity * 2))
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255)))
}

function packedColor(color: ColorVector): PackedColor {
  return {
    red: clampByte(color[0]),
    green: clampByte(color[1]),
    blue: clampByte(color[2]),
    alpha: clampByte(color[3]),
  }
}

function decorationFlags(attributes: HighlightAttributes | undefined): number {
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

function styleFor(attributes: HighlightAttributes | undefined, theme: YaadeTheme, defaults: NeovimDefaultColors): PackedStyle {
  const colors = resolveNeovimHighlightColors(attributes, theme, defaults)
  return {
    foreground: packedColor(colors.foreground),
    background: packedColor(colors.background),
    special: packedColor(colors.special),
    fontVariant: (attributes?.italic ? 1 : 0) | (attributes?.bold ? 2 : 0),
    decorationFlags: decorationFlags(attributes),
  }
}

function fontDescriptors(metrics: NeovimRenderMetrics): readonly string[] {
  const size = `${metrics.fontSize * metrics.pixelRatio}px`
  return [
    `${size} ${metrics.fontFamily}`,
    `italic ${size} ${metrics.fontFamily}`,
    `700 ${size} ${metrics.fontFamily}`,
    `italic 700 ${size} ${metrics.fontFamily}`,
  ]
}

/** Retained WebGL2 renderer: four instanced passes over fixed cell packets. */
export class NeovimWebGLRenderer {
  readonly gl: WebGL2RenderingContext
  private readonly backgroundProgram: Program
  private readonly glyphProgram: Program
  private readonly decorationProgram: Program
  private readonly cursorProgram: Program
  private readonly backgroundVao: WebGLVertexArrayObject
  private readonly glyphVao: WebGLVertexArrayObject
  private readonly decorationVao: WebGLVertexArrayObject
  private readonly cursorVao: WebGLVertexArrayObject
  private readonly unitBuffer: WebGLBuffer
  private readonly packetBuffer: WebGLBuffer
  private readonly cursorBuffer: WebGLBuffer
  private readonly atlasTexture: WebGLTexture
  private readonly atlas: GlyphAtlas
  private readonly atlasSize: number
  private readonly packetData = { value: new Uint8Array(0) }
  private packetView = new DataView(new ArrayBuffer(0))
  private packetCapacity = 0
  private packetWidth = 0
  private packetHeight = 0
  private readonly cursorData = new Float32Array(RECT_STRIDE)
  private readonly styles = new Map<number, PackedStyle>()
  private styleGenerationKey = ""
  private metricsKey = ""
  private fonts: readonly string[] = []
  private clearColor: ColorVector = [0, 0, 0, 1]
  private pixelWidth = 1
  private pixelHeight = 1
  private cellWidth = 1
  private cellHeight = 1
  private frames = 0
  private fullFrames = 0
  private dirtyRows = 0
  private dirtyRuns = 0
  private drawCalls = 0
  private lastFrameDrawCalls = 0
  private bytesUploaded = 0
  private cellBytesUploaded = 0
  private atlasBytesUploaded = 0
  private contextLosses = 0
  private lastFrameCpuMs = 0
  private lastPacketBuildCpuMs = 0
  private lastCellUploadCpuMs = 0
  private lastAtlasUploadCpuMs = 0
  private lastDrawSubmitCpuMs = 0
  private lastAtlasRasterCpuMs = 0
  private themeId = ""
  private packetNeedsFull = true
  private atlasGeneration = -1
  private readonly timerExtension: GpuTimerExtension | null
  private readonly timerQueries: WebGLQuery[] = []
  private timerHead = 0
  private timerInFlight = false
  private gpuTimeAvailable = false
  private lastGpuMs = 0
  private gpuQueries = 0
  private cursorCellX = 0
  private cursorCellY = 0
  private cursorInvert = false

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false })
    if (!gl) throw new Error("WebGL2 is unavailable in this browser")
    this.gl = gl
    const maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE))
    const maxLayers = Number(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS))
    const atlasSize = Math.min(2048, maxTextureSize)
    if (!Number.isFinite(atlasSize) || atlasSize < 64 || !Number.isFinite(maxLayers) || maxLayers < 1) {
      throw new Error("WebGL2 does not provide a usable glyph atlas")
    }
    const layerBytes = atlasSize * atlasSize
    const targetLayers = Math.max(1, Math.min(maxLayers, Math.floor(MAX_ATLAS_TARGET_BYTES / layerBytes)))
    const hardLayers = Math.max(1, Math.min(maxLayers, Math.floor(MAX_ATLAS_HARD_BYTES / layerBytes)))
    const layers = Math.min(targetLayers, hardLayers)
    const gpuBytes = atlasSize * atlasSize * layers
    if (gpuBytes > MAX_ATLAS_HARD_BYTES) throw new Error("Neovim glyph atlas exceeds the hard GPU budget")
    this.atlasSize = atlasSize
    this.atlas = new GlyphAtlas(atlasSize, atlasSize, layers, 16_384)
    this.backgroundProgram = compileProgram(gl, BACKGROUND_VERTEX, SOLID_FRAGMENT, "background")
    this.glyphProgram = compileProgram(gl, GLYPH_VERTEX, GLYPH_FRAGMENT, "glyph")
    this.decorationProgram = compileProgram(gl, DECORATION_VERTEX, DECORATION_FRAGMENT, "decoration")
    this.cursorProgram = compileProgram(gl, RECT_VERTEX, CURSOR_FRAGMENT, "cursor")
    const unitBuffer = gl.createBuffer()
    const packetBuffer = gl.createBuffer()
    const cursorBuffer = gl.createBuffer()
    const backgroundVao = gl.createVertexArray()
    const glyphVao = gl.createVertexArray()
    const decorationVao = gl.createVertexArray()
    const cursorVao = gl.createVertexArray()
    const atlasTexture = gl.createTexture()
    if (!unitBuffer || !packetBuffer || !cursorBuffer || !backgroundVao || !glyphVao || !decorationVao || !cursorVao || !atlasTexture) {
      throw new Error("WebGL could not allocate Neovim renderer resources")
    }
    this.unitBuffer = unitBuffer
    this.packetBuffer = packetBuffer
    this.cursorBuffer = cursorBuffer
    this.backgroundVao = backgroundVao
    this.glyphVao = glyphVao
    this.decorationVao = decorationVao
    this.cursorVao = cursorVao
    this.atlasTexture = atlasTexture
    gl.bindBuffer(gl.ARRAY_BUFFER, unitBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, UNIT_QUAD, gl.STATIC_DRAW)
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlasTexture)
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8, atlasSize, atlasSize, layers)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindBuffer(gl.ARRAY_BUFFER, cursorBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.cursorData.byteLength, gl.DYNAMIC_DRAW)
    this.configureBackgroundVao()
    this.configureCellVao(this.glyphVao, this.glyphProgram)
    this.configureDecorationVao()
    this.configureRectVao(this.cursorVao, this.cursorBuffer, this.cursorProgram)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    const extension = gl.getExtension("EXT_disjoint_timer_query_webgl2")
    this.timerExtension = extension
      ? { TIME_ELAPSED_EXT: extension.TIME_ELAPSED_EXT, GPU_DISJOINT_EXT: extension.GPU_DISJOINT_EXT }
      : null
    if (this.timerExtension) {
      for (let index = 0; index < MAX_TIMER_QUERIES; index += 1) {
        const query = gl.createQuery()
        if (query) this.timerQueries.push(query)
      }
      this.gpuTimeAvailable = this.timerQueries.length > 0
    }
  }

  setViewport(pixelWidth: number, pixelHeight: number, cellWidth: number, cellHeight: number, pixelRatio = 1): void {
    this.pixelWidth = Math.max(1, pixelWidth)
    this.pixelHeight = Math.max(1, pixelHeight)
    this.cellWidth = Math.max(1, Math.round(cellWidth * pixelRatio))
    this.cellHeight = Math.max(1, Math.round(cellHeight * pixelRatio))
    this.canvas.width = this.pixelWidth
    this.canvas.height = this.pixelHeight
    this.gl.viewport(0, 0, this.pixelWidth, this.pixelHeight)
  }

  render(
    model: LineGridModel,
    theme: YaadeTheme,
    metrics: NeovimRenderMetrics,
    fullRepaint: boolean,
    cursorPhaseVisible = true,
    focused = true,
    visualBellActive = false,
  ): void {
    const startedAt = performance.now()
    this.themeId = theme.id
    this.cellWidth = Math.max(1, Math.round(metrics.cellWidth * metrics.pixelRatio))
    this.cellHeight = Math.max(1, Math.round(metrics.cellHeight * metrics.pixelRatio))
    const state = model.state()
    this.updateStyleAndMetrics(theme, metrics, state.styleGeneration, {
      foreground: state.defaultForeground,
      background: state.defaultBackground,
      special: state.defaultSpecial,
    })
    const frame = model.frame()
    this.cursorCellX = frame.cursorX
    this.cursorCellY = frame.cursorY
    this.cursorInvert = Boolean(
      focused &&
      cursorPhaseVisible &&
      frame.cursorVisible &&
      frame.cursorMode.shape === "block" &&
      frame.cursorX >= 0 &&
      frame.cursorY >= 0,
    )
    this.ensurePacketCapacity(frame.width, frame.height)
    const dirtyRows = model.dirtyRowCount()
    const packetWasFull = this.packetNeedsFull
    const buildAll = packetWasFull || dirtyRows > 0
    const packetBuildStarted = performance.now()
    this.lastAtlasRasterCpuMs = 0
    let atlasChanged = false
    let uploadAllPackets = packetWasFull
    const atlasRasterBefore = this.atlas.diagnostics().rasterCpuMs
    if (buildAll) {
      atlasChanged = this.buildPackets(model, frame, theme, metrics, packetWasFull)
      if (atlasChanged) {
        uploadAllPackets = true
        this.packetNeedsFull = true
        atlasChanged = this.buildPackets(model, frame, theme, metrics, true)
      }
      if (atlasChanged) throw new Error("Neovim glyph atlas could not stabilize during packet rebuild")
      this.atlasGeneration = this.atlas.generation
      this.packetNeedsFull = false
    }
    this.lastPacketBuildCpuMs = performance.now() - packetBuildStarted
    this.lastAtlasRasterCpuMs = this.atlas.diagnostics().rasterCpuMs - atlasRasterBefore

    const atlasUploadStarted = performance.now()
    this.uploadAtlasIfNeeded()
    this.lastAtlasUploadCpuMs = performance.now() - atlasUploadStarted

    const cellUploadStarted = performance.now()
    if (buildAll) {
      this.uploadPacketRanges(model, frame, dirtyRows, uploadAllPackets)
      model.clearDirtyRows()
    }
    this.lastCellUploadCpuMs = performance.now() - cellUploadStarted

    this.pollGpuQueries()
    const gl = this.gl
    gl.viewport(0, 0, this.pixelWidth, this.pixelHeight)
    const clear = this.clearColor
    gl.clearColor(clear[0], clear[1], clear[2], 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const drawStarted = performance.now()
    this.lastFrameDrawCalls = 0
    this.beginGpuQuery()
    const cells = frame.width * frame.height
    this.drawBackgrounds(cells, frame.width)
    this.drawGlyphs(cells, frame.width)
    this.drawDecorations(cells, frame.width)
    if (frame.cursorVisible && cursorPhaseVisible && frame.cursorX >= 0 && frame.cursorY >= 0 && !this.cursorInvert) {
      this.drawCursor(theme, model, frame, focused)
    }
    this.endGpuQuery()
    this.lastDrawSubmitCpuMs = performance.now() - drawStarted
    this.frames += 1
    if (fullRepaint) this.fullFrames += 1
    this.dirtyRows += dirtyRows
    this.lastFrameCpuMs = performance.now() - startedAt
    void visualBellActive
  }

  diagnostics(): NeovimRendererDiagnostics {
    const atlas = this.atlas.diagnostics()
    return {
      frames: this.frames,
      fullFrames: this.fullFrames,
      dirtyRows: this.dirtyRows,
      dirtyRuns: this.dirtyRuns,
      drawCalls: this.drawCalls,
      lastFrameDrawCalls: this.lastFrameDrawCalls,
      bytesUploaded: this.bytesUploaded,
      cellBytesUploaded: this.cellBytesUploaded,
      atlasBytesUploaded: this.atlasBytesUploaded,
      atlasGlyphs: atlas.glyphs,
      atlasLayers: atlas.layers,
      atlasRebuilds: atlas.rebuilds,
      atlasOccupancy: atlas.occupancy,
      atlasGpuBytes: atlas.gpuBytes,
      pendingBitmapBytes: atlas.pendingBitmapBytes,
      peakPendingBitmapBytes: atlas.peakBitmapBytes,
      packetCapacityBytes: this.packetCapacity * CELL_PACKET_STRIDE,
      modelBytes: this.packetWidth * this.packetHeight * CELL_PACKET_STRIDE,
      contextLosses: this.contextLosses,
      lastFrameCpuMs: this.lastFrameCpuMs,
      lastPacketBuildCpuMs: this.lastPacketBuildCpuMs,
      lastCellUploadCpuMs: this.lastCellUploadCpuMs,
      lastAtlasUploadCpuMs: this.lastAtlasUploadCpuMs,
      lastDrawSubmitCpuMs: this.lastDrawSubmitCpuMs,
      lastAtlasRasterCpuMs: this.lastAtlasRasterCpuMs,
      gpuTimeAvailable: this.gpuTimeAvailable,
      lastGpuMs: this.lastGpuMs,
      gpuQueries: this.gpuQueries,
      themeId: this.themeId,
    }
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteProgram(this.backgroundProgram.program)
    gl.deleteProgram(this.glyphProgram.program)
    gl.deleteProgram(this.decorationProgram.program)
    gl.deleteProgram(this.cursorProgram.program)
    gl.deleteBuffer(this.unitBuffer)
    gl.deleteBuffer(this.packetBuffer)
    gl.deleteBuffer(this.cursorBuffer)
    gl.deleteTexture(this.atlasTexture)
    gl.deleteVertexArray(this.backgroundVao)
    gl.deleteVertexArray(this.glyphVao)
    gl.deleteVertexArray(this.decorationVao)
    gl.deleteVertexArray(this.cursorVao)
    for (const query of this.timerQueries) gl.deleteQuery(query)
  }

  private updateStyleAndMetrics(
    theme: YaadeTheme,
    metrics: NeovimRenderMetrics,
    styleGeneration: number,
    defaults: NeovimDefaultColors,
  ): void {
    const nextMetricsKey = `${metrics.fontFamily}|${metrics.fontSize}|${metrics.pixelRatio}|${metrics.cellWidth}|${metrics.cellHeight}`
    if (nextMetricsKey !== this.metricsKey) {
      this.metricsKey = nextMetricsKey
      this.fonts = fontDescriptors(metrics)
      this.atlas.setFont(nextMetricsKey)
      this.atlasGeneration = this.atlas.generation
      this.packetNeedsFull = true
    }
    const nextStyleKey = `${theme.id}|${theme.colors.bg}|${theme.colors.text}|${defaults.foreground ?? -1}|${defaults.background ?? -1}|${styleGeneration}`
    if (nextStyleKey !== this.styleGenerationKey) {
      this.styleGenerationKey = nextStyleKey
      this.styles.clear()
      this.packetNeedsFull = true
      this.clearColor = highlightColor(defaults.background, theme.colors.bg)
    }
    if (this.atlasGeneration !== this.atlas.generation) {
      this.atlasGeneration = this.atlas.generation
      this.packetNeedsFull = true
    }
  }

  private ensurePacketCapacity(width: number, height: number): void {
    const cells = width * height
    const next = nextCapacity(this.packetCapacity, cells)
    if (next === this.packetCapacity && this.packetWidth === width && this.packetHeight === height) return
    if (next !== this.packetCapacity) {
      this.packetCapacity = next
      this.packetData.value = new Uint8Array(next * CELL_PACKET_STRIDE)
      this.packetView = new DataView(this.packetData.value.buffer)
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.packetBuffer)
      this.gl.bufferData(this.gl.ARRAY_BUFFER, this.packetData.value.byteLength, this.gl.DYNAMIC_DRAW)
    }
    if (this.packetWidth !== width || this.packetHeight !== height) this.packetNeedsFull = true
    this.packetWidth = width
    this.packetHeight = height
  }

  private styleFor(id: number, attributes: HighlightAttributes | undefined, theme: YaadeTheme, defaults: NeovimDefaultColors): PackedStyle {
    const existing = this.styles.get(id)
    if (existing) return existing
    const style = styleFor(attributes, theme, defaults)
    this.styles.set(id, style)
    return style
  }

  private buildPackets(
    model: LineGridModel,
    frame: GridFrame,
    theme: YaadeTheme,
    metrics: NeovimRenderMetrics,
    allRows: boolean,
  ): boolean {
    const atlasBefore = this.atlas.generation
    const state = model.state()
    const defaults: NeovimDefaultColors = {
      foreground: state.defaultForeground,
      background: state.defaultBackground,
      special: state.defaultSpecial,
    }
    const buildRow = (row: number) => {
      for (let col = 0; col < frame.width; col += 1) {
        const index = row * frame.width + col
        const offset = index * CELL_PACKET_STRIDE
        const attributes = model.highlight(frame.highlightIds[index] ?? 0)
        const style = this.styleFor(frame.highlightIds[index] ?? 0, attributes, theme, defaults)
        const cellFlags = frame.cellFlags[index] ?? 0
        this.writeColor(offset + CELL_PACKET_OFFSETS.background, style.background)
        this.writeColor(offset + CELL_PACKET_OFFSETS.foreground, style.foreground)
        this.writeColor(offset + CELL_PACKET_OFFSETS.special, style.special)
        let packetFlags = style.decorationFlags
        if ((cellFlags & CELL_CONTINUATION) !== 0) packetFlags |= PACKET_CONTINUATION
        if ((cellFlags & CELL_WIDE) !== 0) packetFlags |= PACKET_WIDE
        this.packetData.value[offset + CELL_PACKET_OFFSETS.metadata + 2] = packetFlags
        this.packetData.value[offset + CELL_PACKET_OFFSETS.metadata] = 0
        this.packetData.value[offset + CELL_PACKET_OFFSETS.metadata + 1] = 1
        const glyphId = frame.glyphIds[index] ?? 0
        const glyph = model.glyphText(glyphId)
        if (glyph !== " " && (cellFlags & CELL_CONTINUATION) === 0) {
          const span = (cellFlags & CELL_WIDE) !== 0 ? 2 : 1
          const atlasKey = glyphId * 8 + style.fontVariant * 2 + span - 1
          const entry = this.atlas.getById(
            atlasKey,
            glyph,
            this.fonts[style.fontVariant] ?? this.fonts[0] ?? `${metrics.fontSize}px ${metrics.fontFamily}`,
            metrics.cellWidth * metrics.pixelRatio,
            metrics.cellHeight * metrics.pixelRatio,
            metrics.baseline * metrics.pixelRatio,
            span,
          )
          this.writeAtlas(offset, entry, span)
          this.packetData.value[offset + CELL_PACKET_OFFSETS.metadata + 2] = packetFlags | PACKET_HAS_GLYPH
        } else {
          this.clearAtlas(offset)
        }
      }
    }
    if (allRows) {
      for (let row = 0; row < frame.height; row += 1) buildRow(row)
    } else {
      model.forEachDirtyRowRun((start, end) => {
        for (let row = start; row < end; row += 1) buildRow(row)
      })
    }
    return this.atlas.generation !== atlasBefore
  }

  private writeColor(offset: number, color: PackedColor): void {
    const data = this.packetData.value
    data[offset] = color.red
    data[offset + 1] = color.green
    data[offset + 2] = color.blue
    data[offset + 3] = color.alpha
  }

  private writeAtlas(offset: number, entry: GlyphAtlasEntry, span: number): void {
    this.packetView.setUint16(offset + CELL_PACKET_OFFSETS.atlas, entry.x, true)
    this.packetView.setUint16(offset + CELL_PACKET_OFFSETS.atlas + 2, entry.y, true)
    this.packetView.setUint16(offset + CELL_PACKET_OFFSETS.atlas + 4, entry.width, true)
    this.packetView.setUint16(offset + CELL_PACKET_OFFSETS.atlas + 6, entry.height, true)
    this.packetData.value[offset + CELL_PACKET_OFFSETS.metadata] = entry.layer
    this.packetData.value[offset + CELL_PACKET_OFFSETS.metadata + 1] = span
    this.packetView.setInt16(offset + CELL_PACKET_OFFSETS.bearing, entry.offsetX, true)
    this.packetView.setInt16(offset + CELL_PACKET_OFFSETS.bearing + 2, entry.offsetY, true)
  }

  private clearAtlas(offset: number): void {
    for (let index = 0; index < 8; index += 1) this.packetData.value[offset + CELL_PACKET_OFFSETS.atlas + index] = 0
    this.packetView.setInt16(offset + CELL_PACKET_OFFSETS.bearing, 0, true)
    this.packetView.setInt16(offset + CELL_PACKET_OFFSETS.bearing + 2, 0, true)
  }

  private uploadAtlasIfNeeded(): void {
    const gl = this.gl
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTexture)
    this.atlas.forEachPendingUpload(entry => {
      const bitmap = entry.bitmap
      if (!bitmap) return
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        entry.x,
        entry.y,
        entry.layer,
        entry.width,
        entry.height,
        1,
        gl.RED,
        gl.UNSIGNED_BYTE,
        bitmap,
      )
      this.atlasBytesUploaded += bitmap.byteLength
      this.bytesUploaded += bitmap.byteLength
      this.atlas.markUploaded(entry)
    })
    this.atlas.compactPendingUploads()
  }

  private uploadPacketRanges(model: LineGridModel, frame: GridFrame, dirtyRowCount: number, allRows: boolean): void {
    if (dirtyRowCount === 0 && !this.packetNeedsFull) return
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.packetBuffer)
    if (allRows || this.packetNeedsFull) {
      const byteLength = frame.width * frame.height * CELL_PACKET_STRIDE
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.packetData.value, 0, byteLength)
      this.cellBytesUploaded += byteLength
      this.bytesUploaded += byteLength
      this.dirtyRuns += frame.height > 0 ? 1 : 0
      return
    }
    model.forEachDirtyRowRun((start, end) => {
      const offset = start * frame.width * CELL_PACKET_STRIDE
      const length = (end - start) * frame.width * CELL_PACKET_STRIDE
      gl.bufferSubData(gl.ARRAY_BUFFER, offset, this.packetData.value, offset, length)
      this.cellBytesUploaded += length
      this.bytesUploaded += length
      this.dirtyRuns += 1
    })
  }

  private configureBackgroundVao(): void {
    const gl = this.gl
    gl.bindVertexArray(this.backgroundVao)
    this.bindUnitAttribute(this.backgroundProgram)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.packetBuffer)
    this.bindColorAttribute(this.backgroundProgram, "aBackground", CELL_PACKET_OFFSETS.background)
    this.bindColorAttribute(this.backgroundProgram, "aForeground", CELL_PACKET_OFFSETS.foreground)
  }

  private configureCellVao(vao: WebGLVertexArrayObject, program: Program): void {
    const gl = this.gl
    gl.bindVertexArray(vao)
    this.bindUnitAttribute(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.packetBuffer)
    this.bindColorAttribute(program, "aForeground", CELL_PACKET_OFFSETS.foreground)
    this.bindColorAttribute(program, "aBackground", CELL_PACKET_OFFSETS.background)
    this.bindIntegerAttribute(program, "aAtlas", 4, gl.UNSIGNED_SHORT, CELL_PACKET_OFFSETS.atlas)
    this.bindIntegerAttribute(program, "aMetadata", 4, gl.UNSIGNED_BYTE, CELL_PACKET_OFFSETS.metadata)
    this.bindIntegerAttribute(program, "aBearing", 2, gl.SHORT, CELL_PACKET_OFFSETS.bearing)
  }

  private configureDecorationVao(): void {
    const gl = this.gl
    gl.bindVertexArray(this.decorationVao)
    this.bindUnitAttribute(this.decorationProgram)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.packetBuffer)
    this.bindColorAttribute(this.decorationProgram, "aSpecial", CELL_PACKET_OFFSETS.special)
    this.bindIntegerAttribute(this.decorationProgram, "aMetadata", 4, gl.UNSIGNED_BYTE, CELL_PACKET_OFFSETS.metadata)
  }

  private bindUnitAttribute(program: Program): void {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitBuffer)
    const unit = gl.getAttribLocation(program.program, "aUnit")
    if (unit < 0) throw new Error("WebGL unit attribute is missing")
    gl.enableVertexAttribArray(unit)
    gl.vertexAttribPointer(unit, 2, gl.FLOAT, false, 0, 0)
  }

  private bindColorAttribute(program: Program, name: string, offset: number): void {
    const gl = this.gl
    const location = gl.getAttribLocation(program.program, name)
    if (location < 0) throw new Error(`WebGL color attribute is missing: ${name}`)
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, 4, gl.UNSIGNED_BYTE, true, CELL_PACKET_STRIDE, offset)
    gl.vertexAttribDivisor(location, 1)
  }

  private bindIntegerAttribute(program: Program, name: string, size: number, type: GLenum, offset: number): void {
    const gl = this.gl
    const location = gl.getAttribLocation(program.program, name)
    if (location < 0) throw new Error(`WebGL integer attribute is missing: ${name}`)
    gl.enableVertexAttribArray(location)
    gl.vertexAttribIPointer(location, size, type, CELL_PACKET_STRIDE, offset)
    gl.vertexAttribDivisor(location, 1)
  }

  private configureRectVao(vao: WebGLVertexArrayObject, buffer: WebGLBuffer, program: Program): void {
    const gl = this.gl
    gl.bindVertexArray(vao)
    this.bindUnitAttribute(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    const stride = RECT_STRIDE * 4
    const fields: readonly [string, number, number][] = [
      ["aPosition", 2, 0],
      ["aRect", 4, 2],
      ["aColor", 4, 6],
      ["aStyle", 1, 10],
    ]
    for (const [name, size, offset] of fields) {
      const location = gl.getAttribLocation(program.program, name)
      if (location < 0) throw new Error(`WebGL rectangle attribute is missing: ${name}`)
      gl.enableVertexAttribArray(location)
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset * 4)
      gl.vertexAttribDivisor(location, 1)
    }
  }

  private setCellUniforms(program: Program, gridWidth: number): void {
    const gl = this.gl
    gl.useProgram(program.program)
    gl.uniform2f(program.uniforms.viewport, this.pixelWidth, this.pixelHeight)
    gl.uniform2f(program.uniforms.cell, this.cellWidth, this.cellHeight)
    if (program.uniforms.gridWidth) gl.uniform1i(program.uniforms.gridWidth, gridWidth)
    if (program.uniforms.cursor) gl.uniform2i(program.uniforms.cursor, this.cursorCellX, this.cursorCellY)
    if (program.uniforms.cursorInvert) gl.uniform1i(program.uniforms.cursorInvert, this.cursorInvert ? 1 : 0)
  }

  private drawBackgrounds(count: number, gridWidth: number): void {
    if (count === 0) return
    const gl = this.gl
    gl.disable(gl.BLEND)
    this.setCellUniforms(this.backgroundProgram, gridWidth)
    gl.bindVertexArray(this.backgroundVao)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count)
    this.drawCalls += 1
    this.lastFrameDrawCalls += 1
  }

  private drawGlyphs(count: number, gridWidth: number): void {
    if (count === 0) return
    const gl = this.gl
    gl.enable(gl.BLEND)
    this.setCellUniforms(this.glyphProgram, gridWidth)
    if (this.glyphProgram.uniforms.atlas) gl.uniform1i(this.glyphProgram.uniforms.atlas, 0)
    if (this.glyphProgram.uniforms.atlasSize) gl.uniform2f(this.glyphProgram.uniforms.atlasSize, this.atlasSize, this.atlasSize)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTexture)
    gl.bindVertexArray(this.glyphVao)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count)
    this.drawCalls += 1
    this.lastFrameDrawCalls += 1
  }

  private drawDecorations(count: number, gridWidth: number): void {
    if (count === 0) return
    const gl = this.gl
    gl.enable(gl.BLEND)
    this.setCellUniforms(this.decorationProgram, gridWidth)
    gl.bindVertexArray(this.decorationVao)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count)
    this.drawCalls += 1
    this.lastFrameDrawCalls += 1
  }

  private drawCursor(theme: YaadeTheme, model: LineGridModel, frame: GridFrame, focused: boolean): void {
    const mode = frame.cursorMode
    let x = 0
    let y = 0
    let width = 1
    let height = 1
    const fraction = mode.cellPercentage / 100
    if (mode.shape === "vertical") width = fraction
    if (mode.shape === "horizontal") {
      y = 1 - fraction
      height = fraction
    }
    this.cursorData[0] = frame.cursorX
    this.cursorData[1] = frame.cursorY
    this.cursorData[2] = x
    this.cursorData[3] = y
    this.cursorData[4] = width
    this.cursorData[5] = height
    const state = model.state()
    const index = frame.cursorY * frame.width + frame.cursorX
    const colors = resolveNeovimHighlightColors(model.highlight(frame.highlightIds[index] ?? 0), theme, {
      foreground: state.defaultForeground,
      background: state.defaultBackground,
      special: state.defaultSpecial,
    })
    const color = colors.foreground
    this.cursorData[6] = color[0]
    this.cursorData[7] = color[1]
    this.cursorData[8] = color[2]
    this.cursorData[9] = focused ? 0.92 : 1
    this.cursorData[10] = focused ? 0 : 1
    const gl = this.gl
    gl.enable(gl.BLEND)
    this.setCellUniforms(this.cursorProgram, frame.width)
    gl.bindVertexArray(this.cursorVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cursorBuffer)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.cursorData)
    this.bytesUploaded += this.cursorData.byteLength
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1)
    this.drawCalls += 1
    this.lastFrameDrawCalls += 1
  }

  private beginGpuQuery(): void {
    if (!this.timerExtension || this.timerQueries.length === 0 || this.timerInFlight) return
    const query = this.timerQueries[this.timerHead]
    if (!query) return
    this.gl.beginQuery(this.timerExtension.TIME_ELAPSED_EXT, query)
    this.timerInFlight = true
  }

  private endGpuQuery(): void {
    if (!this.timerExtension || !this.timerInFlight) return
    this.gl.endQuery(this.timerExtension.TIME_ELAPSED_EXT)
    this.timerHead = (this.timerHead + 1) % this.timerQueries.length
    this.timerInFlight = false
    this.gpuQueries += 1
  }

  private pollGpuQueries(): void {
    if (!this.timerExtension || this.timerQueries.length === 0) return
    const index = (this.timerHead + this.timerQueries.length - 1) % this.timerQueries.length
    const query = this.timerQueries[index]
    if (!query || this.gl.getParameter(this.timerExtension.GPU_DISJOINT_EXT)) return
    if (this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE) !== true) return
    const nanoseconds = Number(this.gl.getQueryParameter(query, this.gl.QUERY_RESULT))
    if (!Number.isFinite(nanoseconds)) return
    this.lastGpuMs = nanoseconds / 1_000_000
  }
}
