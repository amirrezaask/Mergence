import type { YaadeTheme } from "@yaade/shared"
import { subscribeRootStyle } from "../root-style-observer.js"
import { MsgpackRpcClient, type RpcDiagnostics } from "./rpc.js"
import { encodeNeovimKey, encodeNeovimText, mouseButton, mouseModifier } from "./input.js"
import { LineGridModel } from "./line-grid.js"
import {
  NeovimWebGLRenderer,
  type NeovimRendererDiagnostics,
  type NeovimRenderMetrics,
} from "./webgl-renderer.js"

export type NeovimSurfaceStatus = "starting" | "connecting" | "ready" | "reconnecting" | "failed" | "exited"

export type NeovimFailureCategory = "webgl" | "api" | "protocol" | "channel" | "process" | "host" | "clipboard"

export type NeovimSurfaceLocation = {
  readonly path: string
  readonly line: number
  /** Search columns are one-based UTF-16 character columns at the app boundary. */
  readonly column: number
}

export type NeovimSurfaceDiagnostics = NeovimRendererDiagnostics & {
  readonly status: NeovimSurfaceStatus
  readonly failureCategory: NeovimFailureCategory | null
  readonly generation: number
  readonly connectionEpoch: number
  readonly width: number
  readonly height: number
  readonly protocolError: string | null
  readonly unknownRedrawEvents: number
  readonly malformedRedrawEvents: number
  readonly rejectedBounds: number
  readonly cellsWritten: number
  readonly flushes: number
  readonly coalescedFlushes: number
  readonly scheduledFrames: number
  readonly renderedFrames: number
  readonly lastInputToPaintMs: number
  readonly lastRedrawReduceCpuMs: number
  readonly firstSocketMs: number | null
  readonly firstApiMs: number | null
  readonly firstRedrawMs: number | null
  readonly firstPaintMs: number | null
  readonly rpc: RpcDiagnostics
}

type SurfaceOptions = {
  readonly canvas: HTMLCanvasElement
  readonly input: HTMLTextAreaElement
  readonly toolUseId: string
  readonly generation: number
  readonly theme: YaadeTheme
  readonly fontSize: number
  readonly onStatus?: (status: NeovimSurfaceStatus, error?: string, category?: NeovimFailureCategory) => void
  readonly onNotice?: (message: string) => void
}

type ApiInfo = {
  readonly methods: ReadonlySet<string>
  readonly uiEvents: ReadonlySet<string>
  readonly uiOptions: ReadonlySet<string>
}

type Metrics = NeovimRenderMetrics

type CursorState = {
  readonly x: number
  readonly y: number
  readonly hidden: boolean
}

type GridPoint = {
  readonly row: number
  readonly col: number
}

const MAX_PASTE_BYTES = 2 * 1024 * 1024
const MAX_WHEEL_STEPS = 8
const RECONNECT_BASE_MS = 350
const RECONNECT_MAX_MS = 5_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const MAX_METADATA_ITEMS = 4_096
const MAX_METADATA_NAME_LENGTH = 256

function stringSetFromMetadata(value: unknown, key: string): ReadonlySet<string> {
  if (!isRecord(value) || !Array.isArray(value[key])) return new Set()
  const values = value[key]
  if (values.length > MAX_METADATA_ITEMS) throw new Error(`Neovim API metadata field ${key} is too large`)
  const result = new Set<string>()
  for (const item of values) {
    const name = typeof item === "string" ? item : isRecord(item) && typeof item.name === "string" ? item.name : undefined
    if (name !== undefined) {
      if (name.length > MAX_METADATA_NAME_LENGTH) throw new Error(`Neovim API metadata name in ${key} is too long`)
      result.add(name)
    }
  }
  return result
}

function parseApiInfo(value: unknown): ApiInfo {
  if (!Array.isArray(value) || value.length < 2 || !isRecord(value[1])) {
    throw new Error("Neovim returned malformed API metadata")
  }
  const metadata = value[1]
  return {
    methods: stringSetFromMetadata(metadata, "functions"),
    uiEvents: stringSetFromMetadata(metadata, "ui_events"),
    uiOptions: stringSetFromMetadata(metadata, "ui_options"),
  }
}

const REQUIRED_METHODS = [
  "nvim_set_client_info",
  "nvim_ui_attach",
  "nvim_ui_try_resize",
  "nvim_input",
  "nvim_paste",
  "nvim_input_mouse",
  "nvim_cmd",
  "nvim_win_set_cursor",
  "nvim_exec_lua",
] as const

const REQUIRED_UI_EVENTS = [
  "grid_resize",
  "grid_clear",
  "grid_line",
  "grid_cursor_goto",
  "default_colors_set",
  "hl_attr_define",
  "flush",
] as const

function validateApiInfo(info: ApiInfo): void {
  const missingMethod = REQUIRED_METHODS.find(method => !info.methods.has(method))
  if (missingMethod) throw new Error(`Neovim API is missing required method: ${missingMethod}`)
  const missingEvent = REQUIRED_UI_EVENTS.find(event => !info.uiEvents.has(event))
  if (missingEvent) throw new Error(`Neovim API is missing required UI event: ${missingEvent}`)
  if (!info.uiOptions.has("ext_linegrid")) throw new Error("Neovim API does not advertise ext_linegrid")
}

function webSocketUrl(toolUseId: string, generation: number): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}/ws/neovim/${encodeURIComponent(toolUseId)}?generation=${generation}`
}

const UTF8_ENCODER = new TextEncoder()

function utf8ByteColumn(line: string, characterColumn: number): number {
  let offset = Math.max(0, Math.min(line.length, Math.trunc(characterColumn) - 1))
  if (offset > 0 && offset < line.length) {
    const code = line.charCodeAt(offset)
    if (code >= 0xdc00 && code <= 0xdfff) offset -= 1
  }
  return UTF8_ENCODER.encode(line.slice(0, offset)).byteLength
}

function emptyRpcDiagnostics(): RpcDiagnostics {
  return {
    receivedBytes: 0,
    decodedMessages: 0,
    decodedNotifications: 0,
    decodedResponses: 0,
    decodedServerRequests: 0,
    queuedBytes: 0,
    peakQueuedBytes: 0,
    rejectedFrames: 0,
  }
}

function emptyRendererDiagnostics(themeId: string): NeovimRendererDiagnostics {
  return {
    frames: 0,
    fullFrames: 0,
    dirtyRows: 0,
    dirtyRuns: 0,
    drawCalls: 0,
    lastFrameDrawCalls: 0,
    bytesUploaded: 0,
    cellBytesUploaded: 0,
    atlasBytesUploaded: 0,
    atlasGlyphs: 0,
    atlasLayers: 0,
    atlasRebuilds: 0,
    atlasOccupancy: 0,
    atlasGpuBytes: 0,
    pendingBitmapBytes: 0,
    peakPendingBitmapBytes: 0,
    packetCapacityBytes: 0,
    modelBytes: 0,
    contextLosses: 0,
    lastFrameCpuMs: 0,
    lastPacketBuildCpuMs: 0,
    lastCellUploadCpuMs: 0,
    lastAtlasUploadCpuMs: 0,
    lastDrawSubmitCpuMs: 0,
    lastAtlasRasterCpuMs: 0,
    gpuTimeAvailable: false,
    lastGpuMs: 0,
    gpuQueries: 0,
    themeId,
  }
}

/** Imperative Neovim UI: RPC, line-grid, WebGL, and input never enter React state. */
export class NeovimSurface {
  private readonly model = new LineGridModel()
  private renderer: NeovimWebGLRenderer | undefined
  private rpc: MsgpackRpcClient | undefined
  private socket: WebSocket | undefined
  private resizeObserver: ResizeObserver | undefined
  private unsubscribeRootStyle: (() => void) | undefined
  private resizeFrame: number | undefined
  private renderFrame: number | undefined
  private renderFullRequested = false
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private cursorBlinkTimer: ReturnType<typeof setTimeout> | undefined
  private visualBellTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private visible = true
  private focused = false
  private connected = false
  private fatalConnection = false
  private online = typeof navigator === "undefined" || navigator.onLine !== false
  private apiInfo: ApiInfo = { methods: new Set(), uiEvents: new Set(), uiOptions: new Set() }
  private status: NeovimSurfaceStatus = "starting"
  private failureCategory: NeovimFailureCategory | null = null
  private protocolError: string | null = null
  private contextLosses = 0
  private cursorPhaseVisible = true
  private visualBellActive = false
  private lastVisualBell = 0
  private pointerButton: "left" | "right" | "middle" | "wheel" = "left"
  private requestedFontKey = ""
  private loadedFontKey = ""
  private generation: number
  private theme: YaadeTheme
  private fontSize: number
  private metrics: Metrics = {
    cellWidth: 8,
    cellHeight: 16,
    baseline: 13,
    fontSize: 13,
    fontFamily: "ui-monospace, monospace",
    pixelRatio: 1,
  }
  private dims = { cols: 1, rows: 1 }
  private composing = false
  private suppressInput = ""
  private connectionEpoch = 0
  private reconnectAttempt = 0
  private scheduledFrames = 0
  private renderedFrames = 0
  private flushes = 0
  private coalescedFlushes = 0
  private pendingInputAt: number | undefined
  private lastInputToPaintMs = 0
  private lastRedrawReduceCpuMs = 0
  private testPaintWaiter: {
    readonly baseFlushes: number
    readonly resolve: (elapsedMs: number) => void
    readonly reject: (error: Error) => void
    readonly timer: ReturnType<typeof setTimeout>
    readonly startedAt: number
  } | undefined
  private mountAt = performance.now()
  private firstSocketMs: number | null = null
  private firstApiMs: number | null = null
  private firstRedrawMs: number | null = null
  private firstPaintMs: number | null = null
  private lastRpcDiagnostics = emptyRpcDiagnostics()
  private readonly measureCanvas: HTMLCanvasElement
  private readonly measureContext: CanvasRenderingContext2D | null
  private readonly readyWaiters = new Set<{
    readonly resolve: () => void
    readonly reject: (error: Error) => void
    readonly timer: ReturnType<typeof setTimeout>
  }>()

  constructor(private readonly options: SurfaceOptions) {
    this.generation = options.generation
    this.theme = options.theme
    this.fontSize = options.fontSize
    this.measureCanvas = document.createElement("canvas")
    this.measureContext = this.measureCanvas.getContext("2d")
  }

  mount(): void {
    if (this.disposed) return
    this.options.canvas.tabIndex = 0
    this.options.input.autocapitalize = "off"
    this.options.input.autocomplete = "off"
    this.options.input.autocorrect = false
    this.options.input.spellcheck = false
    this.options.input.addEventListener("keydown", this.onKeyDown)
    this.options.input.addEventListener("input", this.onInput)
    this.options.input.addEventListener("paste", this.onPaste)
    this.options.input.addEventListener("compositionstart", this.onCompositionStart)
    this.options.input.addEventListener("compositionend", this.onCompositionEnd)
    this.options.input.addEventListener("focus", this.onInputFocus)
    this.options.input.addEventListener("blur", this.onInputBlur)
    this.options.canvas.addEventListener("pointerdown", this.onPointerDown)
    this.options.canvas.addEventListener("pointermove", this.onPointerMove)
    this.options.canvas.addEventListener("pointerup", this.onPointerUp)
    this.options.canvas.addEventListener("pointercancel", this.onPointerUp)
    this.options.canvas.addEventListener("wheel", this.onWheel, { passive: false })
    this.options.canvas.addEventListener("click", this.onCanvasClick)
    this.options.canvas.addEventListener("contextmenu", this.onContextMenu)
    this.options.canvas.addEventListener("webglcontextlost", this.onContextLost)
    this.options.canvas.addEventListener("webglcontextrestored", this.onContextRestored)
    window.addEventListener("resize", this.onWindowResize)
    window.addEventListener("online", this.onOnline)
    window.addEventListener("offline", this.onOffline)
    document.addEventListener("visibilitychange", this.onVisibilityChange)
    this.resizeObserver = new ResizeObserver(() => this.scheduleResize())
    this.resizeObserver.observe(this.options.canvas)
    this.unsubscribeRootStyle = subscribeRootStyle(() => this.scheduleResize())
    try {
      this.renderer = new NeovimWebGLRenderer(this.options.canvas)
    } catch (error) {
      this.setFailed("webgl", error instanceof Error ? error.message : String(error))
      return
    }
    this.resize()
    this.connect(false)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const disposedError = new Error("Neovim surface was disposed")
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(disposedError)
    }
    this.readyWaiters.clear()
    if (this.testPaintWaiter) {
      clearTimeout(this.testPaintWaiter.timer)
      this.testPaintWaiter.reject(disposedError)
      this.testPaintWaiter = undefined
    }
    if (this.resizeFrame !== undefined) cancelAnimationFrame(this.resizeFrame)
    if (this.renderFrame !== undefined) cancelAnimationFrame(this.renderFrame)
    this.clearReconnectTimer()
    if (this.cursorBlinkTimer) clearTimeout(this.cursorBlinkTimer)
    if (this.visualBellTimer) clearTimeout(this.visualBellTimer)
    this.resizeObserver?.disconnect()
    this.unsubscribeRootStyle?.()
    this.closeConnection()
    this.renderer?.dispose()
    this.renderer = undefined
    const canvas = this.options.canvas
    const input = this.options.input
    input.removeEventListener("keydown", this.onKeyDown)
    input.removeEventListener("input", this.onInput)
    input.removeEventListener("paste", this.onPaste)
    input.removeEventListener("compositionstart", this.onCompositionStart)
    input.removeEventListener("compositionend", this.onCompositionEnd)
    input.removeEventListener("focus", this.onInputFocus)
    input.removeEventListener("blur", this.onInputBlur)
    canvas.removeEventListener("pointerdown", this.onPointerDown)
    canvas.removeEventListener("pointermove", this.onPointerMove)
    canvas.removeEventListener("pointerup", this.onPointerUp)
    canvas.removeEventListener("pointercancel", this.onPointerUp)
    canvas.removeEventListener("wheel", this.onWheel)
    canvas.removeEventListener("click", this.onCanvasClick)
    canvas.removeEventListener("contextmenu", this.onContextMenu)
    canvas.removeEventListener("webglcontextlost", this.onContextLost)
    canvas.removeEventListener("webglcontextrestored", this.onContextRestored)
    window.removeEventListener("resize", this.onWindowResize)
    window.removeEventListener("online", this.onOnline)
    window.removeEventListener("offline", this.onOffline)
    document.removeEventListener("visibilitychange", this.onVisibilityChange)
  }

  updateTheme(theme: YaadeTheme, fontSize: number): void {
    this.theme = theme
    this.fontSize = fontSize
    this.scheduleResize()
    this.scheduleRender(true)
  }

  updateGeneration(generation: number): void {
    if (generation === this.generation) return
    this.generation = generation
    this.fatalConnection = false
    this.failureCategory = null
    this.protocolError = null
    this.reconnectAttempt = 0
    this.model.reset()
    this.closeConnection()
    this.connect(false)
  }

  /** Retry a channel or renderer failure without replacing the host process. */
  retry(): void {
    if (this.disposed) return
    try {
      if (!this.renderer) this.renderer = new NeovimWebGLRenderer(this.options.canvas)
      this.model.requestFullRepaint()
      this.scheduleResize()
    } catch (error) {
      this.setFailed("webgl", error instanceof Error ? error.message : String(error))
      return
    }
    this.fatalConnection = false
    this.failureCategory = null
    this.protocolError = null
    this.reconnectAttempt = 0
    this.closeConnection()
    this.connect(false)
  }

  setVisible(visible: boolean): void {
    const becameVisible = visible && !this.visible
    this.visible = visible
    if (!visible && this.cursorBlinkTimer) {
      clearTimeout(this.cursorBlinkTimer)
      this.cursorBlinkTimer = undefined
    }
    if (becameVisible) {
      this.model.requestFullRepaint()
      this.scheduleRender(true)
      this.restartCursorBlink()
      if (!this.socket && !this.fatalConnection) this.connect(true)
    }
  }

  focus(): void {
    this.options.input.focus({ preventScroll: true })
  }

  sendLiteralControl(value: string): void {
    this.markInput()
    this.rpc?.notify("nvim_input", [value])
  }

  /** Test/benchmark hook: the elapsed value is measured entirely in-page. */
  async dispatchTestInput(value: string): Promise<number> {
    await this.waitForConnection()
    const rpc = this.rpc
    if (!rpc || !this.connected) throw new Error("Neovim UI is not connected")
    if (this.testPaintWaiter) throw new Error("a Neovim test input is already pending")
    const baseFlushes = this.flushes
    const startedAt = performance.now()
    this.markInput()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.testPaintWaiter || this.testPaintWaiter.baseFlushes !== baseFlushes) return
        this.testPaintWaiter = undefined
        reject(new Error("Neovim test input did not reach a painted flush"))
      }, 10_000)
      this.testPaintWaiter = { baseFlushes, resolve, reject, timer, startedAt }
      rpc.notify("nvim_input", [value])
    })
  }

  async openLocation(location: NeovimSurfaceLocation): Promise<void> {
    const path = location.path
    const line = Math.max(1, Math.trunc(location.line))
    const column = Math.max(1, Math.trunc(location.column))
    if (!this.connected || !this.rpc) await this.waitForConnection()
    const rpc = this.rpc
    if (!this.connected || !rpc) throw new Error("Neovim UI is not connected")
    if (!this.apiInfo.methods.has("nvim_cmd")) throw new Error("Neovim does not support structured commands")
    await rpc.request("nvim_cmd", [{ cmd: "edit", args: [path], range: [], bang: false }, { output: false }])
    let byteColumn = column - 1
    if (this.apiInfo.methods.has("nvim_buf_get_lines")) {
      const rawLines = await rpc.request("nvim_buf_get_lines", [0, line - 1, line, false])
      if (!Array.isArray(rawLines) || typeof rawLines[0] !== "string") {
        throw new Error("Neovim returned a malformed line while opening a Search result")
      }
      byteColumn = utf8ByteColumn(rawLines[0], column)
    }
    await rpc.request("nvim_win_set_cursor", [0, [line, byteColumn]])
  }

  getText(): string {
    return this.model.text()
  }

  getCursor(): CursorState {
    const state = this.model.state()
    return { x: state.cursorX, y: state.cursorY, hidden: !state.cursorVisible }
  }

  getDims(): { readonly cols: number; readonly rows: number } {
    return this.dims
  }

  getDiagnostics(): NeovimSurfaceDiagnostics {
    const renderer = this.renderer?.diagnostics() ?? emptyRendererDiagnostics(this.theme.id)
    const model = this.model.diagnostics()
    const rpc = this.rpc?.diagnostics() ?? this.lastRpcDiagnostics
    return {
      ...renderer,
      contextLosses: this.contextLosses + renderer.contextLosses,
      status: this.status,
      failureCategory: this.failureCategory,
      generation: this.generation,
      connectionEpoch: this.connectionEpoch,
      width: this.model.state().width,
      height: this.model.state().height,
      protocolError: this.protocolError,
      unknownRedrawEvents: model.unknownEvents,
      malformedRedrawEvents: model.malformedEvents,
      rejectedBounds: model.rejectedBounds,
      cellsWritten: model.cellsWritten,
      flushes: this.flushes,
      coalescedFlushes: this.coalescedFlushes,
      scheduledFrames: this.scheduledFrames,
      renderedFrames: this.renderedFrames,
      lastInputToPaintMs: this.lastInputToPaintMs,
      lastRedrawReduceCpuMs: this.lastRedrawReduceCpuMs,
      firstSocketMs: this.firstSocketMs,
      firstApiMs: this.firstApiMs,
      firstRedrawMs: this.firstRedrawMs,
      firstPaintMs: this.firstPaintMs,
      rpc,
    }
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.composing) return
    const key = event.key.toLowerCase()
    const mac = /Mac|iPhone|iPad/u.test(navigator.platform)
    const copyChord = key === "c" && (mac ? event.metaKey : event.ctrlKey) && !event.altKey
    if (copyChord && /visual|select/iu.test(this.model.state().mode)) {
      event.preventDefault()
      void this.copyVisualSelection().catch(error => {
        this.showNotice(`Copy unavailable: ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }
    if ((event.metaKey && key === "v") || (event.ctrlKey && event.shiftKey && key === "v")) {
      // Let the browser deliver paste to the hidden textarea.
      return
    }
    const notation = encodeNeovimKey({
      key: event.key,
      isComposing: event.isComposing,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altGraphKey: event.getModifierState("AltGraph"),
      platform: navigator.platform,
    })
    if (notation.kind === "browser-action" || !notation.value) return
    event.preventDefault()
    this.markInput()
    this.rpc?.notify("nvim_input", [notation.value])
  }

  private readonly onInput = (event: Event): void => {
    const input = event.currentTarget
    if (!(input instanceof HTMLTextAreaElement)) return
    const text = input.value
    if (!text || this.composing) return
    input.value = ""
    if (this.suppressInput) {
      const duplicate = this.suppressInput === text
      this.suppressInput = ""
      if (duplicate) return
    }
    if (UTF8_ENCODER.encode(text).byteLength > MAX_PASTE_BYTES) {
      this.showNotice("Text input exceeds the 2 MiB Neovim channel limit")
      return
    }
    this.markInput()
    this.rpc?.notify("nvim_input", [encodeNeovimText(text)])
  }

  private readonly onPaste = (event: ClipboardEvent): void => {
    const text = event.clipboardData?.getData("text/plain") ?? ""
    if (!text) return
    event.preventDefault()
    this.options.input.value = ""
    if (UTF8_ENCODER.encode(text).byteLength > MAX_PASTE_BYTES) {
      this.showNotice("Clipboard text exceeds the 2 MiB Neovim channel limit")
      return
    }
    this.markInput()
    this.rpc?.notify("nvim_paste", [text, false, -1])
  }

  private readonly onCompositionStart = (): void => {
    this.composing = true
  }

  private readonly onCompositionEnd = (): void => {
    this.composing = false
    const text = this.options.input.value
    if (!text) return
    this.options.input.value = ""
    this.suppressInput = text
    if (UTF8_ENCODER.encode(text).byteLength > MAX_PASTE_BYTES) {
      this.showNotice("Composed text exceeds the 2 MiB Neovim channel limit")
      return
    }
    this.markInput()
    this.rpc?.notify("nvim_input", [encodeNeovimText(text)])
  }

  private readonly onInputFocus = (): void => {
    this.focused = true
    this.sendFocus(true)
    this.restartCursorBlink()
    this.model.requestCursorRepaint()
    this.scheduleRender(false)
  }

  private readonly onInputBlur = (): void => {
    this.focused = false
    this.sendFocus(false)
    this.cursorPhaseVisible = true
    if (this.cursorBlinkTimer) clearTimeout(this.cursorBlinkTimer)
    this.cursorBlinkTimer = undefined
    this.model.requestCursorRepaint()
    this.scheduleRender(false)
  }

  private readonly onWindowResize = (): void => this.scheduleResize()

  private readonly onOnline = (): void => {
    this.online = true
    if (!this.socket && !this.fatalConnection) this.connect(true)
  }

  private readonly onOffline = (): void => {
    this.online = false
    this.clearReconnectTimer()
    if (!this.disposed) this.setStatus("reconnecting", "Waiting for the network", "channel")
  }

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === "visible" && this.visible && !this.socket && !this.fatalConnection) this.connect(true)
  }

  private readonly onCanvasClick = (): void => this.focus()

  private readonly onContextMenu = (event: MouseEvent): void => {
    // The browser context menu keeps consuming keyboard input after a
    // right-click, even though the hidden textarea still reports focus. A
    // Neovim surface has no useful browser menu; route the gesture to Neovim
    // (when enabled) and keep keyboard focus in the surface.
    event.preventDefault()
    this.focus()
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.focus()
    if (!this.model.state().mouseEnabled) return
    this.options.canvas.setPointerCapture(event.pointerId)
    this.pointerButton = mouseButton(event.button)
    this.markInput()
    this.sendMouse(event, "press", this.pointerButton)
    event.preventDefault()
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.buttons === 0 || !this.model.state().mouseEnabled) return
    this.markInput()
    this.sendMouse(event, "drag", this.pointerButton)
    event.preventDefault()
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.model.state().mouseEnabled) return
    if (this.options.canvas.hasPointerCapture(event.pointerId)) this.options.canvas.releasePointerCapture(event.pointerId)
    this.markInput()
    this.sendMouse(event, "release", this.pointerButton)
    event.preventDefault()
  }

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.model.state().mouseEnabled) return
    const { row, col } = this.gridPoint(event.clientX, event.clientY)
    const lineDelta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 1 : this.metrics.cellHeight
    const vertical = Math.abs(event.deltaY) / Math.max(1, lineDelta)
    const horizontal = Math.abs(event.deltaX) / Math.max(1, this.metrics.cellWidth)
    const sendSteps = (axis: "vertical" | "horizontal", amount: number, direction: 1 | -1) => {
      const steps = Math.max(1, Math.min(MAX_WHEEL_STEPS, Math.round(amount)))
      const action = axis === "vertical" ? (direction < 0 ? "up" : "down") : (direction < 0 ? "left" : "right")
      for (let index = 0; index < steps; index += 1) {
        this.rpc?.notify("nvim_input_mouse", ["wheel", action, mouseModifier(event), 1, row, col])
      }
    }
    if (vertical > 0) {
      this.markInput()
      sendSteps("vertical", vertical, event.deltaY < 0 ? -1 : 1)
    }
    if (horizontal > 0) {
      this.markInput()
      sendSteps("horizontal", horizontal, event.deltaX < 0 ? -1 : 1)
    }
    event.preventDefault()
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault()
    this.contextLosses += 1
    this.renderer?.dispose()
    this.renderer = undefined
    this.model.requestFullRepaint()
    this.setFailed("webgl", "WebGL context lost; retry to rebuild the renderer")
  }

  private readonly onContextRestored = (): void => {
    try {
      this.renderer = new NeovimWebGLRenderer(this.options.canvas)
      this.failureCategory = null
      this.fatalConnection = false
      this.model.requestFullRepaint()
      this.scheduleResize()
      this.scheduleRender(true)
      this.setStatus(this.connected ? "ready" : "reconnecting")
    } catch (error) {
      this.setFailed("webgl", error instanceof Error ? error.message : String(error))
    }
  }

  private async copyVisualSelection(): Promise<void> {
    const rpc = this.rpc
    if (!rpc || !this.connected || !this.apiInfo.methods.has("nvim_exec_lua")) {
      throw new Error("Neovim visual selection is unavailable")
    }
    const source = [
      "local first = vim.fn.getpos(\"'<\")",
      "local last = vim.fn.getpos(\"'>\")",
      "local lines = vim.fn.getregion(first, last, { type = vim.fn.visualmode() })",
      "return table.concat(lines, '\\n')",
    ].join("; ")
    const selected = await rpc.request("nvim_exec_lua", [source, []])
    if (typeof selected !== "string") throw new Error("Neovim returned no visual selection")
    await navigator.clipboard.writeText(selected)
    this.showNotice("Selection copied")
  }

  private sendFocus(focused: boolean): void {
    const rpc = this.rpc
    if (!rpc || !this.connected || !this.apiInfo.methods.has("nvim_ui_set_focus")) return
    void rpc.request("nvim_ui_set_focus", [focused]).catch(error => {
      this.showNotice(`Neovim focus update failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private sendMouse(event: PointerEvent, action: "press" | "release" | "drag", button: string): void {
    const { row, col } = this.gridPoint(event.clientX, event.clientY)
    this.rpc?.notify("nvim_input_mouse", [button, action, mouseModifier(event), 1, row, col])
  }

  private gridPoint(clientX: number, clientY: number): GridPoint {
    const rect = this.options.canvas.getBoundingClientRect()
    const col = Math.max(0, Math.min(this.dims.cols - 1, Math.floor((clientX - rect.left) / this.metrics.cellWidth)))
    const row = Math.max(0, Math.min(this.dims.rows - 1, Math.floor((clientY - rect.top) / this.metrics.cellHeight)))
    return { row, col }
  }

  private scheduleResize(): void {
    if (this.disposed || this.resizeFrame !== undefined) return
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = undefined
      this.resize()
    })
  }

  private resize(): void {
    const rect = this.options.canvas.getBoundingClientRect()
    const root = document.documentElement
    const computed = getComputedStyle(root)
    const fontFamily = computed.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace"
    const configuredLineHeight = Number.parseFloat(computed.getPropertyValue("--yaade-editor-line-height"))
    const lineHeightScale = Number.isFinite(configuredLineHeight) && configuredLineHeight > 0 ? configuredLineHeight : 1
    const lineHeight = this.fontSize * lineHeightScale
    const font = `${this.fontSize}px ${fontFamily}`
    this.ensureFontLoaded(fontFamily)
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const snapCss = (value: number): number => Math.max(1, Math.round(Math.max(1, value) * dpr) / dpr)
    const context = this.measureContext
    if (context) {
      context.font = font
      const measurement = context.measureText("M")
      const ascent = measurement.actualBoundingBoxAscent
      const descent = measurement.actualBoundingBoxDescent
      const cellWidth = snapCss(measurement.width)
      const cellHeight = snapCss(lineHeight)
      const measuredBaseline = Number.isFinite(ascent) && Number.isFinite(descent)
        ? (cellHeight + ascent - descent) / 2
        : cellHeight * 0.8
      this.metrics = {
        cellWidth,
        cellHeight,
        baseline: snapCss(measuredBaseline),
        fontSize: this.fontSize,
        fontFamily,
        pixelRatio: dpr,
      }
    } else {
      this.metrics = {
        cellWidth: snapCss(this.fontSize * 0.6),
        cellHeight: snapCss(lineHeight),
        baseline: snapCss(lineHeight * 0.8),
        fontSize: this.fontSize,
        fontFamily,
        pixelRatio: dpr,
      }
    }
    const cssWidth = Math.max(1, rect.width)
    const cssHeight = Math.max(1, rect.height)
    this.renderer?.setViewport(Math.ceil(cssWidth * dpr), Math.ceil(cssHeight * dpr), this.metrics.cellWidth, this.metrics.cellHeight, dpr)
    this.scheduleRender(true)
    const nextDims = {
      cols: Math.max(1, Math.floor(cssWidth / this.metrics.cellWidth)),
      rows: Math.max(1, Math.floor(cssHeight / this.metrics.cellHeight)),
    }
    if (nextDims.cols === this.dims.cols && nextDims.rows === this.dims.rows) return
    this.dims = nextDims
    if (this.rpc && this.connected) void this.rpc.request("nvim_ui_try_resize", [nextDims.cols, nextDims.rows]).catch(() => undefined)
  }

  private ensureFontLoaded(fontFamily: string): void {
    const key = `${this.fontSize}px ${fontFamily}`
    if (key === this.loadedFontKey || key === this.requestedFontKey || !document.fonts) return
    this.requestedFontKey = key
    const variants = [
      `${this.fontSize}px ${fontFamily}`,
      `italic ${this.fontSize}px ${fontFamily}`,
      `700 ${this.fontSize}px ${fontFamily}`,
      `italic 700 ${this.fontSize}px ${fontFamily}`,
    ]
    void Promise.all(variants.map(font => document.fonts.load(font))).then(() => {
      if (this.disposed || this.requestedFontKey !== key) return
      this.loadedFontKey = key
      this.requestedFontKey = ""
      this.scheduleResize()
    }).catch(() => {
      if (this.requestedFontKey === key) this.requestedFontKey = ""
    })
  }

  private positionInputAtCursor(): void {
    const state = this.model.state()
    const maxX = Math.max(0, this.options.canvas.clientWidth - 1)
    const maxY = Math.max(0, this.options.canvas.clientHeight - 1)
    const x = Math.min(maxX, Math.max(0, state.cursorX * this.metrics.cellWidth))
    const y = Math.min(maxY, Math.max(0, (state.cursorY + 1) * this.metrics.cellHeight))
    this.options.input.style.transform = `translate(${x}px, ${y}px)`
  }

  private activateVisualBell(): void {
    if (this.visualBellTimer) clearTimeout(this.visualBellTimer)
    this.visualBellActive = true
    this.model.requestFullRepaint()
    this.scheduleRender(true)
    const value = getComputedStyle(document.documentElement).getPropertyValue("--yaade-motion-fast").trim()
    const numeric = Number.parseFloat(value)
    const duration = Number.isFinite(numeric) ? numeric * (value.endsWith("s") && !value.endsWith("ms") ? 1_000 : 1) : 0
    this.visualBellTimer = setTimeout(() => {
      this.visualBellTimer = undefined
      this.visualBellActive = false
      this.model.requestFullRepaint()
      this.scheduleRender(true)
    }, Math.max(0, duration))
  }

  private restartCursorBlink(): void {
    if (this.cursorBlinkTimer) clearTimeout(this.cursorBlinkTimer)
    this.cursorBlinkTimer = undefined
    this.cursorPhaseVisible = true
    const mode = this.model.state().cursorMode
    if (!this.focused || !this.visible || mode.blinkOnMs <= 0 || mode.blinkOffMs <= 0) return
    const toggle = () => {
      if (this.disposed || !this.focused || !this.visible) return
      this.cursorPhaseVisible = !this.cursorPhaseVisible
      this.model.requestCursorRepaint()
      this.scheduleRender(false)
      const delay = this.cursorPhaseVisible ? mode.blinkOnMs : mode.blinkOffMs
      this.cursorBlinkTimer = setTimeout(toggle, delay)
    }
    this.cursorBlinkTimer = setTimeout(toggle, mode.blinkWaitMs)
  }

  private scheduleRender(fullRepaint: boolean): void {
    this.renderFullRequested ||= fullRepaint
    if (this.disposed || !this.visible || !this.renderer || this.renderFrame !== undefined) return
    this.scheduledFrames += 1
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = undefined
      if (!this.renderer || !this.visible) return
      const requestedFullRepaint = this.renderFullRequested
      this.renderFullRequested = false
      this.model.consumeFullRepaint()
      try {
        this.renderer.render(
          this.model,
          this.theme,
          this.metrics,
          requestedFullRepaint,
          this.cursorPhaseVisible,
          this.focused,
          this.visualBellActive,
        )
        this.renderedFrames += 1
        const now = performance.now()
        if (this.firstPaintMs === null && this.firstRedrawMs !== null) {
          this.firstPaintMs = now - this.mountAt
          performance.mark(`yaade:neovim-first-paint:${this.options.toolUseId}`)
        }
        if (this.pendingInputAt !== undefined) {
          this.lastInputToPaintMs = now - this.pendingInputAt
          this.pendingInputAt = undefined
        }
        const waiter = this.testPaintWaiter
        if (waiter && this.flushes > waiter.baseFlushes) {
          clearTimeout(waiter.timer)
          this.testPaintWaiter = undefined
          waiter.resolve(now - waiter.startedAt)
        }
        this.positionInputAtCursor()
      } catch (error) {
        this.setFailed("webgl", error instanceof Error ? error.message : String(error))
      }
    })
  }

  private connect(reconnecting: boolean): void {
    if (this.disposed || this.fatalConnection || !this.visible || !this.online || document.visibilityState === "hidden") return
    if (this.socket || this.rpc) return
    this.clearReconnectTimer()
    const epoch = ++this.connectionEpoch
    if (reconnecting) this.setStatus("reconnecting")
    else this.setStatus("connecting")
    const socket = new WebSocket(webSocketUrl(this.options.toolUseId, this.generation))
    socket.binaryType = "arraybuffer"
    const isCurrent = (): boolean => !this.disposed && this.connectionEpoch === epoch && this.socket === socket
    const rpc = new MsgpackRpcClient({
      send: bytes => {
        if (!isCurrent() || socket.readyState !== WebSocket.OPEN) throw new Error("Neovim socket is not open")
        const copy = new ArrayBuffer(bytes.byteLength)
        new Uint8Array(copy).set(bytes)
        socket.send(copy)
      },
      onNotification: notification => {
        if (!isCurrent() || notification.method !== "redraw") return
        try {
          const reduceStarted = performance.now()
          const result = this.model.applyRedraw(notification.args)
          this.lastRedrawReduceCpuMs = performance.now() - reduceStarted
          this.flushes += result.flushes
          this.coalescedFlushes += Math.max(0, result.flushes - 1)
          if (result.flushes > 0) {
            if (this.firstRedrawMs === null) this.firstRedrawMs = performance.now() - this.mountAt
            this.reconnectAttempt = 0
            this.failureCategory = null
            this.setStatus("ready")
            if (result.visualBellChanged) {
              this.lastVisualBell = result.visualBell
              this.activateVisualBell()
            }
            this.restartCursorBlink()
            this.scheduleRender(false)
          }
        } catch (error) {
          if (!isCurrent()) return
          this.fatalConnection = true
          this.protocolError = error instanceof Error ? error.message : String(error)
          this.setFailed("protocol", this.protocolError)
          socket.close(4002, "malformed Neovim redraw")
        }
      },
      onError: error => {
        if (!isCurrent()) return
        const message = error.message
        const category: NeovimFailureCategory = /Malformed|Unknown Neovim RPC|redraw/u.test(message) ? "protocol" : "channel"
        if (category === "protocol") this.protocolError = message
        if (category === "protocol") this.setFailed(category, message)
        else this.setTemporaryFailure(message)
      },
    })
    this.socket = socket
    this.rpc = rpc
    let receiveChain = Promise.resolve()
    socket.addEventListener("open", () => {
      if (!isCurrent()) return
      if (this.firstSocketMs === null) this.firstSocketMs = performance.now() - this.mountAt
      void this.attach(epoch, socket, rpc)
    })
    socket.addEventListener("message", event => {
      if (!isCurrent()) return
      receiveChain = receiveChain
        .then(() => this.receiveSocketData(rpc, event.data, epoch))
        .catch(error => {
          if (isCurrent()) {
            rpc.close(error instanceof Error ? error : new Error(String(error)))
          }
        })
    })
    socket.addEventListener("error", () => {
      if (isCurrent() && !this.disposed) this.setTemporaryFailure("Neovim channel error")
    })
    socket.addEventListener("close", event => {
      this.lastRpcDiagnostics = rpc.diagnostics()
      rpc.close(new Error("Neovim socket closed"))
      if (!isCurrent()) return
      this.connected = false
      this.socket = undefined
      this.rpc = undefined
      if (this.fatalConnection) return
      const detail = event.reason ? `Neovim channel closed (${event.code}: ${event.reason})` : `Neovim channel closed (${event.code})`
      this.setStatus("reconnecting", detail, "channel")
      this.scheduleReconnect()
    })
  }

  private async attach(epoch: number, socket: WebSocket, rpc: MsgpackRpcClient): Promise<void> {
    const isCurrent = (): boolean => !this.disposed && this.connectionEpoch === epoch && this.socket === socket && this.rpc === rpc
    try {
      const info = await rpc.request("nvim_get_api_info", [])
      if (!isCurrent()) return
      this.apiInfo = parseApiInfo(info)
      validateApiInfo(this.apiInfo)
      if (this.firstApiMs === null) this.firstApiMs = performance.now() - this.mountAt
      await rpc.request("nvim_set_client_info", ["yaade", { major: 0, minor: 2, patch: 0, prerelease: true }, "ui", {}, { website: "local" }])
      const options = {
        rgb: true,
        ext_linegrid: true,
        ext_hlstate: this.apiInfo.uiOptions.has("ext_hlstate"),
        ext_multigrid: false,
        ext_cmdline: false,
        ext_popupmenu: false,
        ext_messages: false,
        ext_tabline: false,
      }
      await rpc.request("nvim_ui_attach", [this.dims.cols, this.dims.rows, options])
      if (!isCurrent()) return
      this.connected = true
      this.failureCategory = null
      this.resolveConnectionWaiters()
      this.scheduleResize()
      this.sendFocus(this.focused)
    } catch (error) {
      if (!isCurrent() || this.disposed) return
      const message = error instanceof Error ? error.message : String(error)
      const category: NeovimFailureCategory = /missing required|malformed API|API metadata|metadata field|ext_linegrid|does not support/u.test(message) ? "api" : "channel"
      if (category === "api") this.setFailed(category, message)
      else this.setTemporaryFailure(message)
      socket.close()
    }
  }

  private async receiveSocketData(rpc: MsgpackRpcClient, data: unknown, epoch: number): Promise<void> {
    if (epoch !== this.connectionEpoch || this.disposed) return
    if (data instanceof ArrayBuffer) {
      rpc.receive(data)
      return
    }
    if (data instanceof Blob) {
      const bytes = await data.arrayBuffer()
      if (epoch === this.connectionEpoch && !this.disposed) rpc.receive(bytes)
      return
    }
    if (typeof data === "string") throw new Error("Neovim socket returned a text frame")
    throw new Error("Neovim socket returned an unsupported message type")
  }

  private closeConnection(): void {
    this.connectionEpoch += 1
    this.clearReconnectTimer()
    this.connected = false
    const rpc = this.rpc
    const socket = this.socket
    if (rpc && this.apiInfo.methods.has("nvim_ui_detach") && socket?.readyState === WebSocket.OPEN) rpc.notify("nvim_ui_detach", [])
    if (rpc) this.lastRpcDiagnostics = rpc.diagnostics()
    rpc?.close()
    this.rpc = undefined
    this.socket = undefined
    socket?.close()
  }

  private setStatus(status: NeovimSurfaceStatus, error?: string, category?: NeovimFailureCategory): void {
    this.status = status
    if (category !== undefined) this.failureCategory = category
    this.options.onStatus?.(status, error, category)
  }

  private setTemporaryFailure(error: string): void {
    if (this.disposed || this.fatalConnection) return
    this.failureCategory = "channel"
    this.setStatus("reconnecting", error, "channel")
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.fatalConnection || !this.visible || !this.online || document.visibilityState === "hidden" || this.reconnectTimer !== undefined) return
    const attempt = this.reconnectAttempt
    this.reconnectAttempt = Math.min(attempt + 1, 8)
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)
    const jitter = 0.8 + Math.random() * 0.4
    const epoch = this.connectionEpoch
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.connectionEpoch !== epoch || this.disposed) return
      this.connect(true)
    }, Math.round(base * jitter))
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  private waitForConnection(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Neovim surface was disposed"))
    if (this.fatalConnection) return Promise.reject(new Error(this.protocolError ?? "Neovim UI is unavailable"))
    if (this.connected && this.rpc) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          this.readyWaiters.delete(waiter)
          resolve()
        },
        reject: (error: Error) => {
          this.readyWaiters.delete(waiter)
          reject(error)
        },
        timer: setTimeout(() => {
          this.readyWaiters.delete(waiter)
          reject(new Error("Neovim UI did not become ready"))
        }, 15_000),
      }
      this.readyWaiters.add(waiter)
    })
  }

  private resolveConnectionWaiters(): void {
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
  }

  private setFailed(category: NeovimFailureCategory, error: string): void {
    this.fatalConnection = category !== "channel" && category !== "clipboard"
    this.failureCategory = category
    if (category === "protocol" || category === "api") this.protocolError = error
    const failure = new Error(error)
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(failure)
    }
    if (this.testPaintWaiter && category !== "channel") {
      clearTimeout(this.testPaintWaiter.timer)
      this.testPaintWaiter.reject(failure)
      this.testPaintWaiter = undefined
    }
    this.setStatus("failed", error, category)
  }

  private markInput(): void {
    this.pendingInputAt = performance.now()
  }

  private showNotice(message: string): void {
    this.options.onNotice?.(message)
  }
}
