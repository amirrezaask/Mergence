import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export type TerminalHistoryPersistence = "disabled" | "screen-only" | "screen-and-scrollback"

export type TerminalRecoveryMetadata = {
  readonly schemaVersion: 1
  readonly terminalEpoch: string
  readonly ownerId: string
  readonly ownerEpoch: string
  readonly stateRevision: number
  readonly activeScreen: "primary" | "alternate"
  readonly persistence: Exclude<TerminalHistoryPersistence, "disabled">
  readonly checksum: string
  readonly bytes: number
  readonly writtenAt: string
}

export type TerminalRecoveryRecord = {
  readonly metadata: TerminalRecoveryMetadata
  readonly snapshot: unknown
}

export type RecoveryWriteResult =
  | { readonly written: true; readonly metadata: TerminalRecoveryMetadata }
  | { readonly written: false; readonly reason: "disabled" | "too-large" | "io-error" }

export type RecoveryReadResult =
  | { readonly record: TerminalRecoveryRecord; readonly source: "current" | "previous" }
  | { readonly record: null; readonly reason: "missing" | "corrupt" | "unsupported" }

export type TerminalRecoveryStoreOptions = {
  readonly dataDir: string
  readonly persistence?: TerminalHistoryPersistence
  readonly maxSnapshotBytes?: number
}

const DEFAULT_MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024

function recoveryDirectory(dataDir: string, terminalEpoch: string): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(terminalEpoch)) throw new Error("invalid terminal epoch")
  return path.join(dataDir, "terminal-recovery", terminalEpoch)
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return Object.fromEntries(Object.entries(value))
}

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function screenOnlySnapshot(snapshot: unknown): unknown {
  const record = jsonRecord(snapshot)
  if (!record) return snapshot
  const copy = { ...record }
  delete copy.scrollback
  delete copy.history
  return copy
}

function metadataFrom(value: unknown): TerminalRecoveryMetadata | null {
  const record = jsonRecord(value)
  if (
    !record ||
    record.schemaVersion !== 1 ||
    typeof record.terminalEpoch !== "string" ||
    typeof record.ownerId !== "string" ||
    typeof record.ownerEpoch !== "string" ||
    typeof record.stateRevision !== "number" ||
    !Number.isSafeInteger(record.stateRevision) ||
    (record.activeScreen !== "primary" && record.activeScreen !== "alternate") ||
    (record.persistence !== "screen-only" && record.persistence !== "screen-and-scrollback") ||
    typeof record.checksum !== "string" ||
    typeof record.bytes !== "number" ||
    !Number.isSafeInteger(record.bytes) ||
    typeof record.writtenAt !== "string"
  ) return null
  return {
    schemaVersion: 1,
    terminalEpoch: record.terminalEpoch,
    ownerId: record.ownerId,
    ownerEpoch: record.ownerEpoch,
    stateRevision: record.stateRevision,
    activeScreen: record.activeScreen,
    persistence: record.persistence,
    checksum: record.checksum,
    bytes: record.bytes,
    writtenAt: record.writtenAt,
  }
}

function parseRecord(value: unknown): TerminalRecoveryRecord | null {
  const record = jsonRecord(value)
  if (!record) return null
  const metadata = metadataFrom(record.metadata)
  if (!metadata || !("snapshot" in record)) return null
  const payload = Buffer.from(JSON.stringify(record.snapshot), "utf8")
  if (payload.byteLength !== metadata.bytes || checksum(payload) !== metadata.checksum) return null
  return { metadata, snapshot: record.snapshot }
}

/** Durable last-known terminal state. Writes are serialized per terminal and never throw into PTY code. */
export class TerminalRecoveryStore {
  private readonly dataDir: string
  private readonly persistence: TerminalHistoryPersistence
  private readonly maxSnapshotBytes: number
  private readonly pendingWrites = new Map<string, {
    input: {
      readonly terminalEpoch: string
      readonly ownerId: string
      readonly ownerEpoch: string
      readonly stateRevision: number
      readonly activeScreen: "primary" | "alternate"
      readonly snapshot: unknown
    } | null
    readonly waiters: Array<(result: RecoveryWriteResult) => void>
    running: boolean
  }>()

  constructor(options: TerminalRecoveryStoreOptions) {
    this.dataDir = options.dataDir
    this.persistence = options.persistence ?? "disabled"
    this.maxSnapshotBytes = Math.max(1, Math.trunc(options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES))
  }

  write(input: {
    readonly terminalEpoch: string
    readonly ownerId: string
    readonly ownerEpoch: string
    readonly stateRevision: number
    readonly activeScreen: "primary" | "alternate"
    readonly snapshot: unknown
  }): Promise<RecoveryWriteResult> {
    if (this.persistence === "disabled") {
      return Promise.resolve({ written: false, reason: "disabled" })
    }
    let pending = this.pendingWrites.get(input.terminalEpoch)
    if (!pending) {
      pending = { input: null, waiters: [], running: false }
      this.pendingWrites.set(input.terminalEpoch, pending)
    }
    pending.input = input
    const result = new Promise<RecoveryWriteResult>(resolve => {
      pending!.waiters.push(resolve)
    })
    if (!pending.running) {
      pending.running = true
      void this.drainWrites(input.terminalEpoch, pending)
    }
    return result
  }

  private async drainWrites(
    terminalEpoch: string,
    pending: {
      input: {
        readonly terminalEpoch: string
        readonly ownerId: string
        readonly ownerEpoch: string
        readonly stateRevision: number
        readonly activeScreen: "primary" | "alternate"
        readonly snapshot: unknown
      } | null
      readonly waiters: Array<(result: RecoveryWriteResult) => void>
      running: boolean
    },
  ): Promise<void> {
    let result: RecoveryWriteResult = { written: false, reason: "io-error" }
    try {
      while (pending.input) {
        const input = pending.input
        pending.input = null
        try {
          result = await this.writeNow(input)
        } catch {
          result = { written: false, reason: "io-error" }
        }
        // If output arrived during the filesystem write, the next iteration
        // persists only the newest state. No PTY callback waits for this loop.
      }
    } finally {
      pending.running = false
      this.pendingWrites.delete(terminalEpoch)
      for (const resolve of pending.waiters.splice(0)) resolve(result)
    }
  }

  async read(terminalEpoch: string): Promise<RecoveryReadResult> {
    const directory = recoveryDirectory(this.dataDir, terminalEpoch)
    for (const source of ["current", "previous"] as const) {
      try {
        const bytes = await fs.promises.readFile(path.join(directory, `${source}.snapshot`))
        const parsed = parseRecord(JSON.parse(bytes.toString("utf8")))
        if (!parsed || parsed.metadata.terminalEpoch !== terminalEpoch) continue
        return { record: parsed, source }
      } catch {
        /* Try the previous valid snapshot. */
      }
    }
    try {
      await fs.promises.access(directory)
      return { record: null, reason: "corrupt" }
    } catch {
      return { record: null, reason: "missing" }
    }
  }

  async remove(terminalEpoch: string): Promise<void> {
    await fs.promises.rm(recoveryDirectory(this.dataDir, terminalEpoch), {
      recursive: true,
      force: true,
    })
  }

  private async writeNow(input: {
    readonly terminalEpoch: string
    readonly ownerId: string
    readonly ownerEpoch: string
    readonly stateRevision: number
    readonly activeScreen: "primary" | "alternate"
    readonly snapshot: unknown
  }): Promise<RecoveryWriteResult> {
    const persistence: Exclude<TerminalHistoryPersistence, "disabled"> =
      this.persistence === "screen-only" ? "screen-only" : "screen-and-scrollback"
    const snapshot = persistence === "screen-only"
      ? screenOnlySnapshot(input.snapshot)
      : input.snapshot
    const snapshotBytes = Buffer.from(JSON.stringify(snapshot), "utf8")
    if (snapshotBytes.byteLength > this.maxSnapshotBytes) {
      return { written: false, reason: "too-large" }
    }
    const metadata: TerminalRecoveryMetadata = {
      schemaVersion: 1,
      terminalEpoch: input.terminalEpoch,
      ownerId: input.ownerId,
      ownerEpoch: input.ownerEpoch,
      stateRevision: input.stateRevision,
      activeScreen: input.activeScreen,
      persistence,
      checksum: checksum(snapshotBytes),
      bytes: snapshotBytes.byteLength,
      writtenAt: new Date().toISOString(),
    }
    const record: TerminalRecoveryRecord = { metadata, snapshot }
    const directory = recoveryDirectory(this.dataDir, input.terminalEpoch)
    await fs.promises.mkdir(directory, { recursive: true })
    const current = path.join(directory, "current.snapshot")
    const previous = path.join(directory, "previous.snapshot")
    const temporary = path.join(directory, `current.${process.pid}.${Date.now()}.tmp`)
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8")
    const handle = await fs.promises.open(temporary, "w", 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      try {
        await fs.promises.rename(current, previous)
      } catch {
        // Windows cannot replace an existing destination with rename; keep the
        // previous valid snapshot by removing only after the first attempt.
        await fs.promises.rm(previous, { force: true })
        await fs.promises.rename(current, previous).catch(() => undefined)
      }
      await fs.promises.rename(temporary, current)
      await fs.promises.open(directory, "r").then(async directoryHandle => {
        await directoryHandle.sync().catch(() => undefined)
        await directoryHandle.close()
      }).catch(() => undefined)
    } catch {
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined)
      return { written: false, reason: "io-error" }
    }
    return { written: true, metadata }
  }
}
