/**
 * Coalesce PTY writes onto animation frames for floods; flush interactive
 * echoes on a microtask (skip rAF) so key→paint stays near one frame.
 *
 * Design:
 * - rAF-batch WS chunks so we call the terminal parser ~once/frame under flood.
 * - Hand all pending bytes to the parser by default. Renderers that parse
 *   synchronously (Ghostty) may opt into a bounded per-frame slice.
 * - Use the write callback only for flow-control ack, never to block the next
 *   flush.
 */

export type TerminalOutputWriter = {
  enqueue: (data: string) => void
  /** Queue attach/reconnect replay without applying the live-output cap. */
  enqueueReplay: (data: string) => void
  /** Drain pending bytes immediately (attach replay / dispose). */
  flush: () => void
  dispose: () => void
}

export type TerminalOutputWriterOptions = {
  write: (data: string, onPainted?: () => void) => void
  /**
   * Write replay chunks while the terminal parser's PTY callback is detached.
   * The callback is invoked once after the whole replay has been parsed.
   */
  writeReplay?: (data: readonly string[], onPainted?: () => void) => void
  /** Called after a coalesced write paints (once per flush). */
  onPainted?: () => void
  /**
   * Called with the char count once the terminal has parsed the flushed chunk.
   * Hosts use this for VS Code-style PTY flow-control acks.
   */
  onParsed?: (charCount: number) => void
  /**
   * When true, after paint run a single viewport refresh. Callers should only
   * request this for cursor-visibility toggles, and at most once per frame.
   */
  refreshAfterPaint?: () => void
  schedule?: (cb: () => void) => number
  cancel?: (id: number) => void
  /**
   * Browser tabs may suspend animation frames. Keep parsing PTY output on a
   * timer so terminal queries cannot block a shell while the tab is hidden.
   */
  scheduleFrameFallback?: (cb: () => void, delayMs: number) => number
  cancelFrameFallback?: (id: number) => void
  maxFrameWaitMs?: number
  frameClockActive?: () => boolean
  /**
   * Safety parachute for live output only — with host PTY pause/resume, pending
   * should stay near one frame. Oldest live chunks shed if something else is
   * broken. Replay is never shed because it is the state reconstruction input.
   */
  maxPendingChars?: number
  /**
   * Optional parser slice. It affects flood flushes only; interactive chunks
   * still use the microtask path.
   */
  maxCharsPerFlush?: number
  /**
   * Pending chars at or below this flush via microtask (skip rAF). Above this
   * (or once a flood is in flight) use the animation-frame scheduler.
   */
  interactiveMaxChars?: number
}

/** Last-resort backlog before oldest pending output is dropped. Host PTY
 *  pause/resume should keep pending near one frame; this is a safety net. */
export const TERMINAL_OUTPUT_MAX_PENDING_CHARS = 512 * 1024

/** Idle / echo path — keep key→paint off the rAF clock. */
export const TERMINAL_OUTPUT_INTERACTIVE_MAX_CHARS = 256

export function createTerminalOutputWriter(
  options: TerminalOutputWriterOptions,
): TerminalOutputWriter {
  const schedule =
    options.schedule ??
    (typeof requestAnimationFrame === "function"
      ? (cb: () => void) => requestAnimationFrame(cb)
      : (cb: () => void) => setTimeout(cb, 0) as unknown as number)
  const cancel =
    options.cancel ??
    (typeof cancelAnimationFrame === "function"
      ? (id: number) => cancelAnimationFrame(id)
      : (id: number) => clearTimeout(id))
  const scheduleFrameFallback =
    options.scheduleFrameFallback ??
    ((cb: () => void, delayMs: number) =>
      setTimeout(cb, delayMs) as unknown as number)
  const cancelFrameFallback =
    options.cancelFrameFallback ?? ((id: number) => clearTimeout(id))
  const maxFrameWaitMs = options.maxFrameWaitMs ?? 100
  const frameClockActive =
    options.frameClockActive ??
    (() => typeof document === "undefined" || document.visibilityState !== "hidden")
  const maxPending = options.maxPendingChars ?? TERMINAL_OUTPUT_MAX_PENDING_CHARS
  const maxPerFlush = options.maxCharsPerFlush ?? Number.POSITIVE_INFINITY
  const interactiveMax =
    options.interactiveMaxChars ?? TERMINAL_OUTPUT_INTERACTIVE_MAX_CHARS

  const pendingParts: string[] = []
  let pendingChars = 0
  // Replay is kept separate so the live safety cap can never discard it. The
  // attach path supplies PTY-sized chunks and flushes this queue synchronously.
  const replayParts: string[] = []
  let replayChars = 0
  let needsRefresh = false
  let raf = 0
  let frameFallback = 0
  let microScheduled = false
  let disposed = false
  /** Once true, stay on rAF until the queue drains (flood mode). */
  let floodMode = false

  const shedOldest = () => {
    while (pendingChars > maxPending && pendingParts.length > 1) {
      const dropped = pendingParts.shift()!
      pendingChars -= dropped.length
    }
    if (pendingChars > maxPending && pendingParts.length === 1) {
      const only = pendingParts[0]!
      pendingParts[0] = only.slice(only.length - maxPending)
      pendingChars = pendingParts[0]!.length
    }
  }

  const safeChunkLength = (value: string, requested: number): number => {
    if (requested >= value.length) return value.length
    if (requested <= 0) return 0
    // Never feed a lone UTF-16 surrogate to the UTF-8 terminal parser. Escape
    // sequences may be split across frames, but code points may not.
    const previous = value.charCodeAt(requested - 1)
    if (previous >= 0xd800 && previous <= 0xdbff) return requested + 1
    return requested
  }

  /** Take up to `limit` chars, leave the rest queued. */
  const takePending = (limit: number): string => {
    if (pendingParts.length === 0 || limit <= 0) return ""
    if (pendingChars <= limit) {
      const data =
        pendingParts.length === 1 ? pendingParts[0]! : pendingParts.join("")
      pendingParts.length = 0
      pendingChars = 0
      return data
    }

    const out: string[] = []
    let taken = 0
    while (pendingParts.length > 0 && taken < limit) {
      const head = pendingParts[0]!
      const room = limit - taken
      if (head.length <= room) {
        pendingParts.shift()
        out.push(head)
        taken += head.length
        pendingChars -= head.length
      } else {
        const chunkLength = Math.min(head.length, safeChunkLength(head, room))
        out.push(head.slice(0, chunkLength))
        pendingParts[0] = head.slice(chunkLength)
        pendingChars -= chunkLength
        taken += chunkLength
      }
    }
    return out.length === 1 ? out[0]! : out.join("")
  }

  const markRefresh = (data: string): void => {
    // Only scan for DECCTCEM when a refresh hook is wired (legacy fallback).
    if (
      options.refreshAfterPaint != null &&
      (data.includes("\x1b[?25l") || data.includes("\x1b[?25h"))
    ) {
      needsRefresh = true
    }
  }

  const flushReplayNow = (): void => {
    if (disposed || replayParts.length === 0) return
    const parts = replayParts.splice(0)
    replayChars = 0
    const doRefresh = needsRefresh && pendingChars === 0
    if (doRefresh) needsRefresh = false
    const onPainted = () => {
      if (disposed) return
      if (doRefresh) options.refreshAfterPaint?.()
      options.onPainted?.()
    }
    if (options.writeReplay) {
      options.writeReplay(parts, onPainted)
      return
    }
    // Keep the writer usable for simple renderers that do not need a special
    // replay hook. Production Ghostty supplies writeReplay so its callback is
    // detached for the complete batch.
    for (const part of parts) options.write(part)
    onPainted()
  }

  const flushNow = (unlimited = false) => {
    if (replayChars > 0) flushReplayNow()
    if (replayChars > 0) return
    raf = 0
    microScheduled = false
    if (disposed || (pendingChars === 0 && !needsRefresh)) {
      if (pendingChars === 0) floodMode = false
      return
    }
    const data = takePending(unlimited ? Number.POSITIVE_INFINITY : maxPerFlush)
    const doRefresh = needsRefresh && pendingChars === 0
    if (doRefresh) needsRefresh = false
    if (data.length === 0) {
      if (doRefresh) options.refreshAfterPaint?.()
      options.onPainted?.()
      if (pendingChars === 0) floodMode = false
      return
    }
    // Terminal writes are non-blocking — do NOT gate the next flush on this
    // callback. The parser owns its throughput scheduling.
    options.write(data, () => {
      if (disposed) return
      options.onParsed?.(data.length)
      if (doRefresh) options.refreshAfterPaint?.()
      options.onPainted?.()
    })
    // Leftover from an optional test cap — schedule next frame without waiting.
    if (pendingChars > 0 || needsRefresh) scheduleNext()
    else floodMode = false
  }

  const scheduleRaf = () => {
    if (disposed || raf) return
    // Cancel a pending interactive microtask — flood wins.
    microScheduled = false
    raf = schedule(() => {
      if (!raf) return
      raf = 0
      if (frameFallback) {
        cancelFrameFallback(frameFallback)
        frameFallback = 0
      }
      flushNow(false)
    })
    // requestAnimationFrame is suspended in background tabs. Parsing must not
    // be: shells such as fish wait synchronously for DA/DSR query responses.
    frameFallback = scheduleFrameFallback(() => {
      frameFallback = 0
      if (!raf) return
      cancel(raf)
      raf = 0
      flushNow(false)
    }, maxFrameWaitMs)
  }

  const scheduleMicro = () => {
    if (disposed || raf || microScheduled) return
    microScheduled = true
    queueMicrotask(() => {
      if (!microScheduled || disposed) return
      microScheduled = false
      // Flood may have armed rAF between schedule and run.
      if (raf) return
      flushNow(false)
    })
  }

  const scheduleNext = () => {
    if (!frameClockActive()) {
      if (raf) {
        cancel(raf)
        raf = 0
      }
      if (frameFallback) {
        cancelFrameFallback(frameFallback)
        frameFallback = 0
      }
      scheduleMicro()
      return
    }
    if (floodMode || pendingChars > interactiveMax) {
      floodMode = true
      scheduleRaf()
    } else {
      scheduleMicro()
    }
  }

  return {
    enqueue(data) {
      if (disposed || data.length === 0) return
      pendingParts.push(data)
      pendingChars += data.length
      shedOldest()
      markRefresh(data)
      scheduleNext()
    },
    enqueueReplay(data) {
      if (disposed || data.length === 0) return
      replayParts.push(data)
      replayChars += data.length
      markRefresh(data)
    },
    flush() {
      if (raf) {
        cancel(raf)
        raf = 0
      }
      if (frameFallback) {
        cancelFrameFallback(frameFallback)
        frameFallback = 0
      }
      microScheduled = false
      // Replay must land fully before connect. It bypasses the live queue cap,
      // the per-frame slice, and flow-control acknowledgements.
      flushReplayNow()
      // Drain any normal bytes that arrived around the attach handshake too.
      while (pendingChars > 0 || needsRefresh) flushNow(true)
    },
    dispose() {
      disposed = true
      if (raf) {
        cancel(raf)
        raf = 0
      }
      if (frameFallback) {
        cancelFrameFallback(frameFallback)
        frameFallback = 0
      }
      microScheduled = false
      pendingParts.length = 0
      pendingChars = 0
      replayParts.length = 0
      replayChars = 0
      needsRefresh = false
      floodMode = false
    },
  }
}
