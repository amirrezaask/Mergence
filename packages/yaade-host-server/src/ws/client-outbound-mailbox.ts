import { MAX_TERMINAL_STREAM_V3_BYTES } from "@yaade/rpc"

export type OutboundFrame = {
  readonly data: string | Uint8Array
  readonly bytes: number
  readonly terminalId?: string
}

export type MailboxLimits = {
  readonly reliableMaxFrames: number
  readonly reliableMaxBytes: number
  readonly legacyMaxFrames: number
  readonly legacyMaxBytes: number
  readonly semanticMaxTerminals: number
  readonly semanticMaxBytes: number
}

export type EnqueueResult = {
  readonly accepted: boolean
  readonly replaced: boolean
  readonly requiresResync: boolean
  readonly overflow: "reliable" | "legacy" | "semantic" | null
}

type QueuedFrame = {
  data: string | Uint8Array
  bytes: number
  terminalId?: string
  readonly kind: "reliable" | "legacy" | "semantic"
  readonly order: number
}

const DEFAULT_LIMITS: MailboxLimits = {
  reliableMaxFrames: 256,
  reliableMaxBytes: 2 * 1024 * 1024,
  legacyMaxFrames: 4_096,
  legacyMaxBytes: 8 * 1024 * 1024,
  semanticMaxTerminals: 64,
  // Keep this in sync with the largest frame the v3 encoder can produce.
  // The codec limit excludes its six-byte header.
  semanticMaxBytes: MAX_TERMINAL_STREAM_V3_BYTES + 6,
}

/**
 * Per-client outbound state.
 * Reliable control and legacy raw PTY chunks are ordered FIFOs and are never
 * replaced. Semantic snapshots are latest-state replaceable per terminal.
 */
export class ClientOutboundMailbox {
  private readonly limits: MailboxLimits
  private readonly reliable: QueuedFrame[] = []
  private reliableBytes = 0
  private readonly legacy: QueuedFrame[] = []
  private legacyBytes = 0
  private readonly semantic = new Map<string, QueuedFrame>()
  private semanticBytes = 0
  private nextOrder = 0
  private readonly resyncRequiredTerminals = new Set<string>()

  constructor(limits: Partial<MailboxLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
  }

  enqueueReliable(
    frame: OutboundFrame,
    reservedFrames = 0,
    reservedBytes = 0,
  ): EnqueueResult {
    if (
      frame.bytes > this.limits.reliableMaxBytes ||
      this.reliable.length + reservedFrames >= this.limits.reliableMaxFrames ||
      this.reliableBytes + reservedBytes + frame.bytes > this.limits.reliableMaxBytes
    ) {
      return {
        accepted: false,
        replaced: false,
        requiresResync: false,
        overflow: "reliable",
      }
    }
    this.reliable.push({ ...frame, kind: "reliable", order: this.nextOrder++ })
    this.reliableBytes += frame.bytes
    return {
      accepted: true,
      replaced: false,
      requiresResync: false,
      overflow: null,
    }
  }

  enqueueLegacyOutput(
    terminalId: string,
    frame: OutboundFrame,
    reservedFrames = 0,
    reservedBytes = 0,
  ): EnqueueResult {
    if (
      !terminalId ||
      frame.bytes > this.limits.legacyMaxBytes ||
      this.legacy.length + reservedFrames >= this.limits.legacyMaxFrames ||
      this.legacyBytes + reservedBytes + frame.bytes > this.limits.legacyMaxBytes
    ) {
      return {
        accepted: false,
        replaced: false,
        requiresResync: false,
        overflow: "legacy",
      }
    }
    this.legacy.push({
      ...frame,
      terminalId,
      kind: "legacy",
      order: this.nextOrder++,
    })
    this.legacyBytes += frame.bytes
    return {
      accepted: true,
      replaced: false,
      requiresResync: false,
      overflow: null,
    }
  }

  enqueueSemanticRender(
    terminalId: string,
    frame: OutboundFrame,
    reservedFrames = 0,
    reservedBytes = 0,
  ): EnqueueResult {
    if (!terminalId || frame.bytes > this.limits.semanticMaxBytes) {
      this.resyncRequiredTerminals.add(terminalId)
      return {
        accepted: false,
        replaced: false,
        requiresResync: true,
        overflow: "semantic",
      }
    }
    const previous = this.semantic.get(terminalId)
    if (previous) {
      if (
        this.semanticBytes - previous.bytes + reservedBytes + frame.bytes >
        this.limits.semanticMaxBytes
      ) {
        this.resyncRequiredTerminals.add(terminalId)
        return {
          accepted: false,
          replaced: false,
          requiresResync: true,
          overflow: "semantic",
        }
      }
      this.semanticBytes -= previous.bytes
      previous.data = frame.data
      previous.bytes = frame.bytes
      this.semanticBytes += frame.bytes
      this.resyncRequiredTerminals.add(terminalId)
      return {
        accepted: true,
        replaced: true,
        requiresResync: true,
        overflow: null,
      }
    }
    if (
      this.semantic.size + reservedFrames >= this.limits.semanticMaxTerminals ||
      this.semanticBytes + reservedBytes + frame.bytes > this.limits.semanticMaxBytes
    ) {
      this.resyncRequiredTerminals.add(terminalId)
      return {
        accepted: false,
        replaced: false,
        requiresResync: true,
        overflow: "semantic",
      }
    }
    this.semantic.set(terminalId, {
      ...frame,
      terminalId,
      kind: "semantic",
      order: this.nextOrder++,
    })
    this.semanticBytes += frame.bytes
    while (
      this.semantic.size > this.limits.semanticMaxTerminals ||
      this.semanticBytes > this.limits.semanticMaxBytes
    ) {
      const oldest = this.oldestSemanticTerminal()
      if (!oldest || oldest === terminalId) break
      const evicted = this.semantic.get(oldest)
      this.semantic.delete(oldest)
      if (evicted) this.semanticBytes -= evicted.bytes
      this.resyncRequiredTerminals.add(oldest)
    }
    const accepted = this.semantic.has(terminalId)
    if (!accepted) this.resyncRequiredTerminals.add(terminalId)
    return {
      accepted,
      replaced: false,
      requiresResync: this.resyncRequiredTerminals.has(terminalId),
      overflow: accepted ? null : "semantic",
    }
  }

  next(): OutboundFrame | null {
    const reliable = this.reliable[0]
    const legacy = this.legacy[0]
    let semantic: QueuedFrame | null = null
    let semanticTerminal: string | null = null
    for (const [terminalId, candidate] of this.semantic) {
      if (!semantic || candidate.order < semantic.order) {
        semanticTerminal = terminalId
        semantic = candidate
      }
    }
    let next: QueuedFrame | null = null
    let source: "reliable" | "legacy" | "semantic" | null = null
    if (reliable) {
      next = reliable
      source = "reliable"
    }
    if (legacy && (!next || legacy.order < next.order)) {
      next = legacy
      source = "legacy"
    }
    if (semantic && (!next || semantic.order < next.order)) {
      next = semantic
      source = "semantic"
    }
    if (!next || !source) return null
    if (source === "reliable") {
      this.reliable.shift()
      this.reliableBytes -= next.bytes
    } else if (source === "legacy") {
      this.legacy.shift()
      this.legacyBytes -= next.bytes
    } else if (semanticTerminal) {
      this.semantic.delete(semanticTerminal)
      this.semanticBytes -= next.bytes
    }
    return next
  }

  markResyncRequired(terminalId: string): void {
    this.resyncRequiredTerminals.add(terminalId)
  }

  consumeResyncRequired(): string[] {
    const terminals = [...this.resyncRequiredTerminals]
    this.resyncRequiredTerminals.clear()
    return terminals
  }

  get pendingReliableFrames(): number {
    return this.reliable.length
  }

  get pendingReliableBytes(): number {
    return this.reliableBytes
  }

  get pendingLegacyFrames(): number {
    return this.legacy.length
  }

  get pendingLegacyBytes(): number {
    return this.legacyBytes
  }

  get pendingRenderTerminals(): number {
    return this.semantic.size
  }

  get pendingRenderBytes(): number {
    return this.semanticBytes
  }

  get pendingBytes(): number {
    return this.reliableBytes + this.legacyBytes + this.semanticBytes
  }

  get pendingFrames(): number {
    return this.reliable.length + this.legacy.length + this.semantic.size
  }

  private oldestSemanticTerminal(): string | null {
    let oldestId: string | null = null
    let oldestOrder = Number.POSITIVE_INFINITY
    for (const [terminalId, frame] of this.semantic) {
      if (frame.order < oldestOrder) {
        oldestOrder = frame.order
        oldestId = terminalId
      }
    }
    return oldestId
  }
}
