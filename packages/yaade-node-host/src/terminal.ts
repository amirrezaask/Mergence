import * as pty from "node-pty"
import type { GhosttyMouseInput } from "@yaade/ghostty-core"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToUri, uriToPath } from "./paths.js"
import {
  captureProcessIdentity,
  matchesProcessIdentity,
  signalVerifiedProcess,
  signalVerifiedProcessGroup,
  type ProcessIdentity,
} from "./process-identity.js"
import {
  BasicTerminalStateRecorder,
  type TerminalCheckpoint,
  type TerminalStateRecorder,
} from "./terminal-state/recorder.js"
import { sanitizePtyEnv } from "./terminal-env.js"
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
import {
  TerminalControlError,
  TerminalControlRegistry,
  type TerminalLease as RuntimeTerminalLease,
  type TerminalLeaseMode,
  type TerminalMutationFence,
} from "./terminal-control.js"
import {
  TerminalSemanticRuntime,
  type SemanticHistoryPage,
} from "./terminal-semantic-runtime.js"
import {
  TerminalRecoveryStore,
  type TerminalHistoryPersistence,
} from "./terminal-recovery-store.js"

/**
 * This is a bounded transcript, not a serialized terminal state. Once the
 * transcript is trimmed, a browser reload cannot faithfully restore Ghostty's
 * parser/mode state; the attach response marks that case explicitly.
 */
function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback
}

const MAX_TERMINAL_REPLAY = envInt("JET_TERMINAL_REPLAY_BYTES", 2 * 1024 * 1024)
const CHECKPOINT_BYTES = envInt("JET_CHECKPOINT_BYTES", 512 * 1024)
const CHECKPOINT_INTERVAL_MS = envInt("JET_CHECKPOINT_INTERVAL_MS", 2_000)
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
 * Legacy acknowledgement thresholds retained for protocol compatibility.
 * They are diagnostic limits only: client debt must never pause a PTY.
 */
export const TERMINAL_FLOW_HIGH_WATERMARK_CHARS = 100_000
export const TERMINAL_FLOW_LOW_WATERMARK_CHARS = 5_000
/** Legacy acknowledgement cadence; no acknowledgement resumes a PTY. */
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
  osPid: number | null
  /** Legacy diagnostic timestamp; cleanup uses processIdentity instead. */
  osStartedAtMs: number
  processIdentity: ProcessIdentity | null
  terminalEpoch: string
  ownerId?: string
  ownerEpoch?: string
  protocolVersion?: number
}

export type TerminalAttachSnapshot = {
  id: string
  title: string | null
  terminalEpoch: string
  ownerId?: string
  ownerEpoch?: string
  protocolVersion?: number
  checkpoint?: TerminalCheckpoint
  replayQuality: "exact" | "checkpoint" | "degraded"
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
  cols: number
  rows: number
  status: "running" | "exited"
  exitCode: number | null
  signal: number | null
  semanticSnapshot?: import("@yaade/rpc").TerminalSemanticSnapshot | null
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
  osPid: number | null
  processIdentity?: ProcessIdentity | null
  terminalEpoch?: string
  ownerId?: string
  ownerEpoch?: string
  protocolVersion?: number
}

type EmitFn = (channel: string, args: unknown[]) => void

type TerminalViewer = {
  hasAttached: boolean
  /** True only while this client's event socket is armed for live frames. */
  live: boolean
}

type TerminalEntry = {
  id: string
  title: string | null
  titleKey: string | null
  /** Last client that attached; used for query-replay ownership, not write locks. */
  clientId: string
  viewers: Map<string, TerminalViewer>
  lastAttachAt: number
  osPid: number | null
  osStartedAtMs: number
  processIdentity: ProcessIdentity | null
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
  pendingOutput: string[]
  pendingOutputBytes: number
  pendingOutputTimer: ReturnType<typeof setTimeout> | null
  disposeTimer: ReturnType<typeof setTimeout> | null
  killTimers: Array<ReturnType<typeof setTimeout>>
  proc: pty.IPty | null
  disposed: boolean
  dataDisposable: pty.IDisposable | null
  exitDisposable: pty.IDisposable | null
  exitWaiters: Array<(result: { exitCode: number | null; signal?: string }) => void>
  /** Incomplete DA1 prefix (`ESC` / `ESC[` / `ESC[0`) spanning PTY reads. */
  /** Legacy-only compatibility query scanner; Ghostty answers current queries. */
  da1Scanner: Da1Scanner | null
  terminalEpoch: string
  /** Legacy replay checkpoint parser; current semantic owners use Ghostty only. */
  recorder: TerminalStateRecorder | null
  checkpoint: TerminalCheckpoint | null
  checkpointSequence: number
  bytesSinceCheckpoint: number
  lastCheckpointAt: number
  cols: number
  rows: number
  semantic: TerminalSemanticRuntime | null
  stateRevision: number
}

function viewerOf(entry: TerminalEntry, clientId: string): TerminalViewer {
  let viewer = entry.viewers.get(clientId)
  if (!viewer) {
    viewer = { hasAttached: false, live: false }
    entry.viewers.set(clientId, viewer)
  }
  return viewer
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
  // Client queues are isolated at the transport boundary. Never pause a PTY
  // because a browser, WebSocket, or host peer is slow.
  emit("terminal:data", [entry.id, data, entry.sequence])
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

function replayFloor(entry: TerminalEntry): number {
  return entry.sequence - (entry.output.length - entry.outputHead) + 1
}

function trimReplay(
  entry: TerminalEntry,
  maxBytes = MAX_TERMINAL_REPLAY,
  ensureCheckpoint?: (target: TerminalEntry) => void,
): void {
  let truncated = false
  const canDropHead = (): boolean =>
    entry.output.length - entry.outputHead > 1 &&
    replayFloor(entry) <= entry.checkpointSequence
  while (entry.outputBytes > maxBytes && entry.output.length - entry.outputHead > 1) {
    if (!canDropHead()) {
      ensureCheckpoint?.(entry)
      if (!canDropHead()) break
    }
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
    if (replayFloor(entry) > entry.checkpointSequence) {
      ensureCheckpoint?.(entry)
    }
    if (replayFloor(entry) <= entry.checkpointSequence) {
      const bytes = Buffer.from(entry.output[entry.outputHead]!, "utf8")
      let start = bytes.length - maxBytes
      truncated = true
      while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1
      entry.output[entry.outputHead] = bytes.subarray(start).toString("utf8")
      entry.outputBytes = Buffer.byteLength(entry.output[entry.outputHead], "utf8")
    }
  }
  if (entry.outputHead > 1024 && entry.outputHead * 2 > entry.output.length) {
    entry.output = entry.output.slice(entry.outputHead)
    entry.outputHead = 0
  }
  if (truncated) entry.replayTruncated = true
}

function usableCheckpoint(value: TerminalCheckpoint | null | undefined): TerminalCheckpoint | undefined {
  if (!value || value.checkpointVersion !== 1) return undefined
  if (typeof value.sequence !== "number" || !Number.isFinite(value.sequence)) return undefined
  if (typeof value.syntheticAnsi !== "string" || value.syntheticAnsi.length === 0) return undefined
  if (typeof value.terminalEpoch !== "string" || value.terminalEpoch.length === 0) return undefined
  return value
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

export type TerminalHostOptions = {
  maxEntries?: number
  /** Delay between SIGHUP → SIGTERM → SIGKILL. Tests use a short value. */
  killGraceMs?: number
  /**
   * @deprecated Retained for callers compiled against the old API. Client
   * backpressure never pauses a PTY in any mode.
   */
  flowControl?: boolean
  /** Current-generation terminals parse output with Ghostty. */
  semanticState?: boolean
  recovery?: {
    readonly dataDir: string
    readonly ownerId: string
    readonly ownerEpoch: string
    readonly persistence?: TerminalHistoryPersistence
  }
}

export class TerminalHost {
  private readonly entries = new Map<string, TerminalEntry>()
  private seqCounter = 0
  private readonly titleCounts = new Map<string, number>()
  /** Supervisor-epoch idempotency for create retries after a lost response. */
  private readonly createRequests = new Map<string, TerminalCreateResult>()
  private readonly control = new TerminalControlRegistry()
  private emit: EmitFn = () => {}
  /** Cap concurrent entries; overridable in tests. */
  private readonly maxEntries: number
  private readonly killGraceMs: number
  private readonly semanticState: boolean
  private readonly recoveryStore: TerminalRecoveryStore | null
  private readonly recoveryOwner: {
    readonly ownerId: string
    readonly ownerEpoch: string
  } | null
  persistenceDegraded = false

  constructor(
    maxEntries: number | TerminalHostOptions = MAX_TERMINAL_ENTRIES,
  ) {
    if (typeof maxEntries === "number") {
      this.maxEntries = Math.max(1, Math.trunc(maxEntries))
      this.killGraceMs = 2_000
      this.semanticState = false
      this.recoveryStore = null
      this.recoveryOwner = null
    } else {
      this.maxEntries = Math.max(
        1,
        Math.trunc(maxEntries.maxEntries ?? MAX_TERMINAL_ENTRIES),
      )
      this.killGraceMs = Math.max(20, Math.trunc(maxEntries.killGraceMs ?? 2_000))
      this.semanticState = maxEntries.semanticState === true
      this.recoveryStore = maxEntries.recovery
        ? new TerminalRecoveryStore({
            dataDir: maxEntries.recovery.dataDir,
            persistence: maxEntries.recovery.persistence ?? "screen-only",
          })
        : null
      this.recoveryOwner = maxEntries.recovery
        ? {
            ownerId: maxEntries.recovery.ownerId,
            ownerEpoch: maxEntries.recovery.ownerEpoch,
          }
        : null
    }
  }

  setEmit(emit: EmitFn): void {
    this.emit = emit
  }

  /** Free exited slots for a new create. Never evict a live user shell. */
  private reclaimSlots(needed: number): void {
    if (needed <= 0 || this.entries.size === 0) return
    const exited: Array<{ id: string; lastAttachAt: number }> = []
    for (const [id, entry] of this.entries) {
      if (entry.status !== "exited") continue
      let viewed = false
      for (const viewer of entry.viewers.values()) {
        if (viewer.hasAttached) {
          viewed = true
          break
        }
      }
      if (viewed) continue
      exited.push({ id, lastAttachAt: entry.lastAttachAt })
    }
    exited.sort((a, b) => a.lastAttachAt - b.lastAttachAt)
    const victims = exited.slice(0, needed)
    for (const victim of victims) this.dispose(victim.id)
  }

  create(
    cwdUri: string,
    launch: TerminalLaunch | null | undefined,
    clientId: string,
    requestId?: string,
  ): TerminalCreateResult {
    if (requestId) {
      const previous = this.createRequests.get(requestId)
      if (previous) return previous
    }
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
    const launchEnv = launch?.env
    const baseEnv = sanitizePtyEnv(
      {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        HOME: process.env.HOME ?? os.homedir(),
        ...launchEnv,
      } as Record<string, string>,
      launchEnv,
    )

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

    const osPid = typeof proc.pid === "number" && proc.pid > 0 ? proc.pid : null
    const processIdentity = osPid === null ? null : captureProcessIdentity(osPid)
    const osStartedAtMs = Date.now()
    const terminalEpoch = randomUUID()
    const entry: TerminalEntry = {
      id,
      title,
      titleKey,
      clientId,
      viewers: new Map(),
      lastAttachAt: 0,
      osPid,
      osStartedAtMs,
      processIdentity,
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
      pendingOutput: [],
      pendingOutputBytes: 0,
      pendingOutputTimer: null,
      disposeTimer: null,
      killTimers: [],
      proc,
      disposed: false,
      dataDisposable: null,
      exitDisposable: null,
      exitWaiters: [],
      da1Scanner: this.semanticState ? null : createDa1Scanner(),
      terminalEpoch,
      recorder: this.semanticState
        ? null
        : new BasicTerminalStateRecorder(
            initialSize.cols,
            initialSize.rows,
            terminalEpoch,
          ),
      checkpoint: null,
      checkpointSequence: 0,
      bytesSinceCheckpoint: 0,
      lastCheckpointAt: Date.now(),
      cols: initialSize.cols,
      rows: initialSize.rows,
      semantic: null,
      stateRevision: 0,
    }
    this.entries.set(id, entry)
    this.control.registerTerminal(id, terminalEpoch)
    if (this.semanticState) {
      entry.semantic = TerminalSemanticRuntime.start({
        cols: initialSize.cols,
        rows: initialSize.rows,
        writeToPty: data => {
          if (entry.disposed || !entry.proc) return
          entry.proc.write(data)
        },
        onRevision: revision => {
          entry.stateRevision = revision
          const snapshot = entry.semantic?.snapshot() ?? null
          this.emit("terminal:semantic", [
            entry.id,
            revision,
            entry.terminalEpoch,
            snapshot,
          ])
          this.persistSemantic(entry, snapshot)
        },
      })
    }

    entry.dataDisposable = proc.onData(data => {
      if (entry.disposed) return
      if (entry.semantic) {
        entry.semantic.feedOutput(data)
      } else {
        // Answer DA1 here — fish's 10s timer starts at spawn, not at Ghostty mount.
        const da1Queries = entry.da1Scanner
          ? feedDa1Queries(entry.da1Scanner, data)
          : 0
        if (da1Queries > 0 && entry.proc) {
          for (let i = 0; i < da1Queries; i++) entry.proc.write(TERMINAL_DA1_RESPONSE)
        }
      }
      const oscCwd = parseOsc7Cwd(data)
      if (oscCwd) {
        // Defer realpath so a slow/NFS cwd cannot block the PTY read loop.
        queueMicrotask(() => {
          if (entry.disposed) return
          try {
            entry.liveCwd = fs.realpathSync(oscCwd)
          } catch {
            entry.liveCwd = oscCwd
          }
        })
      }
      entry.sequence += 1
      const dataBytes = Buffer.byteLength(data, "utf8")
      entry.recorder?.write(data)
      entry.bytesSinceCheckpoint += dataBytes
      if (
        entry.bytesSinceCheckpoint >= CHECKPOINT_BYTES ||
        Date.now() - entry.lastCheckpointAt >= CHECKPOINT_INTERVAL_MS
      ) {
        this.storeCheckpoint(entry)
      }
      entry.output.push(data)
      entry.outputBytes += dataBytes
      trimReplay(entry, MAX_TERMINAL_REPLAY, target => this.storeCheckpoint(target))
      queueOutput(entry, data, dataBytes, this.emit)
    })

    entry.exitDisposable = proc.onExit(({ exitCode, signal }) => {
      this.clearKillTimers(entry)
      if (entry.disposed) {
        entry.proc = null
        return
      }
      // Preserve wire ordering: consumers must see the final output before exit.
      flushPendingOutput(entry, this.emit)
      entry.status = "exited"
      entry.exitCode = exitCode
      this.storeCheckpoint(entry)
      entry.signal = signal ?? null
      entry.proc = null
      // Keep the terminal epoch/control record until explicit disposal so an
      // exited buffer remains attachable and its final screen can be read.
      trimReplay(entry, EXITED_TERMINAL_REPLAY, target => this.storeCheckpoint(target))
      const args: unknown[] = [id, exitCode]
      if (entry.signal) args.push(entry.signal)
      this.emit("terminal:exit", args)
      for (const resolve of entry.exitWaiters.splice(0)) resolve({ exitCode, ...(signal ? { signal: String(signal) } : {}) })
      this.scheduleDisposeAfterExit(entry)
    })

    const result = {
      id,
      title,
      osPid,
      osStartedAtMs,
      processIdentity,
      terminalEpoch,
      ...(this.recoveryOwner
        ? {
            ownerId: this.recoveryOwner.ownerId,
            ownerEpoch: this.recoveryOwner.ownerEpoch,
            protocolVersion: this.semanticState ? 2 : 1,
          }
        : this.semanticState
          ? { protocolVersion: 2 }
          : {}),
    }
    if (requestId) {
      this.createRequests.set(requestId, result)
      while (this.createRequests.size > 1024) {
        const oldest = this.createRequests.keys().next().value
        if (typeof oldest !== "string") break
        this.createRequests.delete(oldest)
      }
    }
    return result
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
      osPid: entry.osPid,
      processIdentity: entry.processIdentity,
      terminalEpoch: entry.terminalEpoch,
      ...(this.recoveryOwner
        ? {
            ownerId: this.recoveryOwner.ownerId,
            ownerEpoch: this.recoveryOwner.ownerEpoch,
            protocolVersion: this.semanticState ? 2 : 1,
          }
        : {}),
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
        osPid: entry.osPid,
        processIdentity: entry.processIdentity,
        terminalEpoch: entry.terminalEpoch,
        ...(this.recoveryOwner
          ? {
              ownerId: this.recoveryOwner.ownerId,
              ownerEpoch: this.recoveryOwner.ownerEpoch,
              protocolVersion: this.semanticState ? 2 : 1,
            }
          : {}),
      })
    }
    return out
  }

  write(id: string, data: string): null {
    if (id.length > 256 || data.length > MAX_WRITE_BYTES) return null
    const entry = this.entries.get(id)
    if (!entry || entry.disposed) return null
    if (entry.semantic) entry.semantic.enqueueUserInput(data)
    else entry.proc?.write(data)
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
    if (entry.semantic) entry.semantic.enqueueUserInput(data.toString("utf8"))
    else entry.proc.write(data)
    return null
  }

  /** Owner-side lease operations used by the versioned supervisor protocol. */
  acquireLease(
    terminalId: string,
    terminalEpoch: string,
    principalId: string,
    connectionId: string,
    mode: TerminalLeaseMode,
  ): RuntimeTerminalLease {
    return this.control.acquire({
      terminalId,
      terminalEpoch,
      principalId,
      connectionId,
      mode,
    })
  }

  renewLease(
    terminalId: string,
    terminalEpoch: string,
    leaseId: string,
    principalId: string,
    connectionId: string,
  ): RuntimeTerminalLease {
    return this.control.renew(
      terminalId,
      terminalEpoch,
      leaseId,
      principalId,
      connectionId,
    )
  }

  releaseLease(
    terminalId: string,
    terminalEpoch: string,
    leaseId: string,
    principalId: string,
    connectionId: string,
  ): null {
    this.control.release(
      terminalId,
      terminalEpoch,
      leaseId,
      principalId,
      connectionId,
    )
    return null
  }

  releaseConnection(connectionId: string): null {
    this.control.releaseConnection(connectionId)
    return null
  }

  forceTakeover(
    terminalId: string,
    terminalEpoch: string,
    principalId: string,
    connectionId: string,
  ): RuntimeTerminalLease {
    return this.control.forceTakeover(
      terminalId,
      terminalEpoch,
      principalId,
      connectionId,
    )
  }

  listLeases(terminalId: string): RuntimeTerminalLease[] {
    return this.control.list(terminalId)
  }

  currentWriterLease(id: string): RuntimeTerminalLease | null {
    try {
      return this.control.writer(id)
    } catch {
      return null
    }
  }

  transferLease(
    terminalId: string,
    terminalEpoch: string,
    leaseId: string,
    principalId: string,
    connectionId: string,
    targetPrincipalId: string,
    targetConnectionId: string,
  ): RuntimeTerminalLease {
    return this.control.transfer(
      terminalId,
      terminalEpoch,
      leaseId,
      principalId,
      connectionId,
      targetPrincipalId,
      targetConnectionId,
    )
  }

  writeFenced(id: string, data: string, fence: TerminalMutationFence): null {
    this.control.authorizeMutation(fence)
    return this.write(id, data)
  }

  writeBinaryFenced(
    id: string,
    dataBase64: string,
    fence: TerminalMutationFence,
  ): null {
    this.control.authorizeMutation(fence)
    return this.writeBinary(id, dataBase64)
  }

  resizeFenced(
    id: string,
    cols: number | undefined,
    rows: number | undefined,
    fence: TerminalMutationFence,
  ): null {
    this.control.authorizeMutation(fence)
    return this.resize(id, cols, rows)
  }

  disposeFenced(id: string, fence: TerminalMutationFence): null {
    this.control.authorizeMutation(fence)
    return this.dispose(id)
  }

  pasteFenced(id: string, data: string, fence: TerminalMutationFence): null {
    this.control.authorizeMutation(fence)
    const entry = this.entries.get(id)
    const encoded = entry?.semantic?.encodePaste(data) ?? data
    return this.write(id, encoded)
  }

  focusFenced(id: string, focused: boolean, fence: TerminalMutationFence): null {
    this.control.authorizeMutation(fence)
    return this.write(id, focused ? "\u001b[I" : "\u001b[O")
  }

  mouseFenced(
    id: string,
    input: GhosttyMouseInput,
    fence: TerminalMutationFence,
  ): null {
    this.control.authorizeMutation(fence)
    const entry = this.entries.get(id)
    if (!entry?.semantic) {
      throw new TerminalControlError(
        "WRITER_LEASE_REQUIRED",
        id,
        "structured mouse input is unavailable for this terminal",
      )
    }
    return this.write(id, entry.semantic.encodeMouse(input))
  }

  readSemanticSnapshot(id: string) {
    return this.entries.get(id)?.semantic?.snapshot() ?? null
  }

  readSemanticHistory(id: string, offset: number, limit: number): SemanticHistoryPage | null {
    const entry = this.entries.get(id)
    if (!entry?.semantic) return null
    return entry.semantic.historyPage(offset, limit)
  }

  waitForSemantic(id: string): Promise<void> {
    return this.entries.get(id)?.semantic?.ready() ?? Promise.resolve()
  }

  resize(id: string, cols?: number, rows?: number): null {
    if (id.length > 256) return null
    const size = normalizeTerminalSize(cols, rows)
    if (!size) return null
    const entry = this.entries.get(id)
    entry?.proc?.resize(size.cols, size.rows)
    if (entry && !entry.disposed) {
      entry.cols = size.cols
      entry.rows = size.rows
      entry.semantic?.resize(size.cols, size.rows)
      if (entry.recorder) {
        entry.recorder.resize(size.cols, size.rows)
        entry.checkpoint = entry.recorder.checkpoint(entry.sequence)
        entry.checkpointSequence = entry.sequence
        entry.bytesSinceCheckpoint = 0
        entry.lastCheckpointAt = Date.now()
      }
    }
    return null
  }

  /**
   * Compatibility acknowledgement. Queue bounds are enforced by the transport
   * mailbox, never by pausing the child process.
   */
  acknowledgeData(id: string, _charCount: number, _clientId?: string): null {
    if (id.length > 256) return null
    const entry = this.entries.get(id)
    if (!entry || entry.disposed) return null
    return null
  }

  /** Compatibility no-op retained for older host clients. */
  clearUnacknowledgedChars(_id: string): null {
    return null
  }

  /**
   * Deprecated compatibility operation. A slow socket must be isolated or
   * disconnected at the transport boundary; it must never pause a PTY.
   */
  pauseForBackpressure(_ids?: readonly string[]): void {}


  /**
   * Mark a viewer as receiving live `terminal:data` on an event socket.
   * HTTP attach must not call this — those clients never see live frames.
   */
  armLiveViewer(id: string, clientId: string): void {
    if (id.length > 256 || clientId.length > 256) return
    const entry = this.entries.get(id)
    if (!entry || entry.disposed) return
    viewerOf(entry, clientId).live = true
  }

  /** Remove a disconnected viewer without affecting PTY output. */
  resumeForClient(clientId: string): void {
    if (clientId.length > 256) return
    for (const entry of this.entries.values()) entry.viewers.delete(clientId)
  }

  /**
   * Compatibility operation used when no API remains connected. Output keeps
   * draining into the bounded replay/semantic runtime regardless of viewers.
   */
  resumeAllLiveViewers(): void {
    for (const entry of this.entries.values()) {
      if (entry.disposed) continue
      for (const viewer of entry.viewers.values()) viewer.live = false
      flushPendingOutput(entry, this.emit)
    }
  }

  private persistSemantic(
    entry: TerminalEntry,
    snapshot: import("@yaade/rpc").TerminalSemanticSnapshot | null,
  ): void {
    const store = this.recoveryStore
    const owner = this.recoveryOwner
    if (!store || !owner || !snapshot) return
    const payload = {
      terminalEpoch: entry.terminalEpoch,
      ownerId: owner.ownerId,
      ownerEpoch: owner.ownerEpoch,
      stateRevision: snapshot.revision,
      activeScreen: snapshot.activeScreen,
      snapshot,
    }
    setImmediate(() => {
      void store.write(payload).then(result => {
        if (result.written === false && result.reason === "io-error") {
          this.persistenceDegraded = true
        }
      })
    })
  }

  private storeCheckpoint(entry: TerminalEntry): void {
    if (!entry.recorder) return
    entry.checkpoint = entry.recorder.checkpoint(entry.sequence)
    entry.checkpointSequence = entry.sequence
    entry.bytesSinceCheckpoint = 0
    entry.lastCheckpointAt = Date.now()
    const directory =
      process.env.JET_CHECKPOINT_DIR ??
      (process.env.YAADE_PTY_SUPERVISOR_DATA_DIR
        ? `${process.env.YAADE_PTY_SUPERVISOR_DATA_DIR}/pty-checkpoints`
        : null)
    if (!directory) return
    try {
      fs.mkdirSync(directory, { recursive: true })
      const target = `${directory}/${entry.id}.json`
      const temporary = `${target}.${process.pid}.tmp`
      fs.writeFileSync(temporary, `${JSON.stringify(entry.checkpoint)}\n`)
      fs.renameSync(temporary, target)
    } catch {
      this.persistenceDegraded = true
    }
  }

  forceCheckpoint(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry || entry.disposed) return false
    this.storeCheckpoint(entry)
    return true
  }

  injectCheckpoint(id: string, checkpoint: unknown): boolean {
    const entry = this.entries.get(id)
    if (!entry || entry.disposed) return false
    entry.checkpoint = checkpoint as TerminalCheckpoint
    const sequence =
      checkpoint &&
      typeof checkpoint === "object" &&
      "sequence" in checkpoint &&
      typeof checkpoint.sequence === "number"
        ? checkpoint.sequence
        : entry.sequence
    entry.checkpointSequence = sequence
    entry.replayTruncated = true
    return true
  }

  attach(
    id: string,
    clientId: string,
    afterSequence?: number,
  ): TerminalAttachSnapshot | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    this.clearDisposeTimer(entry)
    const viewer = viewerOf(entry, clientId)
    const replayNeedsQueryResponses = !viewer.hasAttached
    flushPendingOutput(entry, this.emit)
    entry.clientId = clientId
    entry.lastAttachAt = Date.now()
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
    // A complete ring is exact byte replay. Checkpoint-only restore is for
    // clients that reconnect after the ring has already dropped prefix bytes.
    const checkpoint =
      entry.replayTruncated &&
      (!hasRequestedSequence || requestedSequence < entry.checkpointSequence)
        ? usableCheckpoint(entry.checkpoint)
        : undefined
    const rawRequestedSequence = checkpoint
      ? Math.max(requestedSequence, checkpoint.sequence)
      : requestedSequence
    const replayTruncated = checkpoint
      ? entry.replayTruncated
      : entry.replayTruncated &&
        (!hasRequestedSequence || requestedSequence < replayFloor - 1)
    const replayOffset = Math.min(
      outputChunks.length,
      Math.max(0, rawRequestedSequence + 1 - replayFloor),
    )
    return {
      id: entry.id,
      title: entry.title,
      terminalEpoch: entry.terminalEpoch,
      ...(this.recoveryOwner
        ? {
            ownerId: this.recoveryOwner.ownerId,
            ownerEpoch: this.recoveryOwner.ownerEpoch,
            protocolVersion: this.semanticState ? 2 : 1,
          }
        : this.semanticState
          ? { protocolVersion: 2 }
          : {}),
      ...(checkpoint ? { checkpoint } : {}),
      replayQuality: checkpoint ? "checkpoint" : replayTruncated ? "degraded" : "exact",
      outputChunks: outputChunks.slice(replayOffset),
      output: "",
      replayTruncated,
      replayNeedsQueryResponses,
      lastSequence: entry.sequence,
      cols: entry.cols,
      rows: entry.rows,
      status: entry.status,
      exitCode: entry.exitCode,
      signal: entry.signal,
      ...(entry.semantic ? { semanticSnapshot: entry.semantic.snapshot() } : {}),
    }
  }

  /** Mark a live replay as parsed by this renderer. */
  markReplayReady(id: string, clientId: string): null {
    if (id.length > 256 || clientId.length > 256) return null
    const entry = this.entries.get(id)
    if (!entry || entry.disposed) return null
    const viewer = entry.viewers.get(clientId)
    if (!viewer) return null
    viewer.hasAttached = true
    return null
  }

  hasViewer(id: string, clientId: string): boolean {
    const entry = this.entries.get(id)
    return Boolean(entry && !entry.disposed && entry.viewers.has(clientId))
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

  private clearKillTimers(entry: TerminalEntry): void {
    for (const timer of entry.killTimers) clearTimeout(timer)
    entry.killTimers.length = 0
  }

  private beginKill(entry: TerminalEntry): void {
    this.clearKillTimers(entry)
    const identity = entry.processIdentity
    const proc = entry.proc
    // The live node-pty handle is safe to close directly. Numeric PID/group
    // signals are only allowed after revalidating the OS start token.
    if (identity) {
      signalVerifiedProcessGroup(identity, "SIGHUP")
      signalVerifiedProcess(identity, "SIGHUP")
    }
    try {
      proc?.kill("SIGHUP")
    } catch {
      /* ignore */
    }
    const destroyable = proc as { destroy?: () => void } | null
    try {
      destroyable?.destroy?.()
    } catch {
      /* ignore */
    }
    if (!identity) {
      entry.proc = null
      return
    }
    const grace = this.killGraceMs
    const termTimer = setTimeout(() => {
      if (!matchesProcessIdentity(identity)) return
      signalVerifiedProcessGroup(identity, "SIGTERM")
      signalVerifiedProcess(identity, "SIGTERM")
    }, grace)
    const killTimer = setTimeout(() => {
      if (!matchesProcessIdentity(identity)) return
      signalVerifiedProcessGroup(identity, "SIGKILL")
      signalVerifiedProcess(identity, "SIGKILL")
    }, grace * 2)
    termTimer.unref?.()
    killTimer.unref?.()
    entry.killTimers.push(termTimer, killTimer)
  }

  dispose(id: string): null {
    const entry = this.entries.get(id)
    if (!entry) return null
    this.entries.delete(id)
    entry.disposed = true
    this.control.unregisterTerminal(id, entry.terminalEpoch)
    entry.semantic?.dispose()
    entry.semantic = null
    this.clearDisposeTimer(entry)
    if (entry.pendingOutputTimer) clearTimeout(entry.pendingOutputTimer)
    entry.pendingOutputTimer = null
    entry.pendingOutput.length = 0
    entry.pendingOutputBytes = 0
    entry.dataDisposable?.dispose()
    entry.dataDisposable = null
    entry.recorder?.dispose()
    for (const resolve of entry.exitWaiters.splice(0)) resolve({ exitCode: null, signal: "disposed" })
    if (entry.titleKey) {
      const n = (this.titleCounts.get(entry.titleKey) ?? 1) - 1
      if (n <= 0) this.titleCounts.delete(entry.titleKey)
      else this.titleCounts.set(entry.titleKey, n)
    }
    this.beginKill(entry)
    return null
  }

  stopAll(): void {
    for (const id of [...this.entries.keys()]) this.dispose(id)
  }
}
