export type TerminalFlowDecision =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly acknowledgedSequence: number }

type SentFrame = {
  readonly sequence: number
  readonly bytes: number
}

type TerminalFlowState = {
  acknowledgedSequence: number
  outstandingBytes: number
  readonly sent: SentFrame[]
  sentHead: number
  resyncRequired: boolean
}

const DEFAULT_MAX_UNACKNOWLEDGED_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_SOCKET_UNACKNOWLEDGED_BYTES = 24 * 1024 * 1024

/**
 * Per-socket credit accounting for raw PTY output. A lagging terminal is
 * resynchronized independently instead of growing the shared socket mailbox or
 * disconnecting otherwise healthy terminals on the same connection.
 */
export class TerminalFlowControl {
  private readonly states = new Map<string, TerminalFlowState>()
  private totalOutstandingBytes = 0

  constructor(
    private readonly maxUnacknowledgedBytes = DEFAULT_MAX_UNACKNOWLEDGED_BYTES,
    private readonly maxSocketUnacknowledgedBytes =
      DEFAULT_MAX_SOCKET_UNACKNOWLEDGED_BYTES,
  ) {}

  reserve(terminalId: string, sequence: number, bytes: number): TerminalFlowDecision {
    const state = this.stateFor(terminalId)
    if (
      state.resyncRequired ||
      state.outstandingBytes + bytes > this.maxUnacknowledgedBytes ||
      this.totalOutstandingBytes + bytes >
        this.maxSocketUnacknowledgedBytes
    ) {
      state.resyncRequired = true
      return {
        accepted: false,
        acknowledgedSequence: state.acknowledgedSequence,
      }
    }
    state.sent.push({ sequence, bytes })
    state.outstandingBytes += bytes
    this.totalOutstandingBytes += bytes
    return { accepted: true }
  }

  acknowledge(terminalId: string, sequence: number): void {
    const state = this.states.get(terminalId)
    if (!state || sequence <= state.acknowledgedSequence) return
    state.acknowledgedSequence = sequence
    while (state.sentHead < state.sent.length) {
      const frame = state.sent[state.sentHead]
      if (!frame || frame.sequence > sequence) break
      state.outstandingBytes = Math.max(0, state.outstandingBytes - frame.bytes)
      this.totalOutstandingBytes = Math.max(
        0,
        this.totalOutstandingBytes - frame.bytes,
      )
      state.sentHead += 1
    }
    if (state.sentHead > 256 && state.sentHead * 2 > state.sent.length) {
      state.sent.splice(0, state.sentHead)
      state.sentHead = 0
    }
  }

  reset(terminalId: string, acknowledgedSequence = 0): void {
    const previous = this.states.get(terminalId)
    if (previous) {
      this.totalOutstandingBytes = Math.max(
        0,
        this.totalOutstandingBytes - previous.outstandingBytes,
      )
    }
    this.states.set(terminalId, {
      acknowledgedSequence,
      outstandingBytes: 0,
      sent: [],
      sentHead: 0,
      resyncRequired: false,
    })
  }

  delete(terminalId: string): void {
    const previous = this.states.get(terminalId)
    if (previous) {
      this.totalOutstandingBytes = Math.max(
        0,
        this.totalOutstandingBytes - previous.outstandingBytes,
      )
    }
    this.states.delete(terminalId)
  }

  get outstandingBytes(): number {
    return this.totalOutstandingBytes
  }

  private stateFor(terminalId: string): TerminalFlowState {
    const existing = this.states.get(terminalId)
    if (existing) return existing
    const created: TerminalFlowState = {
      acknowledgedSequence: 0,
      outstandingBytes: 0,
      sent: [],
      sentHead: 0,
      resyncRequired: false,
    }
    this.states.set(terminalId, created)
    return created
  }
}
