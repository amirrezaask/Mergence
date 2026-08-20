export type EventHubIdentity = {
  readonly serverId: string
  readonly serverEpoch: string
}

export type HostEvent = {
  protocolVersion: number
  serverId?: string
  serverEpoch?: string
  sequence: number
  channel: string
  args: unknown[]
}

type Listener = (event: HostEvent) => void

type RetainedHostEvent = {
  event: HostEvent
  bytes: number
}

/**
 * Hot PTY paint frames. Still sequenced + fan-out live to WS subscribers, but
 * never retained in EventHub history — reconnect uses per-PTY `attach()` replay.
 * Keeping them in history filled the 1024/16MB ring and evicted every other channel.
 */
const EPHEMERAL_CHANNELS = new Set(["terminal:data"])

function estimateHostEventBytes(event: HostEvent): number {
  let bytes = 64 + Buffer.byteLength(event.channel, "utf8")
  for (const arg of event.args) {
    if (typeof arg === "string") bytes += Buffer.byteLength(arg, "utf8")
    else {
      try {
        bytes += Buffer.byteLength(JSON.stringify(arg) ?? "", "utf8")
      } catch {
        bytes += 64
      }
    }
  }
  return bytes
}

export class EventHub {
  private sequence = 0
  private history: Array<RetainedHostEvent | undefined> = []
  private historyHead = 0
  private historyBytes = 0
  private historyDroppedThrough = 0
  private readonly listeners = new Set<Listener>()
  private readonly capacity: number
  private readonly maxHistoryBytes: number
  private readonly identity: EventHubIdentity | null

  constructor(
    capacity = 1024,
    maxHistoryBytes = 16 * 1024 * 1024,
    identity: EventHubIdentity | null = null,
  ) {
    this.capacity = capacity
    this.maxHistoryBytes = maxHistoryBytes
    this.identity = identity
  }

  emit(channel: string, args: unknown[]): HostEvent {
    this.sequence += 1
    const event: HostEvent = this.identity
      ? {
          protocolVersion: 2,
          serverId: this.identity.serverId,
          serverEpoch: this.identity.serverEpoch,
          sequence: this.sequence,
          channel,
          args,
        }
      : {
          protocolVersion: 1,
          sequence: this.sequence,
          channel,
          args,
        }
    if (!EPHEMERAL_CHANNELS.has(channel)) {
      const eventBytes = estimateHostEventBytes(event)
      this.history.push({ event, bytes: eventBytes })
      this.historyBytes += eventBytes
      while (
        this.history.length - this.historyHead > 0 &&
        (this.history.length - this.historyHead > this.capacity ||
          this.historyBytes > this.maxHistoryBytes)
      ) {
        const dropped = this.history[this.historyHead]!
        this.history[this.historyHead] = undefined
        this.historyHead += 1
        this.historyBytes -= dropped.bytes
        this.historyDroppedThrough = Math.max(
          this.historyDroppedThrough,
          dropped.event.sequence,
        )
      }
      if (this.historyHead > 1024 && this.historyHead * 2 > this.history.length) {
        this.history = this.history.slice(this.historyHead)
        this.historyHead = 0
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* ignore listener errors */
      }
    }
    return event
  }

  replayAfter(since: number): HostEvent[] {
    const replay: HostEvent[] = []
    for (let index = this.historyHead; index < this.history.length; index += 1) {
      const retained = this.history[index]
      if (retained && retained.event.sequence > since) replay.push(retained.event)
    }
    return replay
  }

  replayWindow(since: number): {
    readonly events: HostEvent[]
    readonly replayFloor: number
    readonly lastSequence: number
    readonly historyEvicted: boolean
  } {
    const events = this.replayAfter(since)
    const oldest = this.history[this.historyHead]?.event.sequence
    const replayFloor = oldest ?? this.sequence + 1
    return {
      events,
      replayFloor,
      lastSequence: this.sequence,
      historyEvicted:
        since > 0 &&
        (oldest !== undefined
          ? since < oldest - 1
          : this.historyDroppedThrough > since),
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get lastSequence(): number {
    return this.sequence
  }

  get eventIdentity(): EventHubIdentity | null {
    return this.identity
  }
}
