import type { AgentRuntimeRegistrySnapshot, AgentRuntimeThreadSnapshot } from "@yaade/rpc"
import type { JetElectronAgentRuntime } from "@yaade/workspace"
import { AgentRuntimeStore } from "./runtime-store.js"

/** Couples the host stream to the external store and repairs per-thread gaps. */
export class AgentRuntimeClient {
  readonly store = new AgentRuntimeStore()
  private readonly recovering = new Set<string>()
  private readonly unsubscribeEvent: () => void
  private readonly unsubscribeSnapshot: () => void
  private readonly unsubscribeConnection: () => void
  private readonly unsubscribeRegistry: () => void
  private readonly unsubscribeReplayGap: () => void
  private readonly unsubscribeRecovery: () => void
  private readonly registryListeners = new Set<(providers: AgentRuntimeRegistrySnapshot) => void>()

  constructor(private readonly api: JetElectronAgentRuntime) {
    this.unsubscribeEvent = api.onEvent(event => this.store.enqueue(event))
    this.unsubscribeSnapshot = api.onSnapshot(snapshot => this.hydrate(snapshot))
    this.unsubscribeConnection = api.onConnection(update => {
      const threadId = String(update.threadId)
      this.store.setConnection(threadId, update.state)
      if (update.state.status === "disconnected" || update.state.status === "unavailable") {
        this.recoverAll()
      }
    })
    this.unsubscribeRegistry = api.onRegistryChanged(providers => {
      for (const listener of this.registryListeners) listener(providers)
    })
    this.unsubscribeReplayGap = api.onReplayGap(() => this.recoverAll())
    this.unsubscribeRecovery = this.store.onRecoveryNeeded((threadId, afterSequence) => {
      void this.recover(threadId, afterSequence)
    })
  }

  hydrate(snapshot: AgentRuntimeThreadSnapshot): void {
    this.store.hydrate(snapshot)
    void this.refreshConnection(String(snapshot.state.id))
  }

  onRegistryChanged(listener: (providers: AgentRuntimeRegistrySnapshot) => void): () => void {
    this.registryListeners.add(listener)
    return () => this.registryListeners.delete(listener)
  }

  async recover(threadId: string, afterSequence?: number): Promise<void> {
    if (this.recovering.has(threadId)) return
    this.recovering.add(threadId)
    try {
      const recovery = await this.api.recoverThread(
        threadId,
        afterSequence ?? this.store.getThread(threadId).lastSequence,
      )
      this.store.applyRecovery(threadId, recovery)
    } catch {
      this.store.markRecoveryFailed(threadId)
    } finally {
      this.recovering.delete(threadId)
    }
  }

  private async refreshConnection(threadId: string): Promise<void> {
    try {
      this.store.setConnection(threadId, await this.api.getConnectionState(threadId))
    } catch {
      // The stream callback will publish a later connection update when available.
    }
  }

  private recoverAll(): void {
    for (const threadId of this.store.getThreadIds()) void this.recover(threadId)
  }

  close(): void {
    this.unsubscribeEvent()
    this.unsubscribeSnapshot()
    this.unsubscribeConnection()
    this.unsubscribeRegistry()
    this.unsubscribeReplayGap()
    this.unsubscribeRecovery()
    this.registryListeners.clear()
  }
}
