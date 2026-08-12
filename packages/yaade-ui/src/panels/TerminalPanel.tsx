import { useEffect, useRef, useState } from "react"
import { RotateCcw, Terminal as TerminalIcon, X } from "lucide-react"
import { Terminal as XTerm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import type { YaadeTheme } from "@yaade/shared"
import "@xterm/xterm/css/xterm.css"
import { subscribeRootStyle } from "./root-style-observer.js"
import { Button } from "../components/ui/button.js"
import { Spinner } from "../components/ui/spinner.js"
import { TerminalScrollMotion } from "./terminal-scroll-motion.js"
import {
  createTerminalOscLinkHandler,
  registerTerminalPathLinks,
  registerTerminalUrlLinks,
} from "./terminal-links.js"
import { createTerminalInputWriter } from "./terminal-input-writer.js"
import { createTerminalOutputWriter } from "./terminal-output-writer.js"
import { attachTerminalGpuRenderer } from "./terminal-gpu-renderer.js"
import {
  getRegisteredTerminal,
  registerTerminalInstance,
  unregisterTerminalInstance,
} from "./terminal-instance-registry.js"

export type TerminalPanelProps = {
  cwdRootUri: string
  launchCommand?: string
  launchArgs?: string[]
  launchEnv?: Record<string, string>
  /** Persisted output rendered for an archived session without attaching a PTY. */
  initialOutput?: string
  theme: YaadeTheme
  tabId: string
  focused: boolean
  isActive: boolean
  existingPtyId?: string
  status?: "starting" | "running" | "exited" | "failed"
  exitCode?: number
  sessionGeneration?: number
  readOnly?: boolean
  /** Attach to an existing PTY without ever creating, restarting, or disposing it. */
  attachOnly?: boolean
  /**
   * Hold off creating/attaching a PTY (e.g. Cursor chat-id mint). Panel stays
   * in the starting overlay until this clears and the effect remounts.
   */
  deferPty?: boolean
  /**
   * When false the pane has no on-screen slot (background window / LRU eviction).
   * Skip expensive full refreshes; PTY still receives data + acks.
   */
  visible?: boolean
  /** Override for the starting overlay copy. */
  startingMessage?: string
  onPtyId?: (tabId: string, ptyId: string | null) => void
  onInput?: (tabId: string) => void
  onOutput?: (tabId: string, data?: string) => void
  onTitleChange?: (tabId: string, title: string) => void
  onRestart?: () => void
  onClose?: () => void
  onFailed?: () => void
  /** Fired when the attached PTY process exits (not on attach-miss / start failure). */
  onExit?: (tabId: string, exitCode: number) => void
  onOpenPath?: (path: string, line?: number, column?: number) => void
}

type TerminalSession = {
  term: XTerm
  fit: FitAddon
  ptyId: string | null
  scrollMotion: TerminalScrollMotion
  /** Latest geometry we want the PTY to match (may differ while a resize RPC is in flight). */
  wantedCols: number
  wantedRows: number
  resizeInFlight: boolean
  resizeQueued: boolean
  /** False before xterm disposal; every delayed measurement checks this. */
  live: boolean
  /** Last container px used for FitAddon — skip fit when geometry unchanged. */
  lastFitWidth: number
  lastFitHeight: number
}

const MONO_FONT_FALLBACK = '"Commit Mono", ui-monospace, monospace'

function readRootFontSize(): number {
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(px) && px > 0 ? px : 13
}

/** xterm measures via canvas — CSS var() in fontFamily breaks cell metrics. */
function readTerminalFontFamily(): string {
  const fromTheme = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim()
  return fromTheme || MONO_FONT_FALLBACK
}

function cellMetricsValid(term: XTerm): boolean {
  const dims = (term as XTerm & { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } } })
    ._core?._renderService?.dimensions?.css?.cell
  if (!dims) return term.cols > 0 && term.rows > 0
  return (dims.width ?? 0) >= 4 && (dims.height ?? 0) >= 4
}

function themeOptions(theme: YaadeTheme): NonNullable<XTerm["options"]["theme"]> {
  const c = theme.colors
  const ansi = theme.terminalAnsi
  return {
    // Real bg so OSC 11 reports a luminance TUIs (Cursor Agent) can theme against.
    // CSS still paints the surface; cell default matches the shell.
    background: c.bg,
    foreground: c.text,
    cursor: c.accent,
    selectionBackground: c.selection,
    black: ansi?.black,
    red: ansi?.red,
    green: ansi?.green,
    yellow: ansi?.yellow,
    blue: ansi?.blue,
    magenta: ansi?.magenta,
    cyan: ansi?.cyan,
    white: ansi?.white,
    brightBlack: ansi?.brightBlack,
    brightRed: ansi?.brightRed,
    brightGreen: ansi?.brightGreen,
    brightYellow: ansi?.brightYellow,
    brightBlue: ansi?.brightBlue,
    brightMagenta: ansi?.brightMagenta,
    brightCyan: ansi?.brightCyan,
    brightWhite: ansi?.brightWhite,
  }
}

function readCssVar(name: string): string | null {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value.length > 0 ? value : null
}

function liveThemeOptions(theme: YaadeTheme): NonNullable<XTerm["options"]["theme"]> {
  const options = themeOptions(theme)
  const readAnsi = (
    key: keyof NonNullable<typeof options>,
    cssKey: string,
  ): string | undefined =>
    readCssVar(`--yaade-terminal-ansi-${cssKey}`) ??
    (options[key] as string | undefined)

  return {
    ...options,
    background: readCssVar("--yaade-bg") ?? options.background,
    foreground: readCssVar("--yaade-text") ?? options.foreground,
    cursor: readCssVar("--yaade-accent") ?? options.cursor,
    selectionBackground:
      readCssVar("--yaade-selection") ?? options.selectionBackground,
    black: readAnsi("black", "black"),
    red: readAnsi("red", "red"),
    green: readAnsi("green", "green"),
    yellow: readAnsi("yellow", "yellow"),
    blue: readAnsi("blue", "blue"),
    magenta: readAnsi("magenta", "magenta"),
    cyan: readAnsi("cyan", "cyan"),
    white: readAnsi("white", "white"),
    brightBlack: readAnsi("brightBlack", "bright-black"),
    brightRed: readAnsi("brightRed", "bright-red"),
    brightGreen: readAnsi("brightGreen", "bright-green"),
    brightYellow: readAnsi("brightYellow", "bright-yellow"),
    brightBlue: readAnsi("brightBlue", "bright-blue"),
    brightMagenta: readAnsi("brightMagenta", "bright-magenta"),
    brightCyan: readAnsi("brightCyan", "bright-cyan"),
    brightWhite: readAnsi("brightWhite", "bright-white"),
  }
}

function readTerminalLineHeight(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--yaade-terminal-line-height")
    .trim()
  const n = parseFloat(raw)
  // xterm DomRenderer cursor/cell math is unreliable above 1 — keep default at 1.
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 1.5) : 1
}

function readTerminalCursorBlink(): boolean {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--yaade-terminal-cursor-blink")
    .trim()
  return raw !== "0"
}

type ScrollSnapshot = {
  atBottom: boolean
  line: number
}

function captureScrollSnapshot(term: XTerm): ScrollSnapshot {
  const buf = term.buffer.active
  const line = buf.baseY + buf.viewportY
  const maxLine = Math.max(0, buf.length - term.rows)
  return {
    atBottom: maxLine <= 0 || line >= maxLine - 1,
    line,
  }
}

function restoreScrollSnapshot(term: XTerm, snapshot: ScrollSnapshot): void {
  // xterm v6 scroll lives in DomScrollableElement — use public buffer APIs only.
  if (snapshot.atBottom) term.scrollToBottom()
  else term.scrollToLine(Math.max(0, snapshot.line))
}

/** Fit xterm to container. Returns true when cols/rows changed (PTY resize needed). */
function fitWhenReady(
  session: TerminalSession,
  container: HTMLElement,
  opts?: { force?: boolean },
): boolean {
  if (!session.live || !container.isConnected) return false
  const core = (session.term as XTerm & { _core?: { _isDisposed?: boolean } })._core
  if (!core || core._isDisposed) return false
  const width = container.clientWidth
  const height = container.clientHeight
  if (width < 8 || height < 8) return false
  if (
    !opts?.force &&
    session.lastFitWidth === width &&
    session.lastFitHeight === height
  ) {
    return false
  }
  const prevCols = session.term.cols
  const prevRows = session.term.rows
  const snapshot = captureScrollSnapshot(session.term)
  session.fit.fit()
  session.lastFitWidth = width
  session.lastFitHeight = height
  if (!cellMetricsValid(session.term)) return false
  if (session.term.cols <= 0 || session.term.rows <= 0) return false
  const changed = session.term.cols !== prevCols || session.term.rows !== prevRows
  if (changed) restoreScrollSnapshot(session.term, snapshot)
  return changed
}

/**
 * Push xterm cols/rows to the PTY. Resize RPCs are async and can complete out of
 * order during modal animation — serialize so the host always ends on the latest
 * geometry (stale smaller/larger sizes make progress bars wrap instead of \\r-update).
 */
function resizePty(session: TerminalSession): void {
  if (!session.live || !session.ptyId) return
  session.wantedCols = session.term.cols
  session.wantedRows = session.term.rows
  if (session.resizeInFlight) {
    session.resizeQueued = true
    return
  }
  const run = (): void => {
    const id = session.ptyId
    if (!id) {
      session.resizeInFlight = false
      session.resizeQueued = false
      return
    }
    const cols = session.wantedCols
    const rows = session.wantedRows
    session.resizeInFlight = true
    session.resizeQueued = false
    const api = window.yaade?.terminal
    if (!api) {
      session.resizeInFlight = false
      return
    }
    void Promise.resolve(api.resize(id, cols, rows)).finally(() => {
      if (!session.live) return
      session.resizeInFlight = false
      if (
        session.resizeQueued ||
        session.wantedCols !== cols ||
        session.wantedRows !== rows
      ) {
        run()
      }
    })
  }
  run()
}

function isTerminalCursorHidden(term: XTerm): boolean {
  const core = (
    term as XTerm & {
      _core?: { _coreService?: { isCursorHidden?: boolean }; coreService?: { isCursorHidden?: boolean } }
    }
  )._core
  return (
    core?._coreService?.isCursorHidden === true ||
    core?.coreService?.isCursorHidden === true
  )
}

/**
 * Write PTY bytes into xterm. Cursor hide/show is handled via
 * `data-yaade-terminal-cursor-hidden` + CSS — never full-viewport
 * `term.refresh` on DECCTCEM (Cursor Agent toggles it constantly; that
 * refresh was the main typing jank source).
 */
function writeTerminalOutput(term: XTerm, data: string, onPainted?: () => void): void {
  term.write(data, () => {
    onPainted?.()
  })
}

function focusTerminalInput(tabId: string): void {
  const term = getRegisteredTerminal(tabId)
  if (term) {
    term.focus()
    return
  }
  const docked = document.querySelector<HTMLElement>(
    `[data-yaade-tab-slot="${tabId}"] [data-yaade-terminal-panel]`,
  )
  const sessionTerminal = [
    ...document.querySelectorAll<HTMLElement>(
      "[data-yaade-terminal-panel][data-yaade-terminal-tab-id]",
    ),
  ].find(panel => panel.dataset.yaadeTerminalTabId === tabId)
  const textarea = (
    docked ?? sessionTerminal
  )?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
  textarea?.focus()
}

function applyAttachReplay(
  attached: {
    output?: string
    outputChunks?: string[]
  },
  tabId: string,
  onOutput: ((tabId: string, data?: string) => void) | undefined,
  outputWriter: ReturnType<typeof createTerminalOutputWriter>,
): void {
  const chunks =
    attached.outputChunks && attached.outputChunks.length > 0
      ? attached.outputChunks
      : attached.output
        ? [attached.output]
        : []
  if (chunks.length === 0) return
  // Mark meaningful output once without joining the full replay.
  onOutput?.(tabId, chunks.find(c => c.length > 0))
  for (const chunk of chunks) {
    if (chunk) outputWriter.enqueue(chunk)
  }
  outputWriter.flush()
}

export function TerminalPanel({
  cwdRootUri,
  launchCommand,
  launchArgs,
  launchEnv,
  initialOutput,
  theme,
  tabId,
  focused,
  isActive,
  existingPtyId,
  status = "starting",
  exitCode,
  sessionGeneration = 0,
  readOnly = false,
  attachOnly = false,
  deferPty = false,
  visible = true,
  startingMessage,
  onPtyId,
  onInput,
  onOutput,
  onTitleChange,
  onRestart,
  onClose,
  onFailed,
  onExit,
  onOpenPath,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<TerminalSession | null>(null)
  const gpuRendererRef = useRef<ReturnType<typeof attachTerminalGpuRenderer> | null>(
    null,
  )
  const [displayStatus, setDisplayStatus] = useState(status)
  const [displayExitCode, setDisplayExitCode] = useState(exitCode)
  const [connectedPtyId, setConnectedPtyId] = useState<string | null>(existingPtyId ?? null)
  const themeRef = useRef(theme)
  themeRef.current = theme
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const onTitleChangeRef = useRef(onTitleChange)
  onTitleChangeRef.current = onTitleChange
  const onPtyIdRef = useRef(onPtyId)
  onPtyIdRef.current = onPtyId
  const onInputRef = useRef(onInput)
  onInputRef.current = onInput
  const onOutputRef = useRef(onOutput)
  onOutputRef.current = onOutput
  const onFailedRef = useRef(onFailed)
  onFailedRef.current = onFailed
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  const onOpenPathRef = useRef(onOpenPath)
  onOpenPathRef.current = onOpenPath
  // Launch command/args are create/restart-time only. Capturing a CLI session id
  // updates launchArgs for the next resume — must not remount the live PTY.
  const launchCommandRef = useRef(launchCommand)
  launchCommandRef.current = launchCommand
  const launchArgsRef = useRef(launchArgs)
  launchArgsRef.current = launchArgs
  const launchEnvRef = useRef(launchEnv)
  launchEnvRef.current = launchEnv

  useEffect(() => {
    const terminalApi = window.yaade?.terminal
    if (!terminalApi || !cwdRootUri || !containerRef.current) return
    let cancelled = false
    const container = containerRef.current
    const launchCommandAtStart = launchCommandRef.current
    const launchArgsAtStart = launchArgsRef.current
    const launchEnvAtStart = launchEnvRef.current

    const term = new XTerm({
      // Opaque theme bg — transparency forces expensive alpha blends in WebGL.
      allowTransparency: false,
      theme: themeOptions(theme),
      fontSize: readRootFontSize(),
      fontFamily: readTerminalFontFamily(),
      lineHeight: readTerminalLineHeight(),
      letterSpacing: 0,
      cursorBlink: readTerminalCursorBlink(),
      cursorStyle: "bar",
      // TUIs (Cursor Agent) park the hardware caret off-prompt; never draw an
      // inactive outline/bar while the pane is blurred.
      cursorInactiveStyle: "none",
      scrollback: 5_000,
      // xterm v6 DomScrollableElement — match --yaade-motion-scroll (160ms).
      smoothScrollDuration: 160,
      // Never convert LF→CRLF; progress bars and TUI apps rely on raw \\r.
      convertEol: false,
      // OSC 8 hyperlinks — Cmd/Ctrl-click opens (same as scanned http(s) URLs).
      linkHandler: createTerminalOscLinkHandler(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    // WebGL (Dom fallback) — DomRenderer cannot keep up with agent TUI floods.
    // Keep WebGL for the lifetime of a mounted panel; visibility only trims scrollback.
    const gpuRenderer = attachTerminalGpuRenderer(term)
    gpuRenderer.setHighPerformance(true)
    gpuRendererRef.current = gpuRenderer
    registerTerminalInstance(tabId, term)
    const panelEl = container.closest<HTMLElement>("[data-yaade-terminal-panel]")
    if (panelEl) panelEl.dataset.yaadeTerminalRenderer = gpuRenderer.kind

    // URL provider first so http(s) wins over path false-positives on the same span.
    const urlLinks = registerTerminalUrlLinks(term)
    const pathLinks =
      onOpenPathRef.current != null
        ? registerTerminalPathLinks(term, (path, line, column) => {
            onOpenPathRef.current?.(path, line, column)
          })
        : null

    const session: TerminalSession = {
      term,
      fit,
      ptyId: null,
      scrollMotion: new TerminalScrollMotion(term),
      wantedCols: term.cols,
      wantedRows: term.rows,
      resizeInFlight: false,
      resizeQueued: false,
      live: true,
      lastFitWidth: 0,
      lastFitHeight: 0,
    }
    sessionRef.current = session

    const titleDispose = term.onTitleChange(raw => {
      const title = raw.trim()
      if (!title) return
      onTitleChangeRef.current?.(
        tabId,
        title.length > 80 ? `${title.slice(0, 77)}…` : title,
      )
    })

    let unsub: (() => void) | null = null
    let dataDispose: { dispose: () => void } | null = null
    let binaryDispose: { dispose: () => void } | null = null
    let inputWriter: ReturnType<typeof createTerminalInputWriter> | null = null
    let ptyStarted = false
    const exitUnsubscribe = terminalApi.onExit((id, code) => {
      if (session.ptyId !== id) return
      setDisplayStatus("exited")
      setDisplayExitCode(code)
      onExitRef.current?.(tabId, code)
    })

    const syncFit = () => {
      if (cancelled) return false
      const changed = fitWhenReady(session, container)
      if (changed) resizePty(session)
      return changed
    }

    const syncTypography = () => {
      if (!session.live) return
      const px = readRootFontSize()
      const family = readTerminalFontFamily()
      const lineHeight = readTerminalLineHeight()
      const cursorBlink = readTerminalCursorBlink()
      let changed = false
      if (term.options.fontSize !== px) {
        term.options.fontSize = px
        changed = true
      }
      if (term.options.fontFamily !== family) {
        term.options.fontFamily = family
        changed = true
      }
      if (term.options.lineHeight !== lineHeight) {
        term.options.lineHeight = lineHeight
        changed = true
      }
      if (term.options.cursorBlink !== cursorBlink) {
        term.options.cursorBlink = cursorBlink
        changed = true
      }
      if (changed) {
        session.lastFitWidth = 0
        session.lastFitHeight = 0
        if (syncFit()) term.refresh(0, term.rows - 1)
      }
    }

    const syncTheme = () => {
      if (!session.live) return
      term.options.theme = liveThemeOptions(themeRef.current)
      // Skip full refresh when the pane is off-screen — options still apply
      // on the next paint / visibility refit.
      if (!visibleRef.current) return
      term.refresh(0, Math.max(0, term.rows - 1))
    }

    let lastCursorHiddenAttr = ""
    const syncCursorHiddenAttr = () => {
      // Keep the data attr in sync for E2E + Dom CSS. WebGL already
      // honors DECCTCEM on its canvas; Dom uses the CSS rule on `.xterm-cursor`.
      // Skip writes when unchanged — attr churn forces style recalc.
      const panel = container.closest<HTMLElement>("[data-yaade-terminal-panel]")
      if (!panel) return
      const next = isTerminalCursorHidden(term) ? "1" : "0"
      if (next === lastCursorHiddenAttr) return
      lastCursorHiddenAttr = next
      panel.dataset.yaadeTerminalCursorHidden = next
    }

    // One rAF-batched write path. Feed full coalesced chunks to xterm — its
    // WriteBuffer time-slices parse. Ack parsed chars so the host can pause
    // the PTY when we fall behind (VS Code flow control).
    let ackPendingChars = 0
    let ackInFlight = false
    const ACK_BATCH = 5_000
    const flushAck = (ptyId: string | null) => {
      if (!ptyId || ackPendingChars <= 0 || ackInFlight) return
      const ack = terminalApi.acknowledgeData
      if (!ack) {
        ackPendingChars = 0
        return
      }
      const chars = ackPendingChars
      ackPendingChars = 0
      ackInFlight = true
      void Promise.resolve(ack.call(terminalApi, ptyId, chars)).finally(() => {
        ackInFlight = false
        if (ackPendingChars > 0) flushAck(sessionRef.current?.ptyId ?? ptyId)
      })
    }
    const outputWriter = createTerminalOutputWriter({
      write: (data, onPainted) => writeTerminalOutput(term, data, onPainted),
      onPainted: syncCursorHiddenAttr,
      onParsed: charCount => {
        ackPendingChars += charCount
        if (ackPendingChars >= ACK_BATCH) {
          flushAck(sessionRef.current?.ptyId ?? null)
        }
      },
    })

    const connectPty = (id: string) => {
      session.ptyId = id
      setConnectedPtyId(id)
      setDisplayStatus("running")
      setDisplayExitCode(undefined)
      unsub = terminalApi.onData(id, data => {
        onOutputRef.current?.(tabId, data)
        outputWriter.enqueue(data)
      })
      if (!readOnly) {
        inputWriter = createTerminalInputWriter(
          data => terminalApi.write(id, data),
          error => {
            const message = error instanceof Error ? error.message : String(error)
            term.writeln(`\r\n\x1b[31mTerminal input failed:\x1b[0m ${message}`)
          },
          data => terminalApi.writeBinary(id, btoa(data)),
        )
        dataDispose = term.onData(data => {
          onInputRef.current?.(tabId)
          inputWriter?.enqueue(data)
        })
        binaryDispose = term.onBinary(data => {
          onInputRef.current?.(tabId)
          inputWriter?.enqueueBinary(data)
        })
      }
      syncFit()
      // xterm was fitted before the PTY existed, so a no-op fit here still
      // needs one authoritative resize to replace the host's 80×24 default.
      resizePty(session)
      if (focused && isActive) focusTerminalInput(tabId)
    }

    const createFreshPty = () => {
      void terminalApi
        .create(cwdRootUri, {
          ...(launchCommandAtStart
            ? {
                command: launchCommandAtStart,
                args: launchArgsAtStart,
                env: launchEnvAtStart,
              }
            : {}),
          cols: term.cols,
          rows: term.rows,
        })
        .then(({ id, title }) => {
          if (cancelled) {
            void terminalApi.dispose(id)
            return
          }
          onPtyIdRef.current?.(tabId, id)
          if (title) onTitleChangeRef.current?.(tabId, title)
          connectPty(id)
        })
        .catch(err => {
          const message = err instanceof Error ? err.message : String(err)
          term.writeln(`\r\n\x1b[31mTerminal failed to start:\x1b[0m ${message}`)
          setDisplayStatus("failed")
          onFailedRef.current?.()
        })
    }

    const startPty = () => {
      if (ptyStarted || cancelled) return
      // PTY creation must not depend on a paint or measurable foreground tab.
      // Start at xterm's default geometry and resize when layout becomes ready.
      syncFit()
      if (deferPty) {
        // Keep starting overlay; effect remounts when deferPty clears.
        return
      }
      ptyStarted = true
      if (initialOutput) {
        term.write(initialOutput, () => {
          syncFit()
        })
      }
      if (existingPtyId) {
        void terminalApi
          .attach(existingPtyId)
          .then(attached => {
            if (cancelled) return
          if (!attached) {
            // Stale id after host restart (or reclaim) — spawn fresh.
            if (!readOnly && !attachOnly) {
              createFreshPty()
              return
            }
            term.writeln("\r\n\x1b[31mTerminal session is no longer available.\x1b[0m")
            setDisplayStatus("failed")
            onFailedRef.current?.()
            return
          }
          if (attached.status === "exited") {
            // Stale PTY from a previous host life — respawn (resume argv already
            // on launchArgs when agentCliSessionId was synced).
            if (!readOnly && !attachOnly && launchCommandAtStart) {
              void terminalApi.dispose(existingPtyId).catch(() => {})
              createFreshPty()
              return
            }
            applyAttachReplay(
              attached,
              tabId,
              onOutputRef.current,
              outputWriter,
            )
            setDisplayStatus("exited")
            setDisplayExitCode(attached.exitCode)
            return
          }
          applyAttachReplay(
            attached,
            tabId,
            onOutputRef.current,
            outputWriter,
          )
          if (attached.title) onTitleChangeRef.current?.(tabId, attached.title)
          if (!readOnly) connectPty(existingPtyId)
          if (readOnly) {
            setDisplayStatus("exited")
            setDisplayExitCode(attached.exitCode)
          }
          })
          .catch(error => {
            if (cancelled) return
            const message = error instanceof Error ? error.message : String(error)
            term.writeln(`\r\n\x1b[31mTerminal attach failed:\x1b[0m ${message}`)
            setDisplayStatus("failed")
            onFailedRef.current?.()
          })
        return
      }
      if (
        attachOnly ||
        readOnly ||
        ((status === "failed" || status === "exited") && !launchCommandAtStart)
      ) {
        setDisplayStatus(status === "failed" ? "failed" : "exited")
        setDisplayExitCode(exitCode)
        return
      }
      createFreshPty()
    }

    syncTheme()
    syncTypography()
    syncFit()

    // Measure after webfonts settle — wrong cell width → wrong cols → PTY/xterm
    // mismatch → wrapped progress lines that \\r cannot rewrite in place.
    const refitAfterFonts = () => {
      if (cancelled) return
      syncTypography()
      syncFit()
    }
    const fontsReady =
      typeof document !== "undefined" && document.fonts?.ready
        ? document.fonts.ready.then(refitAfterFonts).catch(() => {})
        : Promise.resolve()
    const onFontsLoadingDone = () => refitAfterFonts()
    document.fonts?.addEventListener?.("loadingdone", onFontsLoadingDone)

    let startTimer = 0
    void Promise.race([
      fontsReady,
      new Promise<void>(resolve => {
        startTimer = window.setTimeout(resolve, 300)
      }),
    ]).finally(() => {
      if (cancelled) return
      startPty()
    })

    let resizeRaf = 0
    const resizeObserver = new ResizeObserver(() => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf)
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0
        if (cancelled) return
        syncFit()
      })
    })
    resizeObserver.observe(container)

    const unsubscribeRootStyleObserver = subscribeRootStyle(() => {
      syncTheme()
      syncTypography()
    })

    let wasVisible = false
    let visibilityRaf = 0
    const visibilityObserver = new IntersectionObserver(entries => {
      const visible = entries.some(e => e.isIntersecting)
      if (!visible) {
        wasVisible = false
        return
      }
      if (wasVisible) return
      wasVisible = true
      visibilityRaf = requestAnimationFrame(() => {
        visibilityRaf = 0
        if (cancelled) return
        syncTypography()
        syncFit()
        if (focused && isActive) focusTerminalInput(tabId)
      })
    })
    visibilityObserver.observe(container)

    return () => {
      cancelled = true
      session.live = false
      if (resizeRaf) cancelAnimationFrame(resizeRaf)
      if (visibilityRaf) cancelAnimationFrame(visibilityRaf)
      if (startTimer) window.clearTimeout(startTimer)
      document.fonts?.removeEventListener?.("loadingdone", onFontsLoadingDone)
      resizeObserver.disconnect()
      unsubscribeRootStyleObserver()
      visibilityObserver.disconnect()
      titleDispose.dispose()
      exitUnsubscribe()
      dataDispose?.dispose()
      binaryDispose?.dispose()
      inputWriter?.dispose()
      outputWriter.dispose()
      // Drain any remaining parse acks so a paused PTY is not left stuck.
      flushAck(session.ptyId)
      unsub?.()
      urlLinks.dispose()
      pathLinks?.dispose()
      session.scrollMotion.dispose()
      gpuRenderer.dispose()
      gpuRendererRef.current = null
      unregisterTerminalInstance(tabId, term)
      term.dispose()
      sessionRef.current = null
    }
  }, [
    cwdRootUri,
    tabId,
    // onPtyId is read via ref — never remount xterm because the parent
    // passed a fresh inline callback (mux slot-box updates used to thrash).
    sessionGeneration,
    readOnly,
    attachOnly,
    deferPty,
    initialOutput,
  ])

  useEffect(() => {
    setDisplayStatus(status)
    setDisplayExitCode(exitCode)
  }, [status, exitCode, sessionGeneration])

  // Keep WebGL for all mounted terminals — tearing WebGL↔Dom on visibility
  // (LRU / slot hide) caused flash and input hitch. Only trim scrollback off-slot.
  useEffect(() => {
    gpuRendererRef.current?.setHighPerformance(true)
    const term = sessionRef.current?.term
    if (term) term.options.scrollback = visible ? 5_000 : 1_000
  }, [visible])

  useEffect(() => {
    const session = sessionRef.current
    const container = containerRef.current
    if (!session || !container) return

    session.term.options.theme = liveThemeOptions(themeRef.current)

    if (!focused || !isActive) return
    const focusRaf = requestAnimationFrame(() => {
      if (sessionRef.current === session && container.isConnected) {
        focusTerminalInput(tabId)
      }
    })
    return () => cancelAnimationFrame(focusRaf)
  }, [focused, isActive, theme.id, tabId])

  if (!window.yaade?.terminal) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 text-[var(--yaade-text-muted)]"
        role="region"
        aria-label="Terminal"
        data-yaade-terminal-panel=""
        data-yaade-terminal-tab-id={tabId}
      >
        <TerminalIcon className="size-8 opacity-40" />
        <p className="text-sm">Integrated terminal</p>
        <p className="max-w-xs text-center text-xs opacity-70">
          The terminal host is unavailable. Start or reconnect the YAADE host.
        </p>
      </div>
    )
  }

  return (
    <div
      className="relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-transparent"
      data-yaade-terminal-panel=""
      data-yaade-terminal-tab-id={tabId}
      data-yaade-terminal-pty-id={connectedPtyId ?? ""}
      data-yaade-terminal-status={displayStatus}
      onMouseDown={() => {
        focusTerminalInput(tabId)
      }}
    >
      <div className="yaade-terminal-surface jet-terminal-surface relative min-h-0 flex-1 overflow-hidden">
        {/*
          FitAddon measures this element's parent box and does NOT subtract parent
          padding. Keep padding on the chrome wrapper; fit target stays unpadded so
          cols/rows match the real glyph grid (avoids wrap-on-\\r progress bars).
        */}
        <div
          ref={containerRef}
          className="h-full min-h-0 w-full overflow-hidden"
          data-yaade-terminal-fit=""
        />
      </div>
      {displayStatus === "starting" || deferPty ? (
        <div
          role="status"
          aria-live="polite"
          data-yaade-terminal-starting=""
          data-yaade-terminal-defer-pty={deferPty ? "1" : undefined}
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70 text-xs text-muted-foreground"
        >
          <Spinner className="size-4 text-muted-foreground" />
          <span>
            {startingMessage ??
              (deferPty
                ? "Preparing chat…"
                : `Starting ${launchCommand ?? "terminal"}…`)}
          </span>
        </div>
      ) : null}
      {readOnly ? (
        <div
          role="status"
          data-yaade-terminal-archived=""
          className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-md border bg-popover px-2.5 py-1 text-center text-xs text-popover-foreground shadow-md"
        >
          Archived · read-only · Resume to reconnect
        </div>
      ) : null}
      {displayStatus === "exited" || displayStatus === "failed" ? (
        <div
          data-yaade-terminal-exit-bar
          role={displayStatus === "failed" ? "alert" : "status"}
          className="flex h-7 shrink-0 items-center gap-2 border-t border-border/50 bg-muted/25 px-2 text-xs text-muted-foreground"
        >
          <span className="min-w-0 flex-1 truncate">
            {displayStatus === "failed"
              ? "Terminal failed to start"
              : `Process exited${displayExitCode == null ? "" : ` with code ${displayExitCode}`}`}
          </span>
          {!readOnly && !attachOnly ? (
            <Button type="button" size="xs" variant="ghost" onClick={onRestart}>
              <RotateCcw className="size-3" />
              Restart
            </Button>
          ) : null}
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Close terminal" onClick={onClose}>
            <X className="size-3" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}
