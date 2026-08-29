export const TERMINAL_SCHEDULER_BUDGETS = {
  interactiveBytes: 256,
  workerSliceBytes: 256 * 1024,
  livePendingBytes: 16 * 1024 * 1024,
  poolPendingBytes: 64 * 1024 * 1024,
  hiddenParseDelayMs: 100,
  synchronizedOutputTimeoutMs: 1_000,
  fairnessQuantumBytes: 256 * 1024,
  metricsCapacity: 512,
} as const;

export type TerminalPipelineStage =
  | "received"
  | "posted"
  | "parsed"
  | "presented";

export type TerminalPipelineToken = { readonly sequence: number };

type PipelineRecord = {
  sequence: number;
  bytes: number;
  postedBytes: number;
  receivedAt: number;
  postedAt: number;
  parsedAt: number;
  presentedAt: number;
};

export type TerminalSchedulerSnapshot = {
  readonly retainedSamples: number;
  readonly receivedBytes: number;
  readonly postedBytes: number;
  readonly parsedBytes: number;
  readonly presentedBytes: number;
  readonly pendingBytes: number;
  readonly maxPendingBytes: number;
  readonly oldestPendingAgeMs: number;
  readonly receivedToParsedP50: number;
  readonly receivedToParsedP95: number;
  readonly receivedToParsedP99: number;
  readonly receivedToPresentedP50: number;
  readonly receivedToPresentedP95: number;
  readonly receivedToPresentedP99: number;
};

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

/**
 * Payload-free, bounded accounting for the terminal transport pipeline. The
 * scheduler records correctness stages without making presentation part of ACK.
 */
export class TerminalFrameScheduler {
  private readonly records: PipelineRecord[] = [];
  private sequence = 0;
  private receivedBytes = 0;
  private postedBytes = 0;
  private parsedBytes = 0;
  private presentedBytes = 0;
  private pendingBytes = 0;
  private maxPendingBytes = 0;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly capacity = TERMINAL_SCHEDULER_BUDGETS.metricsCapacity,
  ) {}

  received(bytes: number): TerminalPipelineToken {
    const size = Math.max(0, Math.trunc(bytes));
    const record: PipelineRecord = {
      sequence: ++this.sequence,
      bytes: size,
      postedBytes: 0,
      receivedAt: this.now(),
      postedAt: 0,
      parsedAt: 0,
      presentedAt: 0,
    };
    this.records.push(record);
    this.receivedBytes += size;
    this.pendingBytes += size;
    this.maxPendingBytes = Math.max(this.maxPendingBytes, this.pendingBytes);
    this.trim();
    return { sequence: record.sequence };
  }

  posted(bytes: number): void {
    let remaining = Math.max(0, Math.trunc(bytes));
    const timestamp = this.now();
    for (const record of this.records) {
      if (remaining === 0) break;
      const available = record.bytes - record.postedBytes;
      if (available <= 0) continue;
      const amount = Math.min(available, remaining);
      record.postedBytes += amount;
      if (record.postedAt === 0) record.postedAt = timestamp;
      this.postedBytes += amount;
      remaining -= amount;
    }
  }

  parsed(token: TerminalPipelineToken): void {
    const record = this.records.find(candidate => candidate.sequence === token.sequence);
    if (!record || record.parsedAt !== 0) return;
    record.parsedAt = this.now();
    this.parsedBytes += record.bytes;
    this.pendingBytes = Math.max(0, this.pendingBytes - record.bytes);
  }

  presented(): void {
    const timestamp = this.now();
    for (const record of this.records) {
      if (record.parsedAt === 0 || record.presentedAt !== 0) continue;
      record.presentedAt = timestamp;
      this.presentedBytes += record.bytes;
    }
  }

  resetGeneration(): void {
    this.records.length = 0;
    this.pendingBytes = 0;
  }

  snapshot(): TerminalSchedulerSnapshot {
    const now = this.now();
    const parsed = this.records
      .filter(record => record.parsedAt !== 0)
      .map(record => record.parsedAt - record.receivedAt);
    const presented = this.records
      .filter(record => record.presentedAt !== 0)
      .map(record => record.presentedAt - record.receivedAt);
    const oldest = this.records.find(record => record.parsedAt === 0);
    return {
      retainedSamples: this.records.length,
      receivedBytes: this.receivedBytes,
      postedBytes: this.postedBytes,
      parsedBytes: this.parsedBytes,
      presentedBytes: this.presentedBytes,
      pendingBytes: this.pendingBytes,
      maxPendingBytes: this.maxPendingBytes,
      oldestPendingAgeMs: oldest ? Math.max(0, now - oldest.receivedAt) : 0,
      receivedToParsedP50: percentile(parsed, 0.5),
      receivedToParsedP95: percentile(parsed, 0.95),
      receivedToParsedP99: percentile(parsed, 0.99),
      receivedToPresentedP50: percentile(presented, 0.5),
      receivedToPresentedP95: percentile(presented, 0.95),
      receivedToPresentedP99: percentile(presented, 0.99),
    };
  }

  private trim(): void {
    while (this.records.length > this.capacity) {
      const index = this.records.findIndex(record => record.parsedAt !== 0);
      if (index < 0) this.records.shift();
      else this.records.splice(index, 1);
    }
  }
}
