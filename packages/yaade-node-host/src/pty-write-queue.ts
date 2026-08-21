const DEFAULT_MAX_BYTES = 1024 * 1024

export class PtyWriteQueueOverflow extends Error {
  constructor(message = "PTY write queue overflow") {
    super(message)
    this.name = "PtyWriteQueueOverflow"
  }
}

/**
 * Single ordered write queue for user input and terminal-generated responses.
 * User input is never dropped; overflow fails the enqueue instead of silently
 * discarding bytes. The sink is `node-pty` write, which is synchronous.
 */
export class PtyWriteQueue {
  private readonly pending: string[] = []
  private bytes = 0
  private flushing = false
  private closed = false

  constructor(
    private readonly sink: (data: string) => void,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {}

  get pendingBytes(): number {
    return this.bytes
  }

  enqueue(data: string): void {
    if (this.closed || data.length === 0) return
    const size = Buffer.byteLength(data, "utf8")
    if (size > this.maxBytes || this.bytes + size > this.maxBytes) {
      throw new PtyWriteQueueOverflow()
    }
    this.pending.push(data)
    this.bytes += size
    this.flush()
  }

  dispose(): void {
    this.closed = true
    this.pending.length = 0
    this.bytes = 0
  }

  private flush(): void {
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.pending.length > 0 && !this.closed) {
        const chunk = this.pending.shift()
        if (chunk === undefined) break
        this.bytes -= Buffer.byteLength(chunk, "utf8")
        this.sink(chunk)
      }
    } finally {
      this.flushing = false
    }
  }
}
