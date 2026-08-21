import {
  ClientOutboundMailbox,
  type EnqueueResult,
  type MailboxLimits,
  type OutboundFrame,
} from "./client-outbound-mailbox.js"

export const WEBSOCKET_OPEN = 1

export type ClientSocketSink = {
  readonly readyState: number
  readonly bufferedAmount: number
  send(data: string | Uint8Array, cb?: (error?: Error) => void): void
  close(code?: number, reason?: string): void
  terminate(): void
}

export type SocketWriterCloseInfo = {
  readonly code: number
  readonly reason: string
  readonly pendingBytes: number
  readonly bufferedBytes: number
  readonly terminalId: string | null
}

export type ClientSocketWriterOptions = {
  readonly limits?: Partial<MailboxLimits>
  readonly onClose?: (info: SocketWriterCloseInfo) => void
}

/**
 * One ordered writer per browser WebSocket. All outbound frames go through
 * this mailbox. Send completion callbacks drive the next flush — never a
 * zero-delay poll loop.
 */
export class ClientSocketWriter {
  private readonly mailbox: ClientOutboundMailbox
  private readonly onClose: ((info: SocketWriterCloseInfo) => void) | undefined
  private sending = false
  private inFlightBytes = 0
  private inFlightFrames = 0
  private closed = false
  private lastTerminalId: string | null = null

  constructor(
    private readonly sink: ClientSocketSink,
    options: ClientSocketWriterOptions = {},
  ) {
    this.mailbox = new ClientOutboundMailbox(options.limits)
    this.onClose = options.onClose
  }

  get pendingBytes(): number {
    return this.mailbox.pendingBytes
  }

  get pendingFrames(): number {
    return this.mailbox.pendingFrames
  }

  get isClosed(): boolean {
    return this.closed
  }

  get currentTerminalId(): string | null {
    return this.lastTerminalId
  }

  consumeResyncRequired(): string[] {
    return this.mailbox.consumeResyncRequired()
  }

  enqueueReliable(data: string | Uint8Array): boolean {
    return this.commit(
      this.mailbox.enqueueReliable(
        this.frame(data),
        this.inFlightFrames,
        this.inFlightBytes,
      ),
    )
  }

  enqueueLegacyOutput(terminalId: string, data: string | Uint8Array): boolean {
    this.lastTerminalId = terminalId
    return this.commit(
      this.mailbox.enqueueLegacyOutput(
        terminalId,
        this.frame(data, terminalId),
        this.inFlightFrames,
        this.inFlightBytes,
      ),
    )
  }

  enqueueSemanticRender(terminalId: string, data: string | Uint8Array): boolean {
    this.lastTerminalId = terminalId
    return this.commit(
      this.mailbox.enqueueSemanticRender(
        terminalId,
        this.frame(data, terminalId),
        this.inFlightFrames,
        this.inFlightBytes,
      ),
    )
  }

  dispose(): void {
    this.closed = true
  }

  private frame(data: string | Uint8Array, terminalId?: string): OutboundFrame {
    return {
      data,
      bytes: typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength,
      ...(terminalId ? { terminalId } : {}),
    }
  }

  private commit(result: EnqueueResult): boolean {
    if (this.closed || this.sink.readyState !== WEBSOCKET_OPEN) return false
    if (!result.accepted) {
      const reason =
        result.overflow === "reliable"
          ? "reliable mailbox overflow"
          : result.overflow === "legacy"
            ? "legacy mailbox overflow"
            : "semantic mailbox overflow"
      this.close(1013, reason)
      return false
    }
    this.flush()
    return true
  }

  private flush(): void {
    if (this.closed || this.sending) return
    if (this.sink.readyState !== WEBSOCKET_OPEN) return
    const frame = this.mailbox.next()
    if (!frame) return
    this.sending = true
    this.inFlightFrames = 1
    this.inFlightBytes = frame.bytes
    try {
      this.sink.send(frame.data, (error) => {
        this.sending = false
        this.inFlightFrames = 0
        this.inFlightBytes = 0
        if (this.closed) return
        if (error) {
          this.close(1011, "websocket send failed")
          return
        }
        this.flush()
      })
    } catch {
      this.sending = false
      this.inFlightFrames = 0
      this.inFlightBytes = 0
      this.close(1011, "websocket send failed")
    }
  }

  private close(code: number, reason: string): void {
    if (this.closed) return
    this.closed = true
    const info: SocketWriterCloseInfo = {
      code,
      reason,
      pendingBytes: this.mailbox.pendingBytes,
      bufferedBytes: this.sink.bufferedAmount,
      terminalId: this.lastTerminalId,
    }
    try {
      this.sink.close(code, reason)
    } catch {
      this.sink.terminate()
    }
    this.onClose?.(info)
  }
}
