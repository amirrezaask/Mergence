import type { TerminalWorkerCommand } from "./protocol.js";

export type WorkerPoolMessageHandler = (value: unknown) => void;
export type WorkerPoolErrorHandler = (error: Error) => void;

export interface TerminalWorkerChannel {
  post(command: TerminalWorkerCommand): void;
  release(): void;
}

type Slot = {
  worker: Worker;
  readonly terminals: Map<string, { message: WorkerPoolMessageHandler; error: WorkerPoolErrorHandler }>;
};

export const MAX_TERMINAL_WORKERS = 4;

function workerLimit(): number {
  const hardware = typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(MAX_TERMINAL_WORKERS, Math.floor(hardware / 2)));
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

export class TerminalWorkerPool {
  private readonly slots: Slot[] = [];
  private disposed = false;

  get workerCount(): number { return this.slots.length; }
  get terminalCount(): number {
    return this.slots.reduce((count, slot) => count + slot.terminals.size, 0);
  }

  acquire(
    terminalId: string,
    onMessage: WorkerPoolMessageHandler,
    onError: WorkerPoolErrorHandler,
  ): TerminalWorkerChannel {
    if (this.disposed) throw new Error("Terminal worker pool is disposed");
    const limit = workerLimit();
    while (this.slots.length < limit && this.slots.length <= this.terminalCount) {
      this.slots.push(this.createSlot());
    }
    const slot = this.slots[hash(terminalId) % this.slots.length];
    if (!slot) throw new Error("Terminal worker pool has no available worker");
    slot.terminals.set(terminalId, { message: onMessage, error: onError });
    let released = false;
    return {
      post: command => {
        if (!released) slot.worker.postMessage(command);
      },
      release: () => {
        if (released) return;
        released = true;
        slot.terminals.delete(terminalId);
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) slot.worker.terminate();
    this.slots.length = 0;
  }

  private createSlot(): Slot {
    const slot: Slot = {
      worker: this.createWorker(this.slots.length + 1),
      terminals: new Map(),
    };
    this.installSlotListeners(slot);
    return slot;
  }

  private createWorker(index: number): Worker {
    return new Worker(new URL("./terminal-worker.ts", import.meta.url), {
      type: "module",
      name: `yaade-terminal-${index}`,
    });
  }

  private installSlotListeners(slot: Slot): void {
    const worker = slot.worker;
    worker.addEventListener("message", event => {
      const value = event.data;
      if (typeof value !== "object" || value === null || !("terminalId" in value) || typeof value.terminalId !== "string") return;
      slot.terminals.get(value.terminalId)?.message(value);
    });
    const fail = (reason: unknown) => {
      if (this.disposed || slot.worker !== worker) return;
      const error = reason instanceof Error ? reason : new Error("Terminal worker failed");
      worker.terminate();
      slot.worker = this.createWorker(this.slots.indexOf(slot) + 1);
      this.installSlotListeners(slot);
      for (const listener of slot.terminals.values()) listener.error(error);
    };
    worker.addEventListener("error", fail);
    worker.addEventListener("messageerror", fail);
  }
}

let sharedPool: TerminalWorkerPool | null = null;

export function terminalWorkerPool(): TerminalWorkerPool {
  sharedPool ??= new TerminalWorkerPool();
  return sharedPool;
}
