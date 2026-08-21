export type SupervisorPeerWriterOptions = {
  readonly maxBytes?: number
  readonly maxFrames?: number
}

export type PeerSocket = {
  write(frame: Uint8Array): boolean
  once(event: "drain", listener: () => void): void
  destroy(): void
}

type QueuedFrame = {
  readonly kind: "reliable" | "legacy" | "semantic"
  readonly terminalId?: string
  frame: Buffer
  readonly order: number
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_FRAMES = 1_024

/**
 * Bounded writer for one host↔supervisor socket.
 * A stuck peer is closed; PTY output is never paused for backpressure.
 *
 * Reliable protocol frames and legacy raw PTY chunks are ordered FIFOs.
 * Semantic snapshots may replace a queued frame for the same terminal when
 * the receiver can resynchronize from a full snapshot.
 */
export class SupervisorPeerWriter {
  private readonly maxBytes: number
  private readonly maxFrames: number
  private readonly reliable: QueuedFrame[] = []
  private readonly legacy: QueuedFrame[] = []
  private readonly semantic = new Map<string, QueuedFrame>()
  /** Bytes accepted by the socket but not yet drained, plus queued bytes. */
  private bytes = 0
  private inFlight: QueuedFrame | null = null
  private nextOrder = 0
  private writing = false
  private closed = false

  constructor(
    private readonly socket: PeerSocket,
    options: SupervisorPeerWriterOptions = {},
  ) {
    this.maxBytes = Math.max(1, Math.trunc(options.maxBytes ?? DEFAULT_MAX_BYTES))
    this.maxFrames = Math.max(1, Math.trunc(options.maxFrames ?? DEFAULT_MAX_FRAMES))
  }

  /** Queued bytes exclude the frame currently held by the socket. */
  get pendingBytes(): number {
    return this.bytes - (this.inFlight?.frame.byteLength ?? 0)
  }

  /** Queued frames exclude the frame currently held by the socket. */
  get pendingFrames(): number {
    return (
      this.reliable.length +
      this.legacy.length +
      this.semantic.size
    )
  }

  private get boundedBytes(): number {
    return this.bytes
  }

  private get boundedFrames(): number {
    return this.pendingFrames + (this.inFlight ? 1 : 0)
  }

  get isClosed(): boolean {
    return this.closed
  }

  enqueueReliable(frame: Buffer): boolean {
    return this.push({ kind: "reliable", frame, order: this.nextOrder })
  }

  enqueueLegacyOutput(terminalId: string, frame: Buffer): boolean {
    return this.push({
      kind: "legacy",
      terminalId,
      frame,
      order: this.nextOrder,
    })
  }

  enqueueSemanticRender(terminalId: string, frame: Buffer): boolean {
    if (this.closed || frame.byteLength > this.maxBytes) {
      this.close()
      return false
    }
    const previous = this.semantic.get(terminalId)
    if (previous) {
      const nextBytes = this.bytes - previous.frame.byteLength + frame.byteLength
      if (nextBytes > this.maxBytes) {
        this.close()
        return false
      }
      this.bytes = nextBytes
      previous.frame = frame
      this.flush()
      return true
    }
    return this.push({
      kind: "semantic",
      terminalId,
      frame,
      order: this.nextOrder,
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.reliable.length = 0
    this.legacy.length = 0
    this.semantic.clear()
    this.inFlight = null
    this.bytes = 0
    this.socket.destroy()
  }

  private push(slot: QueuedFrame): boolean {
    if (
      this.closed ||
      slot.frame.byteLength > this.maxBytes ||
      this.boundedFrames + 1 > this.maxFrames ||
      this.boundedBytes + slot.frame.byteLength > this.maxBytes
    ) {
      this.close()
      return false
    }
    this.nextOrder += 1
    if (slot.kind === "reliable") this.reliable.push(slot)
    else if (slot.kind === "legacy") this.legacy.push(slot)
    else if (slot.terminalId) this.semantic.set(slot.terminalId, slot)
    this.bytes += slot.frame.byteLength
    this.flush()
    return true
  }

  private takeNext(): QueuedFrame | null {
    const reliable = this.reliable[0]
    const legacy = this.legacy[0]
    let semantic: QueuedFrame | null = null
    for (const candidate of this.semantic.values()) {
      if (!semantic || candidate.order < semantic.order) semantic = candidate
    }
    let next: QueuedFrame | null = null
    for (const candidate of [reliable, legacy, semantic]) {
      if (!candidate) continue
      if (!next || candidate.order < next.order) next = candidate
    }
    if (!next) return null
    if (next.kind === "reliable") this.reliable.shift()
    else if (next.kind === "legacy") this.legacy.shift()
    else if (next.terminalId) this.semantic.delete(next.terminalId)
    return next
  }

  private flush(): void {
    if (this.closed || this.writing) return
    this.writing = true
    this.flushLoop()
  }

  private flushLoop(): void {
    while (!this.closed) {
      const next = this.takeNext()
      if (!next) {
        this.writing = false
        if (!this.closed && this.pendingFrames > 0) {
          this.writing = true
          continue
        }
        return
      }
      this.inFlight = next
      try {
        if (!this.socket.write(next.frame)) {
          this.socket.once("drain", () => {
            if (this.closed) return
            this.inFlight = null
            this.bytes -= next.frame.byteLength
            this.flushLoop()
          })
          return
        }
        this.inFlight = null
        this.bytes -= next.frame.byteLength
      } catch {
        this.close()
        return
      }
    }
    this.writing = false
  }
}
