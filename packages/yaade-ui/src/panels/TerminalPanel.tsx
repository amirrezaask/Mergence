import { useEffect, useRef, useState } from "react"
import { RotateCcw, Terminal as TerminalIcon, X } from "lucide-react"
import type { YaadeTheme } from "@yaade/shared"
import { subscribeRootStyle } from "./root-style-observer.js"
import { Button } from "../components/ui/button.js"
import { Spinner } from "../components/ui/spinner.js"
import { GhosttyTerminalSurface } from "./ghostty/surface.js"
import type { GhosttyColor, GhosttyTheme } from "./ghostty/core.js"
import { createTerminalInputWriter } from "./terminal-input-writer.js"
import { createTerminalOutputWriter } from "./terminal-output-writer.js"
import { terminalKeybindingData } from "./terminal-keybindings.js"
import {
  getRegisteredTerminal,
  registerTerminalInstance,
  unregisterTerminalInstance,
} from "./terminal-instance-registry.js"
import {
  isTerminalLinkModifier,
  openTerminalUrl,
  scanTerminalPathLinks,
} from "./terminal-links.js"
import { DEFAULT_MONO_FONT_FAMILY } from "../theme/appearance-defaults.js"

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
  /** Hold off creating/attaching a PTY until the surrounding session is ready. */
  deferPty?: boolean
  /** False when the pane has no on-screen slot; the PTY still stays connected. */
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
  /** Fired when the attached PTY process exits. */
  onExit?: (tabId: string, exitCode: number) => void
  onOpenPath?: (path: string, line?: number, column?: number) => void
}

type TerminalSession = {
  surface: GhosttyTerminalSurface
  ptyId: string | null
  wantedCols: number
  wantedRows: number
  resizeInFlight: boolean
  resizeQueued: boolean
  live: boolean
}

function readRootFontSize(): number {
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(px) && px > 0 ? px : 13
}

function readTerminalFontFamily(): string {
  const fromTheme = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim()
  return fromTheme || DEFAULT_MONO_FONT_FAMILY
}

function readCssVar(name: string): string | null {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value.length > 0 ? value : null
}

function parseColor(value: string | undefined, fallback: GhosttyColor): GhosttyColor {
  if (!value) return fallback
  const hex = value.trim().replace(/^#/, "")
  if (/^[\da-f]{6}$/i.test(hex)) {
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
    }
  }
  if (/^[\da-f]{3}$/i.test(hex)) {
    return {
      r: Number.parseInt(`${hex[0]}${hex[0]}`, 16),
      g: Number.parseInt(`${hex[1]}${hex[1]}`, 16),
      b: Number.parseInt(`${hex[2]}${hex[2]}`, 16),
    }
  }
  if (typeof document === "undefined") return fallback
  try {
    const context = document.createElement("canvas").getContext("2d")
    if (!context) return fallback
    context.fillStyle = "#000000"
    context.fillStyle = value
    const normalized = context.fillStyle
    const match = normalized.match(
      /^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i,
    )
    if (!match) return fallback
    return {
      r: Math.max(0, Math.min(255, Math.round(Number(match[1])))),
      g: Math.max(0, Math.min(255, Math.round(Number(match[2])))),
      b: Math.max(0, Math.min(255, Math.round(Number(match[3])))),
    }
  } catch {
    return fallback
  }
}

const TERMINAL_ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const

function terminalPalette(theme: YaadeTheme): readonly GhosttyColor[] | undefined {
  const ansi = theme.terminalAnsi
  if (!ansi) return undefined
  const ansiColors = TERMINAL_ANSI_KEYS.map(key => {
    const cssKey = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
    return parseColor(
      readCssVar(`--yaade-terminal-ansi-${cssKey}`) ?? ansi[key],
      { r: 0, g: 0, b: 0 },
    )
  })
  const palette = Array.from({ length: 256 }, (_, index) => {
    if (index < 16) return ansiColors[index]!
    if (index < 232) {
      const cube = index - 16
      const channel = (value: number) => (value === 0 ? 0 : 55 + value * 40)
      return {
        r: channel(Math.floor(cube / 36)),
        g: channel(Math.floor((cube % 36) / 6)),
        b: channel(cube % 6),
      }
    }
    const gray = 8 + (index - 232) * 10
    return { r: gray, g: gray, b: gray }
  })
  return palette
}

function terminalTheme(theme: YaadeTheme): GhosttyTheme {
  const colors = theme.colors
  const configured = theme.terminal
  const background =
    readCssVar("--yaade-terminal-background") ?? configured?.background ?? colors.bg
  const foreground =
    readCssVar("--yaade-terminal-foreground") ?? configured?.foreground ?? colors.text
  const cursor =
    readCssVar("--yaade-terminal-cursor") ?? configured?.cursor ?? colors.accent
  const selectionBackground =
    readCssVar("--yaade-terminal-selection") ?? configured?.selectionBackground ?? colors.selection

  return {
    background: parseColor(background, { r: 0, g: 0, b: 0 }),
    foreground: parseColor(foreground, { r: 229, g: 231, b: 235 }),
    cursor: parseColor(cursor, parseColor(foreground, { r: 229, g: 231, b: 235 })),
    palette: terminalPalette(theme),
    selectionBackground,
  }
}

function focusTerminalInput(tabId: string): void {
  const terminal = getRegisteredTerminal(tabId)
  if (terminal) {
    terminal.focus()
    return
  }
  const docked = document.querySelector<HTMLElement>(
    `[data-yaade-tab-slot="${CSS.escape(tabId)}"] [data-yaade-terminal-panel]`,
  )
  const sessionTerminal = [...document.querySelectorAll<HTMLElement>(
    "[data-yaade-terminal-panel][data-yaade-terminal-tab-id]",
  )].find(panel => panel.dataset.yaadeTerminalTabId === tabId)
  ;(docked ?? sessionTerminal)
    ?.querySelector<HTMLTextAreaElement>("[data-yaade-terminal-input]")
    ?.focus({ preventScroll: true })
}

function applyAttachReplay(
  attached: {
    output?: string;
    outputChunks?: string[];
    replayTruncated?: boolean;
    replayNeedsQueryResponses?: boolean;
  },
  tabId: string,
  onOutput: ((tabId: string, data?: string) => void) | undefined,
  outputWriter: ReturnType<typeof createTerminalOutputWriter>,
  respondToQueries = false,
): void {
  const chunks =
    attached.outputChunks && attached.outputChunks.length > 0
      ? attached.outputChunks
      : attached.output
        ? [attached.output]
        : []
  if (chunks.length === 0) return
  onOutput?.(tabId, chunks.find(chunk => chunk.length > 0))
  if (attached.replayTruncated) {
    // The ring may begin inside an escape sequence. Start the best-effort
    // transcript from a clean parser state instead of inheriting corruption.
    // Keep the reset detached even when the replay itself must answer queries.
    outputWriter.enqueueReplay("\x1bc")
  }
  for (const chunk of chunks) {
    if (!chunk) continue
    if (respondToQueries) outputWriter.enqueue(chunk)
    else outputWriter.enqueueReplay(chunk)
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
  const surfaceRef = useRef<GhosttyTerminalSurface | null>(null)
  const [displayStatus, setDisplayStatus] = useState(status)
  const [displayExitCode, setDisplayExitCode] = useState(exitCode)
  const [connectedPtyId, setConnectedPtyId] = useState<string | null>(existingPtyId ?? null)
  const [terminalError, setTerminalError] = useState<string | null>(null)
  const themeRef = useRef(theme)
  themeRef.current = theme
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
    let session: TerminalSession | null = null
    let surface: GhosttyTerminalSurface | null = null
    let unsub: (() => void) | null = null
    let dataDispose: (() => void) | null = null
    let inputWriter: ReturnType<typeof createTerminalInputWriter> | null = null
    const pendingTerminalInput: string[] = []
    let outputWriter: ReturnType<typeof createTerminalOutputWriter> | null = null
    let ackPendingChars = 0
    let ackRetryTimer: ReturnType<typeof setTimeout> | null = null

    const enqueueTerminalInput = (data: string) => {
      if (data.length === 0) return
      if (inputWriter) inputWriter.enqueue(data)
      else pendingTerminalInput.push(data)
    }
    let ackInFlight = false

    const container = containerRef.current
    const launchCommandAtStart = launchCommandRef.current
    const launchArgsAtStart = launchArgsRef.current
    const launchEnvAtStart = launchEnvRef.current
    const launchForSize = (cols: number, rows: number) => ({
      ...(launchCommandAtStart
        ? {
            command: launchCommandAtStart,
            args: launchArgsAtStart,
            env: launchEnvAtStart,
          }
        : {}),
      cols,
      rows,
    })
    const shouldPrecreatePty =
      !deferPty &&
      !existingPtyId &&
      !initialOutput &&
      !readOnly &&
      !attachOnly &&
      !((status === "failed" || status === "exited") && !launchCommandAtStart)
    const precreatedPty = shouldPrecreatePty
      ? Promise.resolve().then(() => terminalApi.create(cwdRootUri, launchForSize(80, 24)))
      : null
    // The renderer can take longer than PTY startup. Attach the rejection now
    // so a failed speculative create never becomes an unhandled promise.
    void precreatedPty?.catch(() => {})
    let precreatedPtyConsumed = false

    const disposePrecreatedPty = () => {
      if (!precreatedPty || precreatedPtyConsumed) return
      precreatedPtyConsumed = true
      void precreatedPty.then(({ id }) => terminalApi.dispose(id)).catch(() => {})
    }

    const flushAck = (ptyId: string | null) => {
      if (!ptyId || ackPendingChars <= 0 || ackInFlight) return
      const acknowledge = terminalApi.acknowledgeData
      if (!acknowledge) {
        ackPendingChars = 0
        return
      }
      const chars = ackPendingChars
      ackPendingChars = 0
      ackInFlight = true
      void Promise.resolve()
        .then(() => acknowledge.call(terminalApi, ptyId, chars))
        .then(
          () => {
            ackInFlight = false
            if (ackPendingChars > 0) flushAck(session?.ptyId ?? ptyId)
          },
          () => {
            // Do not lose the debt when a fire-and-forget WS/HTTP ack fails.
            // A later retry or reconnect can then release the host watermark.
            ackPendingChars += chars
            ackInFlight = false
            if (cancelled || ackRetryTimer !== null) return
            ackRetryTimer = setTimeout(() => {
              ackRetryTimer = null
              flushAck(session?.ptyId ?? ptyId)
            }, 250)
          },
        )
    }

    const resizePty = (next: TerminalSession | null) => {
      if (!next?.live || !next.ptyId || !next.surface.hasMeasuredSize()) return
      if (next.resizeInFlight) {
        next.resizeQueued = true
        return
      }
      const id = next.ptyId
      const cols = next.wantedCols
      const rows = next.wantedRows
      next.resizeInFlight = true
      next.resizeQueued = false
      const settle = () => {
        if (!next.live) return
        next.resizeInFlight = false
        if (next.resizeQueued || next.wantedCols !== cols || next.wantedRows !== rows) {
          resizePty(next)
        }
      }
      void Promise.resolve()
        .then(() => terminalApi.resize(id, cols, rows))
        .then(settle, settle)
    }

    const handleLink = (text: string, event: MouseEvent) => {
      if (!isTerminalLinkModifier(event)) return
      if (/^https?:\/\//i.test(text)) {
        openTerminalUrl(text)
        return
      }
      const path = scanTerminalPathLinks(text)[0]
      if (path) onOpenPathRef.current?.(path.path, path.line, path.column)
    }

    const connectPty = (id: string, replayMayNeedQueryResponses = false) => {
      if (!session || !surface || cancelled) return
      session.ptyId = id
      setConnectedPtyId(id)
      setDisplayStatus("running")
      setDisplayExitCode(undefined)
      unsub = terminalApi.onData(
        id,
        (
          data,
          replay = false,
          replayNeedsQueryResponses = false,
          replayTruncated = false,
        ) => {
          onOutputRef.current?.(tabId, data)
          if (replay && replayTruncated) {
            // A reconnect gap means the ring starts after the current parser
            // state. Reset before applying the best-effort replacement stream.
            outputWriter?.flush()
            surface?.resetAndWrite("")
          }
          if (
            replay &&
            !replayMayNeedQueryResponses &&
            !replayNeedsQueryResponses
          ) {
            outputWriter?.enqueueReplay(data)
            outputWriter?.flush()
          } else {
            outputWriter?.enqueue(data)
            if (replay && replayNeedsQueryResponses) {
              outputWriter?.flush()
              // Query replies are queued on a microtask by the input writer;
              // flush them before the host is told this replay is complete.
              void inputWriter?.flush()
              void terminalApi.markReplayReady(id).catch(() => {})
            }
          }
        },
      )
      if (!readOnly) {
        inputWriter = createTerminalInputWriter(
          data => terminalApi.write(id, data),
          error => {
            const message = error instanceof Error ? error.message : String(error)
            surface?.write(`\r\n\x1b[31mTerminal input failed:\x1b[0m ${message}`)
          },
        )
        for (const queued of pendingTerminalInput.splice(0)) inputWriter.enqueue(queued)
        // Flush replies generated while parsing the attach snapshot before
        // declaring the first live replay ready. This makes a rapid reload
        // retry query responses instead of turning a startup race into a
        // permanently waiting shell.
        outputWriter?.flush()
        void inputWriter.flush()
        void terminalApi.markReplayReady(id).catch(() => {})
        dataDispose = () => inputWriter?.dispose()
      }
      session.wantedCols = surface.cols
      session.wantedRows = surface.rows
      resizePty(session)
      if (focused && isActive) focusTerminalInput(tabId)
    }

    const createFreshPty = (prepared: typeof precreatedPty = null): void => {
      if (!surface || cancelled) return
      if (prepared !== null) precreatedPtyConsumed = true
      const created =
        prepared ?? terminalApi.create(cwdRootUri, launchForSize(surface.cols, surface.rows))
      void created
        .then(async ({ id, title }) => {
          if (cancelled) {
            void terminalApi.dispose(id)
            return
          }
          onPtyIdRef.current?.(tabId, id)
          if (title) onTitleChangeRef.current?.(tabId, title)
          if (prepared === null) {
            connectPty(id)
            return
          }

          // The PTY may have produced output while WASM/fonts were loading.
          // Attach before subscribing so the host client's replay floor orders
          // replayed bytes before any live chunks that arrived in the meantime.
          const attached = await terminalApi.attach(id)
          if (cancelled) {
            void terminalApi.dispose(id)
            return
          }
          if (!attached) throw new Error("precreated terminal disappeared before attach")
          if (outputWriter) {
            applyAttachReplay(
              attached,
              tabId,
              onOutputRef.current,
              outputWriter,
              true,
            )
          }
          if (attached.status === "exited") {
            setDisplayStatus("exited")
            setDisplayExitCode(attached.exitCode)
            return
          }
          connectPty(id, true)
        })
        .catch(error => {
          if (cancelled) return
          const message = error instanceof Error ? error.message : String(error)
          surface?.write(`\r\n\x1b[31mTerminal failed to start:\x1b[0m ${message}`)
          setDisplayStatus("failed")
          onFailedRef.current?.()
        })
    }

    const startPty = (prepared: typeof precreatedPty = null) => {
      if (cancelled || !surface) return
      if (deferPty) return
      if (initialOutput && !existingPtyId) surface.resetAndWrite(initialOutput)
      if (existingPtyId) {
        void terminalApi
          .attach(existingPtyId)
          .then(attached => {
            if (cancelled) return
            if (!attached) {
              if (!readOnly && !attachOnly) {
                createFreshPty()
                return
              }
              surface?.write("\r\n\x1b[31mTerminal session is no longer available.\x1b[0m")
              setDisplayStatus("failed")
              onFailedRef.current?.()
              return
            }
            if (attached.status === "exited") {
              if (!readOnly && !attachOnly && launchCommandAtStart) {
                void terminalApi.dispose(existingPtyId).catch(() => {})
                createFreshPty()
                return
              }
              if (outputWriter) {
                applyAttachReplay(attached, tabId, onOutputRef.current, outputWriter)
              }
              setDisplayStatus("exited")
              setDisplayExitCode(attached.exitCode)
              return
            }
            const respondToQueries =
              !readOnly && attached.replayNeedsQueryResponses === true
            if (outputWriter) {
              applyAttachReplay(
                attached,
                tabId,
                onOutputRef.current,
                outputWriter,
                respondToQueries,
              )
            }
            if (attached.title) onTitleChangeRef.current?.(tabId, attached.title)
            if (!readOnly) connectPty(existingPtyId, respondToQueries)
            else {
              setDisplayStatus("exited")
              setDisplayExitCode(attached.exitCode)
            }
          })
          .catch(error => {
            if (cancelled) return
            const message = error instanceof Error ? error.message : String(error)
            surface?.write(`\r\n\x1b[31mTerminal attach failed:\x1b[0m ${message}`)
            setDisplayStatus("failed")
            onFailedRef.current?.()
          })
        return
      }
      if (
        attachOnly ||
        ((status === "failed" || status === "exited") && !launchCommandAtStart)
      ) {
        setDisplayStatus(status === "failed" ? "failed" : "exited")
        setDisplayExitCode(exitCode)
        return
      }
      createFreshPty(prepared)
    }

    const exitUnsubscribe = terminalApi.onExit((id, code) => {
      if (session?.ptyId !== id) return
      setDisplayStatus("exited")
      setDisplayExitCode(code)
      onExitRef.current?.(tabId, code)
    })

    const setup = async () => {
      try {
        surface = await GhosttyTerminalSurface.create(container, {
          theme: terminalTheme(themeRef.current),
          font: { family: readTerminalFontFamily(), size: readRootFontSize() },
          visible,
          onData: data => {
            onInputRef.current?.(tabId)
            enqueueTerminalInput(data)
          },
          onResize: (cols, rows) => {
            if (!session?.live) return
            session.wantedCols = cols
            session.wantedRows = rows
            resizePty(session)
          },
          onSelectionChange: () => undefined,
          beforeKey: event => {
            const data = terminalKeybindingData(event, navigator.platform)
            if (data === null) return true
            event.preventDefault()
            event.stopPropagation()
            onInputRef.current?.(tabId)
            enqueueTerminalInput(data)
            return false
          },
          onLinkActivate: handleLink,
          onTitleChange: title => {
            onTitleChangeRef.current?.(
              tabId,
              title.length > 80 ? `${title.slice(0, 77)}…` : title,
            )
          },
        })
        if (cancelled) {
          surface.dispose()
          return
        }
        surfaceRef.current = surface
        const panel = container.closest<HTMLElement>("[data-yaade-terminal-panel]")
        if (panel) panel.dataset.yaadeTerminalRenderer = "ghostty"
        session = {
          surface,
          ptyId: null,
          wantedCols: surface.cols,
          wantedRows: surface.rows,
          resizeInFlight: false,
          resizeQueued: false,
          live: true,
        }
        sessionRef.current = session
        registerTerminalInstance(tabId, surface)

        outputWriter = createTerminalOutputWriter({
          // Ghostty parses synchronously on the UI thread. Keep each frame's
          // parser slice bounded; the Canvas adapter has no internal async
          // write queue to yield for us.
          maxCharsPerFlush: 32 * 1024,
          write: (data, onPainted) => {
            surface?.write(data)
            onPainted?.()
          },
          writeReplay: (chunks, onPainted) => {
            surface?.writeReplay(chunks)
            onPainted?.()
          },
          onParsed: charCount => {
            ackPendingChars += charCount
            if (ackPendingChars >= 5_000) flushAck(session?.ptyId ?? null)
          },
        })

        startPty(precreatedPty)
      } catch (error) {
        disposePrecreatedPty()
        if (cancelled) return
        const message = error instanceof Error ? error.message : String(error)
        setTerminalError(message)
        setDisplayStatus("failed")
        onFailedRef.current?.()
      }
    }

    void setup()
    const unsubscribeRootStyleObserver = subscribeRootStyle(() => {
      const next = sessionRef.current?.surface
      if (!next) return
      next.setTheme(terminalTheme(themeRef.current))
      void next.setFont({ family: readTerminalFontFamily(), size: readRootFontSize() })
    })

    return () => {
      cancelled = true
      disposePrecreatedPty()
      if (session) session.live = false
      if (sessionRef.current === session) sessionRef.current = null
      if (surfaceRef.current === surface) surfaceRef.current = null
      unsubscribeRootStyleObserver()
      exitUnsubscribe()
      // Flush parser output before disposing the input writer: Ghostty may have
      // queued a DSR/DA response while the page is being replaced. Dropping
      // that microtask leaves a live shell waiting for a query response, and
      // the next attach correctly suppresses archived replay side effects.
      outputWriter?.flush()
      void inputWriter?.flush()
      if (session?.ptyId) void terminalApi.markReplayReady(session.ptyId).catch(() => {})
      dataDispose?.()
      inputWriter = null
      pendingTerminalInput.length = 0
      outputWriter?.dispose()
      if (ackRetryTimer !== null) {
        clearTimeout(ackRetryTimer)
        ackRetryTimer = null
      }
      flushAck(session?.ptyId ?? null)
      unsub?.()
      if (surface) {
        unregisterTerminalInstance(tabId, surface)
        surface.dispose()
      }
    }
  }, [
    cwdRootUri,
    tabId,
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

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    surface.setTheme(terminalTheme(theme))
  }, [theme.id])

  useEffect(() => {
    surfaceRef.current?.setVisible(visible)
  }, [visible])

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface || !focused || !isActive) return
    const focusRaf = requestAnimationFrame(() => {
      if (surfaceRef.current === surface) focusTerminalInput(tabId)
    })
    return () => cancelAnimationFrame(focusRaf)
  }, [focused, isActive, tabId, theme.id])

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
      onMouseDown={() => focusTerminalInput(tabId)}
    >
      <div className="yaade-terminal-surface jet-terminal-surface relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={containerRef}
          className="relative h-full min-h-0 w-full overflow-hidden"
          data-yaade-terminal-fit=""
          data-yaade-terminal-surface=""
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
              (deferPty ? "Preparing chat…" : `Starting ${launchCommand ?? "terminal"}…`)}
          </span>
        </div>
      ) : null}
      {terminalError ? (
        <div
          role="alert"
          className="pointer-events-none absolute inset-x-0 bottom-7 border-t border-destructive/30 bg-background/90 px-3 py-2 text-xs text-destructive"
        >
          Ghostty terminal failed to load: {terminalError}
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
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Close terminal"
            onClick={onClose}
          >
            <X className="size-3" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}
