import type {
  AgentRuntimeConnectionState,
  AgentRuntimeEvent,
  AgentRuntimeThreadRecovery,
  AgentRuntimeThreadSnapshot,
} from "@yaade/rpc"
import { reduceAgentThreadEvent } from "@yaade/agent-runtime"

export type AgentRuntimeThreadState = {
  snapshot: AgentRuntimeThreadSnapshot | null
  connection: AgentRuntimeConnectionState | null
  lastSequence: number
  gapDetected: boolean
  recovering: boolean
}

type Listener = () => void
type RecoveryListener = (threadId: string, afterSequence: number) => void

const EMPTY_THREAD: AgentRuntimeThreadState = {
  snapshot: null,
  connection: null,
  lastSequence: 0,
  gapDetected: false,
  recovering: false,
}

/** Canonically reduces per-thread events and invalidates React at most once per frame. */
export class AgentRuntimeStore {
  private readonly threads = new Map<string, AgentRuntimeThreadState>()
  private readonly listeners = new Set<Listener>()
  private readonly recoveryListeners = new Set<RecoveryListener>()
  private queued: AgentRuntimeEvent[] = []
  private frame: number | null = null

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onRecoveryNeeded(listener: RecoveryListener): () => void {
    this.recoveryListeners.add(listener)
    return () => this.recoveryListeners.delete(listener)
  }

  getThread(threadId: string): AgentRuntimeThreadState {
    return this.threads.get(threadId) ?? EMPTY_THREAD
  }

  getThreadIds(): readonly string[] {
    return [...this.threads.keys()]
  }

  hydrate(snapshot: AgentRuntimeThreadSnapshot): void {
    const threadId = String(snapshot.state.id)
    const current = this.threads.get(threadId)
    this.threads.set(threadId, {
      snapshot,
      connection: current?.connection ?? null,
      lastSequence: snapshot.state.lastSequence,
      gapDetected: false,
      recovering: false,
    })
    this.notify()
  }

  setConnection(threadId: string, connection: AgentRuntimeConnectionState): void {
    const current = this.threads.get(threadId) ?? EMPTY_THREAD
    if (
      current.connection?.status === connection.status &&
      current.connection.generation === connection.generation
    ) return
    this.threads.set(threadId, { ...current, connection })
    this.notify()
  }

  enqueue(event: AgentRuntimeEvent): void {
    this.queued.push(event)
    if (this.frame != null) return
    this.frame = scheduleFrame(() => this.flush())
  }

  flush(): void {
    if (this.frame != null) {
      cancelFrame(this.frame)
      this.frame = null
    }
    const queued = this.queued
    this.queued = []
    let changed = false
    const recoveryNeeded = new Map<string, number>()
    for (const event of queued) {
      const result = this.applyEvent(event)
      changed ||= result.changed
      if (result.recoveryAfter != null) {
        recoveryNeeded.set(String(event.threadId), result.recoveryAfter)
      }
    }
    if (changed) this.notify()
    for (const [threadId, afterSequence] of recoveryNeeded) {
      for (const listener of this.recoveryListeners) listener(threadId, afterSequence)
    }
  }

  applyRecovery(threadId: string, recovery: AgentRuntimeThreadRecovery): void {
    if (!recovery.snapshot || String(recovery.snapshot.state.id) !== threadId) {
      this.markRecoveryFailed(threadId)
      return
    }
    this.threads.set(threadId, {
      snapshot: recovery.snapshot,
      connection: this.threads.get(threadId)?.connection ?? null,
      lastSequence: recovery.snapshot.state.lastSequence,
      gapDetected: false,
      recovering: false,
    })
    for (const event of recovery.events) {
      if (String(event.threadId) === threadId) this.applyEvent(event)
    }
    this.notify()
  }

  markRecoveryFailed(threadId: string): void {
    const current = this.threads.get(threadId)
    if (!current) return
    this.threads.set(threadId, { ...current, recovering: false })
    this.notify()
  }

  private applyEvent(event: AgentRuntimeEvent): {
    changed: boolean
    recoveryAfter?: number
  } {
    const threadId = String(event.threadId)
    const current = this.threads.get(threadId) ?? EMPTY_THREAD
    if (event.sequence <= current.lastSequence) return { changed: false }
    if (!current.snapshot || event.sequence !== current.lastSequence + 1) {
      this.threads.set(threadId, {
        ...current,
        gapDetected: true,
        recovering: true,
      })
      return { changed: true, recoveryAfter: current.lastSequence }
    }
    const reduced = reduceAgentThreadEvent(current.snapshot, event)
    if (reduced.status !== "applied") {
      this.threads.set(threadId, {
        ...current,
        gapDetected: true,
        recovering: true,
      })
      return { changed: true, recoveryAfter: current.lastSequence }
    }
    this.threads.set(threadId, {
      snapshot: reduced.snapshot,
      connection: current.connection,
      lastSequence: event.sequence,
      gapDetected: false,
      recovering: false,
    })
    return { changed: true }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

function scheduleFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback)
  return globalThis.setTimeout(callback, 0) as unknown as number
}

function cancelFrame(frame: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame)
  else globalThis.clearTimeout(frame)
}
