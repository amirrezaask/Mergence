import type {
  AppSession,
  ProjectSearchResult,
  SessionId,
  SessionTabId,
  ToolUse,
  ToolUseId,
} from "@yaade/rpc"
import type { JetElectronTools, ToolSessionSnapshot } from "@yaade/workspace"
import { ToolSessionStore, type ToolRevisionGap } from "./tool-store.js"

const PAGE_SIZE = 100

type ToolApi = JetElectronTools

type ToolClientOptions = {
  readonly api?: ToolApi
  readonly store?: ToolSessionStore
  readonly window?: Pick<Window, "addEventListener" | "removeEventListener">
}

function toolApi(api?: ToolApi): ToolApi {
  if (api) return api
  const value = globalThis.window?.yaade?.tools
  if (!value) throw new Error("Tool API is unavailable")
  return value
}

/** Browser boundary for the host-owned Session/ToolUse control plane. */
export class ToolClient {
  readonly store: ToolSessionStore
  private readonly api: ToolApi
  private readonly eventWindow: Pick<Window, "addEventListener" | "removeEventListener">
  private disposeEvents: (() => void) | undefined
  private disposed = false
  private reconcilePromise: Promise<void> | undefined

  constructor(options: ToolClientOptions = {}) {
    this.store = options.store ?? new ToolSessionStore()
    this.api = toolApi(options.api)
    this.eventWindow = options.window ?? globalThis.window ?? {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }
    this.store.setRevisionGapHandler(gap => {
      void this.reconcileGap(gap)
    })
  }

  start(): () => void {
    if (this.disposeEvents) return this.disposeEvents
    const disposeToolEvents = this.api.onEvent(event => this.store.apply(event))
    const onReconnect = () => { void this.reconcile() }
    const onReplayGap = () => { void this.reconcile() }
    this.eventWindow.addEventListener("yaade:host-reconnected", onReconnect)
    this.eventWindow.addEventListener("yaade:host-replay-gap", onReplayGap)
    this.disposeEvents = () => {
      disposeToolEvents()
      this.eventWindow.removeEventListener("yaade:host-reconnected", onReconnect)
      this.eventWindow.removeEventListener("yaade:host-replay-gap", onReplayGap)
      this.disposeEvents = undefined
    }
    return this.disposeEvents
  }

  async hydrate(includeArchived = false): Promise<void> {
    this.store.setConnection("reconciling")
    try {
      const snapshots = await this.api.listSessions(includeArchived)
      this.replaceSnapshots(snapshots)
      await this.hydrateSearchResults(snapshots.flatMap(snapshot => snapshot.toolUses))
      this.store.setConnection("connected")
    } catch (error) {
      this.store.setConnection("offline")
      throw error
    }
  }

  async reconcile(): Promise<void> {
    if (this.disposed) return
    if (this.reconcilePromise) return this.reconcilePromise
    this.reconcilePromise = this.hydrate().finally(() => {
      this.reconcilePromise = undefined
    })
    return this.reconcilePromise
  }

  dispose(): void {
    this.disposed = true
    this.disposeEvents?.()
    this.store.setRevisionGapHandler(undefined)
  }

  private async reconcileGap(gap: ToolRevisionGap): Promise<void> {
    if (gap.entity === "session" || gap.entity === "tab") {
      const sessionId = gap.entity === "session"
        ? gap.id as SessionId
        : this.store.getSnapshot().tabsById.get(gap.id as SessionTabId)?.sessionId
      if (!sessionId) return
      const snapshot = await this.api.getSession(sessionId)
      if (snapshot) {
        this.store.replaceSession(snapshot.session, snapshot.toolUses, snapshot.tabs ?? [])
        await this.hydrateSearchResults(snapshot.toolUses)
      }
      return
    }
    const use = await this.api.getUse(gap.id as ToolUseId)
    if (!use) return
    this.store.replaceToolUse(use)
    await this.hydrateSearchResults([use])
  }

  private replaceSnapshots(snapshots: readonly ToolSessionSnapshot[]): void {
    this.store.replace(
      snapshots.map(snapshot => snapshot.session),
      snapshots.flatMap(snapshot => snapshot.toolUses),
      snapshots.flatMap(snapshot => snapshot.tabs ?? []),
    )
  }

  private async hydrateSearchResults(uses: readonly ToolUse[]): Promise<void> {
    for (const use of uses) {
      if (use.kind !== "search" || use.output.kind !== "search") continue
      const results: ProjectSearchResult[] = []
      let cursor = 0
      while (cursor < use.output.resultCount) {
        const page = await this.api.listSearchResults(
          use.id,
          use.output.resultRevision,
          cursor,
          PAGE_SIZE,
        )
        results.push(...page)
        if (page.length < PAGE_SIZE) break
        cursor += page.length
      }
      this.store.replaceSearchResults(use.id, results)
    }
  }
}

export function createToolClient(options: ToolClientOptions = {}): ToolClient {
  return new ToolClient(options)
}

export function activeToolUse(
  store: ToolSessionStore,
  sessionId: SessionId,
): ToolUse | undefined {
  const snapshot = store.getSnapshot()
  const tabId = snapshot.activeSessionId === sessionId
    ? snapshot.activeTabId
    : snapshot.sessionsById.get(sessionId)?.activeTabId
  const id = tabId
    ? snapshot.useIdsByTab.get(tabId)?.find(useId =>
        snapshot.usesById.get(useId)?.id === snapshot.tabsById.get(tabId)?.activeToolUseId,
      )
    : undefined
  return id ? snapshot.usesById.get(id) : undefined
}

export function sessionById(store: ToolSessionStore, id: SessionId): AppSession | undefined {
  return store.getSnapshot().sessionsById.get(id)
}
