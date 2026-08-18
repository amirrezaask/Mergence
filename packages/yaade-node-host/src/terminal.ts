import * as pty from "node-pty"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToUri, uriToPath } from "./paths.js"
import { cwdOfForeground, foregroundProcessOf } from "./terminal-cwd.js"
import {
  applyShellCwdReporting,
  parseOsc7Cwd,
} from "./terminal-osc7.js"
import {
  createDa1Scanner,
  feedDa1Queries,
  TERMINAL_DA1_RESPONSE,
  type Da1Scanner,
} from "./terminal-da.js"

/**
 * This is a bounded transcript, not a serialized terminal state. Once the
 * transcript is trimmed, a browser reload cannot faithfully restore Ghostty's
 * parser/mode state; the attach response marks that case explicitly.
 */
const MAX_TERMINAL_REPLAY = 2 * 1024 * 1024
/** Shrink ring after exit so disposed-but-reattachable PTYs do not keep 2 MB. */
const EXITED_TERMINAL_REPLAY = 256 * 1024
const MAX_WRITE_BYTES = 1024 * 1024
/** Hard cap concurrent PTY entries (running + exited-but-not-disposed). */
const MAX_TERMINAL_ENTRIES = 64
/** Auto-dispose exited PTYs so replay buffers do not linger forever. */
const EXITED_TERMINAL_DISPOSE_TTL_MS = 90_000
/**
 * node-pty commonly delivers output in 1 KiB chunks. Sending each chunk as a
 * JSON/WebSocket event makes a log flood spend more time on framing, parsing,
 * and callbacks than on terminal emulation. Keep interactive latency below a
 * frame while coalescing throughput-oriented bursts into useful-sized frames.
 */
const TERMINAL_EMIT_BATCH_BYTES = 64 * 1024
const TERMINAL_EMIT_BATCH_DELAY_MS = 4
/**
 * Keystroke-sized PTY chunks flush immediately after idle (VS Code emits per
 * onData). Larger chunks keep the 4ms / 64KiB coalesce for flood framing —
 * threshold stays well below typical node-pty ~1KiB reads.
 */
const TERMINAL_EMIT_INTERACTIVE_BYTES = 32

/**
 * VS Code FlowControlConstants — pause the PTY when the renderer falls behind
 * instead of flooding WS / shedding frames (which is what made agent TUIs choke).
 * @see https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/common/terminal.ts
 */
export const TERMINAL_FLOW_HIGH_WATERMARK_CHARS = 100_000
export const TERMINAL_FLOW_LOW_WATERMARK_CHARS = 5_000
/** Client should ack at least this often so the host can resume. */
export const TERMINAL_FLOW_ACK_CHARS = 5_000

export type TerminalLaunch = {
  command?: string
  args?: string[]
  cols?: number
  rows?: number
  /** Extra env vars merged into the PTY environment (ADE hook forwarders). */
  env?: Record<string, string>
}

export type TerminalCreateResult = {
  id: string
  title: string | null
}

export type TerminalAttachSnapshot = {
  id: string
  title: string | null
  /**
   * Ring segments for attach replay. Prefer enqueueing these one-by-one so
   * neither host nor client materializes a single 2 MB contiguous string.
   */
  outputChunks: string[]
  /**
   * Joined form kept for older callers. Prefer {@link outputChunks}; may be
   * empty when chunks are provided to avoid a peak allocation.
   */
  output: string
  /** True when the returned transcript cannot represent the full parser state. */
  replayTruncated: boolean
  /** True when a live renderer may need to answer queries while applying replay. */
  replayNeedsQueryResponses: boolean
  lastSequence: number
  status: "running" | "exited"
  exitCode: number | null
  signal: number | null
}

/** Metadata-only terminal probe. It never changes ownership or flow control. */
export type TerminalInspectSnapshot = {
  id: string
  title: string | null
  status: "running" | "exited"
  exitCode: number | null
  signal: number | null
  /** Spawn command basename path when a custom launch was used; null for shell. */
  spawnCommand: string | null
  /** Absolute spawn-time cwd. */
  spawnCwd: string
}

type EmitFn = (channel: string, args: unknown[]) => void

type TerminalEntry = {
  id: string
  title: string | null
  titleKey: string | null
  clientId: string
  /** Absolute spawn-time cwd (fallback when live process cwd is unavailable). */
  spawnCwd: string
  /** Custom launch command when not the default shell; null for interactive shells. */
  spawnCommand: string | null
  /** Last cwd reported via OSC 7 (preferred when present). */
  liveCwd: string | null
  status: "running" | "exited"
  exitCode: number | null
  signal: number | null
  sequence: number
  output: string[]
  outputHead: number
  outputBytes: number
  /** The raw replay ring has dropped bytes for this PTY's lifetime. */
  replayTruncated: boolean
  /** The current live renderer has completed a query-capable replay attach. */
  hasAttached: boolean
  pendingOutput: string[]
  pendingOutputBytes: number
  pendingOutputTimer: ReturnType<typeof setTimeout> | null
  disposeTimer: ReturnType<typeof setTimeout> | null
  /** Chars emitted to the client that have not yet been ack'd as parsed. */
  unacknowledgedChars: number
  ptyPaused: boolean
  proc: pty.IPty | null
  disposed: boolean
  dataDisposable: pty.IDisposable | null
  exitDisposable: pty.IDisposable | null
  exitWaiters: Array<(result: { exitCode: number | null; signal?: string }) => void>
  /** Incomplete DA1 prefix (`ESC` / `ESC[` / `ESC[0`) spanning PTY reads. */
  da1Scanner: Da1Scanner
}

function pausePtyForFlowControl(entry: TerminalEntry): void {
  if (entry.ptyPaused || !entry.proc) return
  try {
    entry.proc.pause()
    entry.ptyPaused = true
  } catch {
    /* ignore — some platforms/adapters may not support pause */
  }
}

function resumePtyForFlowControl(entry: TerminalEntry): void {
  if (!entry.ptyPaused || !entry.proc) return
  try {
    entry.proc.resume()
    entry.ptyPaused = false
  } catch {
    /* ignore */
  }
}

function flushPendingOutput(entry: TerminalEntry, emit: EmitFn): void {
  if (entry.pendingOutputTimer) {
    clearTimeout(entry.pendingOutputTimer)
    entry.pendingOutputTimer = null
  }
  if (entry.disposed || entry.pendingOutput.length === 0) return
  const data =
    entry.pendingOutput.length === 1
      ? entry.pendingOutput[0]!
      : entry.pendingOutput.join("")
  entry.pendingOutput.length = 0
  entry.pendingOutputBytes = 0
  // Flow control counts chars (VS Code) — JS string length matches xterm write units.
  entry.unacknowledgedChars += data.length
  emit("terminal:data", [entry.id, data, entry.sequence])
  if (
    !entry.ptyPaused &&
    entry.unacknowledgedChars > TERMINAL_FLOW_HIGH_WATERMARK_CHARS
  ) {
    pausePtyForFlowControl(entry)
  }
}

function queueOutput(
  entry: TerminalEntry,
  data: string,
  dataBytes: number,
  emit: EmitFn,
): void {
  // Keep normal batches bounded. A single unusually large node-pty chunk is
  // forwarded intact so Unicode/control sequences are never split here.
  if (
    entry.pendingOutputBytes > 0 &&
    entry.pendingOutputBytes + dataBytes > TERMINAL_EMIT_BATCH_BYTES
  ) {
    flushPendingOutput(entry, emit)
  }
  entry.pendingOutput.push(data)
  entry.pendingOutputBytes += dataBytes
  if (entry.pendingOutputBytes >= TERMINAL_EMIT_BATCH_BYTES) {
    flushPendingOutput(entry, emit)
    return
  }
  // Interactive echo: first small chunk after idle must not wait 4ms.
  if (
    entry.pendingOutputBytes <= TERMINAL_EMIT_INTERACTIVE_BYTES &&
    entry.pendingOutput.length === 1 &&
    !entry.pendingOutputTimer
  ) {
    flushPendingOutput(entry, emit)
    return
  }
  if (!entry.pendingOutputTimer) {
    entry.pendingOutputTimer = setTimeout(
      () => flushPendingOutput(entry, emit),
      TERMINAL_EMIT_BATCH_DELAY_MS,
    )
  }
}

function defaultShell(): { command: string; args: string[] } {
  const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh")
  if (process.platform === "win32") return { command: shell, args: [] }
  const base = path.basename(shell)
  if (base === "zsh" || base === "bash") return { command: shell, args: ["-il"] }
  return { command: shell, args: [] }
}

function shellFallbacks(): string[] {
  if (process.platform === "win32") return ["powershell.exe", "cmd.exe"]
  return ["/bin/zsh", "/bin/bash", "/bin/sh"]
}

function trimReplay(entry: TerminalEntry, maxBytes = MAX_TERMINAL_REPLAY): void {
  let truncated = false
  while (
    entry.outputBytes > maxBytes &&
    entry.output.length - entry.outputHead > 1
  ) {
    const dropped = entry.output[entry.outputHead]!
    entry.output[entry.outputHead] = ""
    entry.outputHead += 1
    truncated = true
    entry.outputBytes -= Buffer.byteLength(dropped, "utf8")
  }
  if (
    entry.outputBytes > maxBytes &&
    entry.output.length - entry.outputHead === 1
  ) {
    const bytes = Buffer.from(entry.output[entry.outputHead]!, "utf8")
    let start = bytes.length - maxBytes
    truncated = true
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1
    entry.output[entry.outputHead] = bytes.subarray(start).toString("utf8")
    entry.outputBytes = Buffer.byteLength(entry.output[entry.outputHead], "utf8")
  }
  if (entry.outputHead > 1024 && entry.outputHead * 2 > entry.output.length) {
    entry.output = entry.output.slice(entry.outputHead)
    entry.outputHead = 0
  }
  if (truncated) entry.replayTruncated = true
}

export function normalizeTerminalSize(
  cols: number | undefined,
  rows: number | undefined,
): { cols: number; rows: number } | null {
  const requestedCols = cols ?? 80
  const requestedRows = rows ?? 24
  if (
    !Number.isFinite(requestedCols) ||
    !Number.isFinite(requestedRows) ||
    requestedCols <= 0 ||
    requestedRows <= 0
  ) {
    return null
  }
  return {
    cols: Math.min(Math.max(Math.trunc(requestedCols), 1), 1000),
    rows: Math.min(Math.max(Math.trunc(requestedRows), 1), 1000),
  }
}

export class TerminalHost {
  private readonly entries = new Map<string, TerminalEntry>()
  private seqCounter = 0
  private readonly titleCounts = new Map<string, number>()
  private emit: EmitFn = () => {}
  /** Cap concurrent entries; overridable in tests. */
  private readonly maxEntries: number

  constructor(maxEntries: number = MAX_TERMINAL_ENTRIES) {
    this.maxEntries = Math.max(1, Math.trunc(maxEntries))
  }

  setEmit(emit: EmitFn): void {
    this.emit = emit
  }

  /** Free exited slots for a new create. Never evict a live user shell. */
  private reclaimSlots(needed: number): void {
    if (needed <= 0 || this.entries.size === 0) return
    const exited: string[] = []
    for (const [id, entry] of this.entries) {
      if (entry.status === "exited") exited.push(id)
    }
    const victims = exited.slice(0, needed)
    for (const id of victims) this.dispose(id)
  }

  create(cwdUri: string, launch: TerminalLaunch | null | undefined, clientId: string): TerminalCreateResult {
    if (this.entries.size >= this.maxEntries) {
      // Reclaim retained exit snapshots, but never kill a running terminal to
      // make room for a new one.
      this.reclaimSlots(this.entries.size - this.maxEntries + 1)
    }
    if (this.entries.size >= this.maxEntries) {
      throw new Error(
        `too many terminals (max ${this.maxEntries}); close a terminal before creating another`,
      )
    }

    let cwd = cwdUri.length <= 32_768 ? uriToPath(cwdUri) : os.homedir()
    try {
      if (!fs.statSync(cwd).isDirectory()) cwd = os.homedir()
      else cwd = fs.realpathSync(cwd)
    } catch {
      cwd = os.homedir()
    }

    const custom = launch?.command
      ? { command: launch.command, args: launch.args ?? [] }
      : null
    const initialSize = normalizeTerminalSize(launch?.cols, launch?.rows) ?? {
      cols: 80,
      rows: 24,
    }

    const candidates: { command: string; args: string[] }[] = custom
      ? [{ command: custom.command, args: custom.args }]
      : [defaultShell(), ...shellFallbacks().map(command => ({ command, args: [] as string[] }))]

    let proc: pty.IPty | null = null
    let lastError: unknown
    const baseEnv: Record<string, string> = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      HOME: process.env.HOME ?? os.homedir(),
      ...launch?.env,
    } as Record<string, string>

    for (const candidate of candidates) {
      try {
        const launchSpec = custom
          ? { command: candidate.command, args: candidate.args, env: baseEnv }
          : applyShellCwdReporting(candidate.command, candidate.args, baseEnv)
        proc = pty.spawn(launchSpec.command, launchSpec.args, {
          name: "xterm-256color",
          cols: initialSize.cols,
          rows: initialSize.rows,
          cwd,
          env: launchSpec.env,
        })
        break
      } catch (error) {
        lastError = error
      }
    }
    if (!proc) throw new Error(`failed to spawn terminal: ${String(lastError)}`)

    const id = `term-${Date.now()}-${++this.seqCounter}`
    let title: string | null = null
    let titleKey: string | null = null
    if (!custom) {
      const base = path.basename(proc.process || defaultShell().command)
      titleKey = `${cwd}\0${base}`
      const n = (this.titleCounts.get(titleKey) ?? 0) + 1
      this.titleCounts.set(titleKey, n)
      title = n === 1 ? base : `${base} ${n}`
    }

    const entry: TerminalEntry = {
      id,
      title,
      titleKey,
      clientId,
      spawnCwd: cwd,
      spawnCommand: custom?.command ?? null,
      liveCwd: null,
      status: "running",
      exitCode: null,
      signal: null,
      sequence: 0,
      output: [],
      outputHead: 0,
      outputBytes: 0,
      replayTruncated: false,
      hasAttached: false,
      pendingOutput: [],
      pendingOutputBytes: 0,
      pendingOutputTimer: null,
      disposeTimer: null,
      unacknowledgedChars: 0,
      ptyPaused: false,
      proc,
      disposed: false,
      dataDisposable: null,
      exitDisposable: null,
      exitWaiters: [],
      da1Scanner: createDa1Scanner(),
    }
    this.entries.set(id, entry)

    entry.dataDisposable = proc.onData(data => {
      if (entry.disposed) return
      // Answer DA1 here — fish's 10s timer starts at spawn, not at Ghostty mount.
      const da1Queries = feedDa1Queries(entry.da1Scanner, data)
      if (da1Queries > 0 && entry.proc) {
        for (let i = 0; i < da1Queries; i++) entry.proc.write(TERMINAL_DA1_RESPONSE)
      }
      const oscCwd = parseOsc7Cwd(data)
      if (oscCwd) {
        try {
          entry.liveCwd = fs.realpathSync(oscCwd)
        } catch {
          entry.liveCwd = oscCwd
        }
      }
      entry.sequence += 1
      const dataBytes = Buffer.byteLength(data, "utf8")
      entry.output.push(data)
      entry.outputBytes += dataBytes
      trimReplay(entry)
      queueOutput(entry, data, dataBytes, this.emit)
    })

    entry.exitDisposable = proc.onExit(({ exitCode, signal }) => {
      if (entry.disposed) return
      // Preserve wire ordering: consumers must see the final output before exit.
      flushPendingOutput(entry, this.emit)
      entry.status = "exited"
      entry.exitCode = exitCode
      entry.signal = signal ?? null
      entry.proc = null
      trimReplay(entry, EXITED_TERMINAL_REPLAY)
      const args: unknown[] = [id, exitCode]
      if (entry.signal) args.push(entry.signal)
      this.emit("terminal:exit", args)
      for (const resolve of entry.exitWaiters.splice(0)) resolve({ exitCode, ...(signal ? { signal: String(signal) } : {}) })
      this.scheduleDisposeAfterExit(entry)
    })

    return { id, title }
  }

  private scheduleDisposeAfterExit(entry: TerminalEntry): void {
    if (entry.disposeTimer || entry.disposed) return
    entry.disposeTimer = setTimeout(() => {
      entry.disposeTimer = null
      if (entry.disposed) return
      this.dispose(entry.id)
    }, EXITED_TERMINAL_DISPOSE_TTL_MS)
    // Do not keep the process alive solely for this timer.
    entry.disposeTimer.unref?.()
  }

  private clearDisposeTimer(entry: TerminalEntry): void {
    if (!entry.disposeTimer) return
    clearTimeout(entry.disposeTimer)
    entry.disposeTimer = null
  }

  /**
   * Live working directory of the PTY process as a `file://` URI.
   * Prefers OS introspection of the foreground process, then OSC 7, then spawn cwd.
   */
  async getCwd(id: string): Promise<string | null> {
    if (id.length > 256) return null
    const entry = this.entries.get(id)
    if (!entry || entry.disposed) return null
    const pid = entry.proc?.pid
    const osCwd =
      typeof pid === "number" ? await cwdOfForeground(pid) : null
    let cwd = osCwd ?? entry.liveCwd ?? entry.spawnCwd
    if (!cwd) return null
    try {
      cwd = fs.realpathSync(cwd)
      if (!fs.statSync(cwd).isDirectory()) return pathToUri(entry.spawnCwd)
    } catch {
      return pathToUri(entry.spawnCwd)
    }
    return pathToUri(cwd)
  }

  /**
   * Basename of the foreground process under this PTY (e.g. `nvim`, `fish`).
   * Used for Deck icons / tab titles. `fresh` bypasses the process-table cache
   * for event-driven foreground transitions.
   */
  async getForegroundProcess(
    id: string,
    fresh = false,
  ): Promise<string | null> {
    if (id.length > 256) return null
    const entry = this.entries.get(id)
    if (!entry || entry.disposed) return null
    const pid = entry.proc?.pid
    if (typeof pid !== "number") return null
    const fg = await foregroundProcessOf(pid, { fresh })
    return fg?.name ?? null
  }

  inspect(id: string): TerminalInspectSnapshot | null {
    if (id.length > 256) return null
    const entry = this.entries.get(id)
    if (!entry || entry.disposed) return null
    return {
      id: entry.id,
      title: entry.title,
      status: entry.status,
      exitCode: entry.exitCode,
      signal: entry.signal,
      spawnCommand: entry.spawnCommand,
      spawnCwd: entry.spawnCwd,
    }
  }

  /** Running (non-disposed) PTYs — used by HQ when session payload lags behind. */
  listRunning(): TerminalInspectSnapshot[] {
    const out: TerminalInspectSnapshot[] = []
    for (const entry of this.entries.values()) {
      if (entry.disposed || entry.status !== "running") continue
      out.push({
        id: entry.id,
        title: entry.title,
        status: entry.status,
        exitCode: entry.exitCode,
        signal: entry.signal,
        spawnCommand: entry.spawnCommand,
        spawnCwd: entry.spawnCwd,
      })
    }
    return out
  }

  write(id: string, data: string): null {
    if (id.length > 256 || data.length > MAX_WRITE_BYTES) return null
    const entry = this.entries.get(id)
    entry?.proc?.write(data)
    return null
  }

  writeBinary(id: string, dataBase64: string): null {
    if (id.length > 256 || dataBase64.length > MAX_WRITE_BYTES * 2) return null
    const entry = this.entries.get(id)
    if (!entry?.proc) return null
    let data: Buffer
    try {
      data = Buffer.from(dataBase64, "base64")
    } catch {
      return null
    }
    if (data.byteLength > MAX_WRITE_BYTES) return null
    entry.proc.write(data)
    return null
  }

  resize(id: string, cols?: number, rows?: number): null {
    if (id.length > 256) return null
    const size = normalizeTerminalSize(cols, rows)
    if (!size) return null
    this.entries.get(id)?.proc?.resize(size.cols, size.rows)
    return null
  }

  /**
   * Renderer finished parsing `charCount` chars of previously emitted output.
   * Drop below the low watermark → resume a paused PTY (VS Code pattern).
   */
  acknowledgeData(id: string, charCount: number): null {
    if (id.length > 256) return null
    const entry = this.entries.get(id)
    if (!entry || entry.disposed) return null
    const n = Number.isFinite(charCount) ? Math.max(0, Math.trunc(charCount)) : 0
    entry.unacknowledgedChars = Math.max(0, entry.unacknowledgedChars - n)
    if (
      entry.ptyPaused &&
      entry.unacknowledgedChars < TERMINAL_FLOW_LOW_WATERMARK_CHARS
    ) {
      resumePtyForFlowControl(entry)
    }
    return null
  }

  /** Force-resume after attach/reconnect so a stale pause cannot stick forever. */
  clearUnacknowledgedChars(id: string): null {
    const entry = this.entries.get(id)
    if (!entry) return null
    entry.unacknowledgedChars = 0
    resumePtyForFlowControl(entry)
    return null
  }

  /**
   * A websocket can disappear after the client has received terminal output
   * but before its acknowledgement reaches the host. Clear that stale debt for
   * every PTY owned by the reconnecting client so flow control cannot leave a
   * shell suspended indefinitely.
   */
  resumeForClient(clientId: string): void {
    if (clientId.length > 256) return
    for (const entry of this.entries.values()) {
      if (entry.clientId !== clientId) continue
      // The renderer may have been torn down before parsing the final live
      // chunks. Make the next attach query-capable so a reconnect cannot leave
      // the shell waiting on a response that only Ghostty can generate.
      entry.hasAttached = false
      entry.unacknowledgedChars = 0
      resumePtyForFlowControl(entry)
    }
  }

  attach(
    id: string,
    clientId: string,
    afterSequence?: number,
  ): TerminalAttachSnapshot | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    // Client re-attached — cancel auto-dispose so replay stays available.
    this.clearDisposeTimer(entry)
    const replayNeedsQueryResponses =
      !entry.hasAttached || entry.clientId !== clientId
    // The renderer marks the replay ready after Ghostty has parsed it. Keeping
    // this false across an interrupted first attach lets a reload retry query
    // responses instead of leaving the live shell waiting forever.
    // Establish a clean sequence boundary. Otherwise a batch containing both
    // pre- and post-attach bytes could be accepted in full and duplicate replay.
    flushPendingOutput(entry, this.emit)
    entry.clientId = clientId
    // Replay is applied synchronously on the client — reset flow control so a
    // previous session's unacked count cannot keep the PTY paused.
    entry.unacknowledgedChars = 0
    resumePtyForFlowControl(entry)
    // If already exited, reschedule dispose after this attach window.
    if (entry.status === "exited") {
      this.scheduleDisposeAfterExit(entry)
    }
    const outputChunks = entry.output.slice(entry.outputHead)
    const replayFloor = entry.sequence - outputChunks.length + 1
    const hasRequestedSequence =
      typeof afterSequence === "number" && Number.isFinite(afterSequence)
    const requestedSequence = hasRequestedSequence
      ? Math.max(0, Math.trunc(afterSequence!))
      : replayFloor - 1
    const replayTruncated =
      entry.replayTruncated &&
      (!hasRequestedSequence || requestedSequence < replayFloor - 1)
    const replayOffset = Math.min(
      outputChunks.length,
      Math.max(0, requestedSequence + 1 - replayFloor),
    )
    return {
      id: entry.id,
      title: entry.title,
      // Slice the ring segments — do not join into one 2 MB string here.
      outputChunks: outputChunks.slice(replayOffset),
      output: "",
      replayTruncated,
      replayNeedsQueryResponses,
      lastSequence: entry.sequence,
      status: entry.status,
      exitCode: entry.exitCode,
      signal: entry.signal,
    }
  }

  /** Mark a live replay as parsed by the owning renderer. */
  markReplayReady(id: string, clientId: string): null {
    if (id.length > 256 || clientId.length > 256) return null
    const entry = this.entries.get(id)
    if (!entry || entry.disposed || entry.clientId !== clientId) return null
    entry.hasAttached = true
    return null
  }

  /** Bounded replay snapshot for an agent-owned PTY; does not attach or change ownership. */
  readOutput(id: string, maxBytes = EXITED_TERMINAL_REPLAY): { output: string; truncated: boolean } | null {
    const entry = this.entries.get(id)
    if (!entry || entry.disposed) return null
    const joined = entry.output.slice(entry.outputHead).join("")
    const encoded = Buffer.from(joined, "utf8")
    if (encoded.byteLength <= maxBytes) return { output: joined, truncated: false }
    return { output: encoded.subarray(encoded.byteLength - maxBytes).toString("utf8"), truncated: true }
  }

  waitForExit(id: string): Promise<{ exitCode: number | null; signal?: string }> {
    const entry = this.entries.get(id)
    if (!entry || entry.disposed) return Promise.reject(new Error("terminal not found"))
    if (entry.status === "exited") return Promise.resolve({ exitCode: entry.exitCode, ...(entry.signal ? { signal: String(entry.signal) } : {}) })
    return new Promise(resolve => entry.exitWaiters.push(resolve))
  }

  dispose(id: string): null {
    const entry = this.entries.get(id)
    if (!entry) return null
    this.entries.delete(id)
    entry.disposed = true
    this.clearDisposeTimer(entry)
    if (entry.pendingOutputTimer) clearTimeout(entry.pendingOutputTimer)
    entry.pendingOutputTimer = null
    entry.pendingOutput.length = 0
    entry.pendingOutputBytes = 0
    entry.unacknowledgedChars = 0
    resumePtyForFlowControl(entry)
    entry.dataDisposable?.dispose()
    entry.exitDisposable?.dispose()
    entry.dataDisposable = null
    entry.exitDisposable = null
    for (const resolve of entry.exitWaiters.splice(0)) resolve({ exitCode: null, signal: "disposed" })
    if (entry.titleKey) {
      const n = (this.titleCounts.get(entry.titleKey) ?? 1) - 1
      if (n <= 0) this.titleCounts.delete(entry.titleKey)
      else this.titleCounts.set(entry.titleKey, n)
    }
    try {
      entry.proc?.kill()
    } catch {
      /* ignore */
    }
    return null
  }

  stopAll(): void {
    for (const id of [...this.entries.keys()]) this.dispose(id)
  }
}
