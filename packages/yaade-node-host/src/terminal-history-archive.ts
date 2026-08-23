import fs from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { gzip, gunzip } from "node:zlib"
import { Schema } from "effect"

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

export type TerminalHistoryRecord = {
  readonly sequence: number
  readonly data: string
}

export type TerminalHistoryPage = {
  readonly chunks: string[]
  readonly firstSequence: number
  readonly lastSequence: number
  readonly nextSequence: number
  readonly complete: boolean
}

type ArchiveBlock = {
  readonly file: string
  readonly firstSequence: number
  readonly lastSequence: number
  readonly uncompressedBytes: number
  readonly storedBytes: number
}

type ArchiveManifest = {
  readonly version: 1
  readonly terminalId: string
  readonly createdAt: number
  updatedAt: number
  closedAt?: number
  blocks: ArchiveBlock[]
}

type ArchiveState = {
  readonly terminalId: string
  readonly dir: string
  readonly manifest: ArchiveManifest
  pending: TerminalHistoryRecord[]
  pendingBytes: number
  queuedBytes: number
  pressureActive: boolean
  writeTail: Promise<void>
}

export type TerminalHistoryArchiveOptions = {
  readonly rootDir: string
  readonly blockBytes?: number
  readonly pageBytes?: number
  readonly maxTerminalBytes?: number
  readonly maxTotalBytes?: number
  readonly closedRetentionMs?: number
  readonly onCommit?: (terminalId: string, sequence: number) => void
  readonly onPressureChange?: (terminalId: string, active: boolean) => void
}

const ArchiveBlockWire = Schema.Struct({
  file: Schema.String,
  firstSequence: Schema.Number,
  lastSequence: Schema.Number,
  uncompressedBytes: Schema.Number,
  storedBytes: Schema.Number,
})
const ArchiveManifestWire = Schema.Struct({
  version: Schema.Literal(1),
  terminalId: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  closedAt: Schema.optional(Schema.Number),
  blocks: Schema.Array(ArchiveBlockWire),
})
const TerminalHistoryRecordsWire = Schema.Array(Schema.Struct({
  sequence: Schema.Number,
  data: Schema.String,
}))

const MANIFEST_FILE = "index.json"
const ARCHIVE_QUEUE_HIGH_BYTES = 8 * 1024 * 1024
const ARCHIVE_QUEUE_LOW_BYTES = 2 * 1024 * 1024

/**
 * Durable, block-compressed PTY history. Blocks are immutable and indexed by
 * terminal sequence, allowing bounded replay pages without loading the full
 * transcript into memory.
 */
export class TerminalHistoryArchive {
  private readonly states = new Map<string, ArchiveState>()
  private readonly blockBytes: number
  readonly pageBytes: number
  private readonly maxTerminalBytes: number
  private readonly maxTotalBytes: number
  private readonly closedRetentionMs: number
  private readonly cleanupTimer: ReturnType<typeof setInterval>

  constructor(private readonly options: TerminalHistoryArchiveOptions) {
    this.blockBytes = options.blockBytes ?? 512 * 1024
    this.pageBytes = options.pageBytes ?? 256 * 1024
    this.maxTerminalBytes = options.maxTerminalBytes ?? 256 * 1024 * 1024
    this.maxTotalBytes = options.maxTotalBytes ?? 2 * 1024 * 1024 * 1024
    this.closedRetentionMs = options.closedRetentionMs ?? 7 * 24 * 60 * 60 * 1000
    fs.mkdirSync(options.rootDir, { recursive: true, mode: 0o700 })
    this.cleanupExpired()
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60 * 60 * 1000)
    this.cleanupTimer.unref?.()
  }

  append(terminalId: string, sequence: number, data: string): void {
    if (!data || !Number.isSafeInteger(sequence) || sequence < 1) return
    const state = this.stateFor(terminalId)
    state.pending.push({ sequence, data })
    state.pendingBytes += Buffer.byteLength(data, "utf8")
    state.manifest.updatedAt = Date.now()
    if (state.pendingBytes >= this.blockBytes) this.queueFlush(state)
  }

  committedThrough(terminalId: string): number {
    return this.states.get(terminalId)?.manifest.blocks.at(-1)?.lastSequence ?? 0
  }

  async readPage(
    terminalId: string,
    afterSequence: number,
    maxBytes = this.pageBytes,
  ): Promise<TerminalHistoryPage> {
    const state = this.stateFor(terminalId)
    this.queueFlush(state)
    await state.writeTail
    const limit = Math.max(1, Math.min(this.pageBytes, Math.trunc(maxBytes)))
    const chunks: string[] = []
    let bytes = 0
    let firstSequence = 0
    let lastSequence = Math.max(0, Math.trunc(afterSequence))
    for (const block of state.manifest.blocks) {
      if (block.lastSequence <= afterSequence) continue
      const compressed = await fs.promises.readFile(path.join(state.dir, block.file))
      const records = this.decodeRecords(await gunzipAsync(compressed))
      for (const record of records) {
        if (record.sequence <= afterSequence) continue
        const size = Buffer.byteLength(record.data, "utf8")
        if (chunks.length > 0 && bytes + size > limit) {
          return {
            chunks,
            firstSequence,
            lastSequence,
            nextSequence: lastSequence,
            complete: false,
          }
        }
        if (firstSequence === 0) firstSequence = record.sequence
        chunks.push(record.data)
        bytes += size
        lastSequence = record.sequence
      }
    }
    const newest = state.manifest.blocks.at(-1)?.lastSequence ?? afterSequence
    return {
      chunks,
      firstSequence,
      lastSequence,
      nextSequence: lastSequence,
      complete: lastSequence >= newest,
    }
  }

  closeTerminal(terminalId: string): void {
    const state = this.states.get(terminalId)
    if (!state) return
    state.manifest.closedAt = Date.now()
    this.queueFlush(state)
    state.writeTail = state.writeTail.then(() => this.writeManifest(state))
    void state.writeTail.then(() => this.enforceQuotas())
  }

  deleteTerminal(terminalId: string): void {
    const state = this.states.get(terminalId)
    this.states.delete(terminalId)
    const dir = state?.dir ?? this.terminalDir(terminalId)
    void fs.promises.rm(dir, { recursive: true, force: true })
  }

  async flushAll(): Promise<void> {
    for (const state of this.states.values()) this.queueFlush(state)
    await Promise.all([...this.states.values()].map(state => state.writeTail))
    this.enforceQuotas()
  }

  async close(): Promise<void> {
    clearInterval(this.cleanupTimer)
    await this.flushAll()
  }

  cleanupExpired(now = Date.now()): void {
    for (const name of fs.readdirSync(this.options.rootDir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue
      const dir = path.join(this.options.rootDir, name.name)
      const manifest = this.readManifest(dir)
      if (!manifest) {
        fs.rmSync(dir, { recursive: true, force: true })
        continue
      }
      if (manifest.closedAt === undefined) {
        // A previous host process cannot own a live PTY after restart.
        manifest.closedAt = now
        fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest), "utf8")
      } else if (now - manifest.closedAt > this.closedRetentionMs) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
    this.enforceQuotas()
  }

  private stateFor(terminalId: string): ArchiveState {
    const existing = this.states.get(terminalId)
    if (existing) return existing
    const dir = this.terminalDir(terminalId)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const manifest = this.readManifest(dir) ?? {
      version: 1,
      terminalId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      blocks: [],
    }
    delete manifest.closedAt
    const state: ArchiveState = {
      terminalId,
      dir,
      manifest,
      pending: [],
      pendingBytes: 0,
      queuedBytes: 0,
      pressureActive: false,
      writeTail: Promise.resolve(),
    }
    this.states.set(terminalId, state)
    return state
  }

  private queueFlush(state: ArchiveState): void {
    if (state.pending.length === 0) return
    const records = state.pending
    const uncompressedBytes = state.pendingBytes
    state.pending = []
    state.pendingBytes = 0
    state.queuedBytes += uncompressedBytes
    if (!state.pressureActive && state.queuedBytes >= ARCHIVE_QUEUE_HIGH_BYTES) {
      state.pressureActive = true
      this.options.onPressureChange?.(state.terminalId, true)
    }
    state.writeTail = state.writeTail.then(async () => {
      const firstSequence = records[0]!.sequence
      const lastSequence = records.at(-1)!.sequence
      const file = `${String(firstSequence).padStart(12, "0")}-${String(lastSequence).padStart(12, "0")}.json.gz`
      const encoded = Buffer.from(JSON.stringify(records), "utf8")
      const compressed = await gzipAsync(encoded, { level: 6 })
      const temporary = path.join(state.dir, `${file}.tmp`)
      await fs.promises.writeFile(temporary, compressed, { mode: 0o600 })
      await fs.promises.rename(temporary, path.join(state.dir, file))
      state.manifest.blocks.push({
        file,
        firstSequence,
        lastSequence,
        uncompressedBytes,
        storedBytes: compressed.byteLength,
      })
      await this.writeManifest(state)
      this.enforceTerminalQuota(state)
      this.enforceQuotas()
      this.options.onCommit?.(state.terminalId, lastSequence)
    }).catch(error => {
      console.warn(`[terminal-history] failed to persist ${state.terminalId}: ${String(error)}`)
    }).finally(() => {
      state.queuedBytes = Math.max(0, state.queuedBytes - uncompressedBytes)
      if (state.pressureActive && state.queuedBytes <= ARCHIVE_QUEUE_LOW_BYTES) {
        state.pressureActive = false
        this.options.onPressureChange?.(state.terminalId, false)
      }
    })
  }

  private async writeManifest(state: ArchiveState): Promise<void> {
    const target = path.join(state.dir, MANIFEST_FILE)
    const temporary = `${target}.tmp`
    await fs.promises.writeFile(temporary, JSON.stringify(state.manifest), {
      encoding: "utf8",
      mode: 0o600,
    })
    await fs.promises.rename(temporary, target)
  }

  private enforceTerminalQuota(state: ArchiveState): void {
    let bytes = state.manifest.blocks.reduce((total, block) => total + block.storedBytes, 0)
    while (bytes > this.maxTerminalBytes && state.manifest.blocks.length > 1) {
      const removed = state.manifest.blocks.shift()
      if (!removed) break
      bytes -= removed.storedBytes
      fs.rmSync(path.join(state.dir, removed.file), { force: true })
    }
    fs.writeFileSync(path.join(state.dir, MANIFEST_FILE), JSON.stringify(state.manifest), "utf8")
  }

  private enforceQuotas(): void {
    const stateByDir = new Map(
      [...this.states.values()].map(state => [state.dir, state]),
    )
    const archives: Array<{
      dir: string
      updatedAt: number
      bytes: number
      manifest: ArchiveManifest
      state?: ArchiveState
    }> = []
    let total = 0
    for (const name of fs.readdirSync(this.options.rootDir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue
      const dir = path.join(this.options.rootDir, name.name)
      const state = stateByDir.get(dir)
      const manifest = state?.manifest ?? this.readManifest(dir)
      if (!manifest) continue
      const bytes = manifest.blocks.reduce(
        (sum, block) => sum + block.storedBytes,
        0,
      )
      total += bytes
      const archive: {
        dir: string
        updatedAt: number
        bytes: number
        manifest: ArchiveManifest
        state?: ArchiveState
      } = {
        dir,
        updatedAt: manifest.updatedAt,
        bytes,
        manifest,
      }
      if (state) archive.state = state
      archives.push(archive)
    }
    archives.sort((left, right) => left.updatedAt - right.updatedAt)
    for (const archive of archives) {
      if (total <= this.maxTotalBytes) break
      if (!archive.state) {
        fs.rmSync(archive.dir, { recursive: true, force: true })
        total -= archive.bytes
        continue
      }
      while (
        total > this.maxTotalBytes &&
        archive.manifest.blocks.length > 1
      ) {
        const removed = archive.manifest.blocks.shift()
        if (!removed) break
        total -= removed.storedBytes
        fs.rmSync(path.join(archive.dir, removed.file), { force: true })
      }
      fs.writeFileSync(
        path.join(archive.dir, MANIFEST_FILE),
        JSON.stringify(archive.manifest),
        "utf8",
      )
    }
  }

  private readManifest(dir: string): ArchiveManifest | null {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8"))
      const decoded = Schema.decodeUnknownSync(ArchiveManifestWire)(value)
      const manifest: ArchiveManifest = {
        version: 1,
        terminalId: decoded.terminalId,
        createdAt: decoded.createdAt,
        updatedAt: decoded.updatedAt,
        blocks: decoded.blocks.map(block => ({ ...block })),
      }
      if (decoded.closedAt !== undefined) manifest.closedAt = decoded.closedAt
      return manifest
    } catch {
      return null
    }
  }

  private decodeRecords(data: Buffer): TerminalHistoryRecord[] {
    const value: unknown = JSON.parse(data.toString("utf8"))
    return Schema.decodeUnknownSync(TerminalHistoryRecordsWire)(value).map(record => ({
      sequence: record.sequence,
      data: record.data,
    }))
  }

  private terminalDir(terminalId: string): string {
    return path.join(
      this.options.rootDir,
      Buffer.from(terminalId, "utf8").toString("base64url"),
    )
  }
}
