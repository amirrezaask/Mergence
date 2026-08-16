import { Schema } from "effect"
import { SessionTab, SessionTabId } from "@yaade/rpc"
import type {
  AppSession,
  ProjectSearchResult,
  SessionId,
  ToolEvent,
  ToolUse,
  ToolUseId,
} from "@yaade/rpc"

export type ToolStoreSnapshot = {
  readonly sessionsById: ReadonlyMap<SessionId, AppSession>
  readonly visibleSessionIds: readonly SessionId[]
  readonly tabsById: ReadonlyMap<SessionTabId, SessionTab>
  readonly visibleTabIdsBySession: ReadonlyMap<SessionId, readonly SessionTabId[]>
  readonly usesById: ReadonlyMap<ToolUseId, ToolUse>
  readonly useIdsBySession: ReadonlyMap<SessionId, readonly ToolUseId[]>
  readonly useIdsByTab: ReadonlyMap<SessionTabId, readonly ToolUseId[]>
  readonly searchResultsByUseId: ReadonlyMap<ToolUseId, readonly ProjectSearchResult[]>
  readonly activeSessionId: SessionId | undefined
  readonly activeTabId: SessionTabId | undefined
  readonly activeToolUseId: ToolUseId | undefined
  readonly connection: "connecting" | "connected" | "reconciling" | "offline"
}

type Listener = () => void

export type ToolRevisionGap = {
  readonly entity: "session" | "tab" | "toolUse" | "search"
  readonly id: SessionId | SessionTabId | ToolUseId
  readonly expectedRevision: number
  readonly actualRevision: number
}

function frame(callback: () => void): void {
  const raf = globalThis.requestAnimationFrame
  if (raf) {
    raf(callback)
    return
  }
  globalThis.setTimeout(callback, 16)
}

function fallbackTab(session: AppSession): SessionTab {
  const id = Schema.decodeUnknownSync(SessionTabId)(`tab-${session.id.slice(4)}`)
  return SessionTab.make({
    id,
    sessionId: session.id,
    title: "Window 1",
    position: 0,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  })
}

/** Normalized client state. PTY bytes intentionally never enter this store. */
export class ToolSessionStore {
  private sessionsById = new Map<SessionId, AppSession>()
  private visibleSessionIds: SessionId[] = []
  private tabsById = new Map<SessionTabId, SessionTab>()
  private visibleTabIdsBySession = new Map<SessionId, SessionTabId[]>()
  private usesById = new Map<ToolUseId, ToolUse>()
  private useIdsBySession = new Map<SessionId, ToolUseId[]>()
  private useIdsByTab = new Map<SessionTabId, ToolUseId[]>()
  private searchResultsByUseId = new Map<ToolUseId, readonly ProjectSearchResult[]>()
  private activeSessionId: SessionId | undefined
  private activeTabId: SessionTabId | undefined
  private activeToolUseId: ToolUseId | undefined
  private connection: ToolStoreSnapshot["connection"] = "connecting"
  private snapshot: ToolStoreSnapshot = this.makeSnapshot()
  private readonly listeners = new Set<Listener>()
  private readonly sessionListeners = new Map<SessionId, Set<Listener>>()
  private readonly tabListeners = new Map<SessionTabId, Set<Listener>>()
  private readonly useListeners = new Map<ToolUseId, Set<Listener>>()
  private readonly searchListeners = new Map<ToolUseId, Set<Listener>>()
  private readonly revisions = new Map<string, number>()
  private readonly searchRevisions = new Map<ToolUseId, number>()
  private pendingSearch = new Map<ToolUseId, ProjectSearchResult[]>()
  private searchFlushScheduled = false
  private revisionGapHandler: ((gap: ToolRevisionGap) => void) | undefined

  setRevisionGapHandler(handler: ((gap: ToolRevisionGap) => void) | undefined): void {
    this.revisionGapHandler = handler
  }

  getSnapshot = (): ToolStoreSnapshot => this.snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeSession(id: SessionId, listener: Listener): () => void {
    return this.subscribeEntity(this.sessionListeners, id, listener)
  }

  subscribeTab(id: SessionTabId, listener: Listener): () => void {
    return this.subscribeEntity(this.tabListeners, id, listener)
  }

  subscribeToolUse(id: ToolUseId, listener: Listener): () => void {
    return this.subscribeEntity(this.useListeners, id, listener)
  }

  subscribeSearchResults(id: ToolUseId, listener: Listener): () => void {
    return this.subscribeEntity(this.searchListeners, id, listener)
  }

  private subscribeEntity<K>(
    map: Map<K, Set<Listener>>,
    key: K,
    listener: Listener,
  ): () => void {
    const listeners = map.get(key) ?? new Set<Listener>()
    listeners.add(listener)
    map.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) map.delete(key)
    }
  }

  replaceToolUse(use: ToolUse): void {
    const sessions = [...this.sessionsById.values()]
    const tabs = [...this.tabsById.values()]
    const uses = [...this.usesById.values()].filter(candidate => candidate.id !== use.id)
    this.replace(sessions, [...uses, use], tabs)
  }

  replaceSession(
    session: AppSession,
    uses: readonly ToolUse[],
    tabs: readonly SessionTab[] = [],
  ): void {
    const sessions = [...this.sessionsById.values()].filter(candidate => candidate.id !== session.id)
    const existingUses = [...this.usesById.values()].filter(candidate => candidate.sessionId !== session.id)
    const existingTabs = [...this.tabsById.values()].filter(candidate => candidate.sessionId !== session.id)
    this.replace([...sessions, session], [...existingUses, ...uses], [...existingTabs, ...tabs])
  }

  replaceSearchResults(id: ToolUseId, results: readonly ProjectSearchResult[]): void {
    this.searchResultsByUseId = new Map(this.searchResultsByUseId).set(id, [...results])
    const use = this.usesById.get(id)
    if (use?.output.kind === "search") this.searchRevisions.set(id, use.output.resultRevision)
    this.notify(this.searchListeners, id)
    this.publish()
  }

  setConnection(connection: ToolStoreSnapshot["connection"]): void {
    if (this.connection === connection) return
    this.connection = connection
    this.publish()
  }

  /** `tabs` is optional so older host snapshots can be upgraded in memory. */
  replace(
    sessions: readonly AppSession[],
    uses: readonly ToolUse[],
    tabs: readonly SessionTab[] = [],
  ): void {
    this.sessionsById = new Map(sessions.map(session => [session.id, session]))
    this.visibleSessionIds = sessions
      .filter(session => !session.archivedAt)
      .sort((a, b) => a.position - b.position)
      .map(session => session.id)

    const nextTabs = [...tabs]
    for (const session of sessions) {
      if (!nextTabs.some(tab => tab.sessionId === session.id && !tab.archivedAt)) {
        nextTabs.push(fallbackTab(session))
      }
    }
    this.tabsById = new Map(nextTabs.map(tab => [tab.id, tab]))
    this.visibleTabIdsBySession = new Map()
    for (const tab of nextTabs) {
      if (tab.archivedAt) continue
      const ids = this.visibleTabIdsBySession.get(tab.sessionId) ?? []
      ids.push(tab.id)
      this.visibleTabIdsBySession.set(tab.sessionId, ids)
    }
    for (const ids of this.visibleTabIdsBySession.values()) {
      ids.sort((a, b) => (this.tabsById.get(a)?.position ?? 0) - (this.tabsById.get(b)?.position ?? 0))
    }

    this.usesById = new Map(uses.map(use => [use.id, use]))
    this.rebuildUseIndexes()
    this.reconcileSelection()
    this.publish()
  }

  selectSession(id: SessionId): void {
    if (!this.sessionsById.has(id) || this.activeSessionId === id) return
    this.activeSessionId = id
    this.activeTabId = this.selectedTabForSession(id)
    this.activeToolUseId = this.activeTabId
      ? this.selectedUseForTab(this.activeTabId)
      : undefined
    this.publish()
  }

  selectTab(id: SessionTabId): void {
    const tab = this.tabsById.get(id)
    if (!tab || tab.archivedAt) return
    this.activeSessionId = tab.sessionId
    this.activeTabId = id
    this.activeToolUseId = this.selectedUseForTab(id)
    this.publish()
  }

  selectToolUse(id: ToolUseId): void {
    const use = this.usesById.get(id)
    if (!use || use.archivedAt) return
    const tabId = this.tabIdForUse(use)
    if (!tabId) return
    this.activeSessionId = use.sessionId
    this.activeTabId = tabId
    this.activeToolUseId = id
    this.publish()
  }

  apply(event: ToolEvent): void {
    const isSearchEvent = event._tag === "SearchResultsReset" || event._tag === "SearchResultsAppended"
    let entityKey: string | undefined
    let entity: ToolRevisionGap["entity"] | undefined
    let entityId: SessionId | SessionTabId | ToolUseId | undefined
    let entityUpdatedAt: string | undefined

    if (event._tag === "SessionTabCreated" || event._tag === "SessionTabUpdated" || event._tag === "SessionTabArchived") {
      entityKey = `tab:${event.tab.id}`
      entity = "tab"
      entityId = event.tab.id
      entityUpdatedAt = event.tab.updatedAt
    } else if (!isSearchEvent && "toolUseId" in event) {
      entityKey = `use:${event.toolUseId}`
      entity = "toolUse"
      entityId = event.toolUseId
      entityUpdatedAt = "toolUse" in event ? event.toolUse.updatedAt : event.occurredAt
    } else if (!isSearchEvent && "session" in event) {
      entityKey = `session:${event.session.id}`
      entity = "session"
      entityId = event.session.id
      entityUpdatedAt = event.session.updatedAt
    }

    const current = entity === "tab" && entityId
      ? this.tabsById.get(entityId as SessionTabId)
      : entity === "session" && entityId
        ? this.sessionsById.get(entityId as SessionId)
        : entity === "toolUse" && entityId
          ? this.usesById.get(entityId as ToolUseId)
          : undefined
    const knownRevision = entityKey
      ? Math.max(
          this.revisions.get(entityKey) ?? 0,
          entity === "toolUse" && current && "revision" in current ? current.revision : 0,
        )
      : 0
    if (
      entityKey && knownRevision >= event.revision &&
      (!current || !entityUpdatedAt || current.updatedAt >= entityUpdatedAt)
    ) return
    if (entityKey && entity && entityId && knownRevision > 0 && event.revision > knownRevision + 1) {
      this.revisionGapHandler?.({
        entity,
        id: entityId,
        expectedRevision: knownRevision + 1,
        actualRevision: event.revision,
      })
    }
    if (entityKey) this.revisions.set(entityKey, event.revision)

    if (isSearchEvent) {
      const previousRevision = this.searchRevisions.get(event.toolUseId)
      if (previousRevision !== undefined && event.resultRevision < previousRevision) return
      if (previousRevision !== undefined && event.resultRevision > previousRevision + 1) {
        this.revisionGapHandler?.({
          entity: "search",
          id: event.toolUseId,
          expectedRevision: previousRevision + 1,
          actualRevision: event.resultRevision,
        })
      }
      if (event._tag === "SearchResultsReset") {
        this.searchRevisions.set(event.toolUseId, event.resultRevision)
        this.searchResultsByUseId = new Map(this.searchResultsByUseId).set(event.toolUseId, [])
        this.notify(this.searchListeners, event.toolUseId)
        this.publish()
        return
      }
      if (previousRevision !== event.resultRevision) return
    }

    switch (event._tag) {
      case "SessionCreated":
      case "SessionUpdated":
      case "SessionArchived":
      case "SessionRestored":
        this.sessionsById = new Map(this.sessionsById).set(event.session.id, event.session)
        this.rebuildVisibleSessions()
        if (event.session.id === this.activeSessionId && event.session.activeTabId) {
          const tabIds = this.visibleTabIdsBySession.get(event.session.id) ?? []
          if (tabIds.includes(event.session.activeTabId)) {
            this.activeTabId = event.session.activeTabId
            this.activeToolUseId = this.selectedUseForTab(event.session.activeTabId)
          }
        }
        break
      case "SessionTabCreated":
      case "SessionTabUpdated":
      case "SessionTabArchived":
        this.tabsById = new Map(this.tabsById).set(event.tab.id, event.tab)
        this.rebuildVisibleTabs()
        this.notify(this.tabListeners, event.tab.id)
        break
      case "ToolUseCreated":
      case "ToolUseUpdated":
        this.upsertUse(event.toolUse)
        break
      case "ToolUseOutputChanged": {
        const use = this.usesById.get(event.toolUseId)
        if (use) this.upsertUse({ ...use, output: event.output, revision: event.revision, updatedAt: event.occurredAt })
        break
      }
      case "SearchResultsAppended":
        this.queueSearch(event.toolUseId, event.results)
        break
      case "ToolUseArchived": {
        const use = this.usesById.get(event.toolUseId)
        if (use) this.upsertUse({ ...use, archivedAt: event.occurredAt, revision: event.revision, updatedAt: event.occurredAt })
        break
      }
    }
    this.reconcileSelection()
    this.publish()
  }

  private upsertUse(use: ToolUse): void {
    this.usesById = new Map(this.usesById).set(use.id, use)
    this.rebuildUseIndexes()
    this.notify(this.useListeners, use.id)
  }

  private rebuildUseIndexes(): void {
    this.useIdsBySession = new Map(
      this.visibleSessionIds.map(id => [id, [] as ToolUseId[]]),
    )
    this.useIdsByTab = new Map(
      [...this.tabsById.values()]
        .filter(tab => !tab.archivedAt)
        .map(tab => [tab.id, [] as ToolUseId[]]),
    )
    for (const use of this.usesById.values()) {
      if (use.archivedAt) continue
      const tabId = this.tabIdForUse(use)
      if (!tabId || this.tabsById.get(tabId)?.archivedAt) continue
      const sessionIds = this.useIdsBySession.get(use.sessionId) ?? []
      sessionIds.push(use.id)
      this.useIdsBySession.set(use.sessionId, sessionIds)
      const tabIds = this.useIdsByTab.get(tabId) ?? []
      tabIds.push(use.id)
      this.useIdsByTab.set(tabId, tabIds)
    }
    for (const ids of this.useIdsBySession.values()) {
      ids.sort((a, b) => (this.usesById.get(a)?.position ?? 0) - (this.usesById.get(b)?.position ?? 0))
    }
    for (const ids of this.useIdsByTab.values()) {
      ids.sort((a, b) => (this.usesById.get(a)?.position ?? 0) - (this.usesById.get(b)?.position ?? 0))
    }
  }

  private tabIdForUse(use: ToolUse): SessionTabId | undefined {
    if (use.tabId && this.tabsById.has(use.tabId)) return use.tabId
    return this.visibleTabIdsBySession.get(use.sessionId)?.[0]
  }

  private queueSearch(id: ToolUseId, results: readonly ProjectSearchResult[]): void {
    const pending = this.pendingSearch.get(id) ?? []
    this.pendingSearch.set(id, [...pending, ...results])
    if (this.searchFlushScheduled) return
    this.searchFlushScheduled = true
    frame(() => {
      this.searchFlushScheduled = false
      for (const [useId, batch] of this.pendingSearch) {
        const previous = this.searchResultsByUseId.get(useId) ?? []
        this.searchResultsByUseId = new Map(this.searchResultsByUseId).set(useId, [...previous, ...batch])
        this.notify(this.searchListeners, useId)
      }
      this.pendingSearch.clear()
      this.publish()
    })
  }

  private rebuildVisibleSessions(): void {
    this.visibleSessionIds = [...this.sessionsById.values()]
      .filter(session => !session.archivedAt)
      .sort((a, b) => a.position - b.position)
      .map(session => session.id)
  }

  private rebuildVisibleTabs(): void {
    this.visibleTabIdsBySession = new Map()
    for (const tab of this.tabsById.values()) {
      if (tab.archivedAt) continue
      const ids = this.visibleTabIdsBySession.get(tab.sessionId) ?? []
      ids.push(tab.id)
      this.visibleTabIdsBySession.set(tab.sessionId, ids)
    }
    for (const ids of this.visibleTabIdsBySession.values()) {
      ids.sort((a, b) => (this.tabsById.get(a)?.position ?? 0) - (this.tabsById.get(b)?.position ?? 0))
    }
    this.rebuildUseIndexes()
  }

  private selectedTabForSession(id: SessionId): SessionTabId | undefined {
    const ids = this.visibleTabIdsBySession.get(id) ?? []
    const session = this.sessionsById.get(id)
    return session?.activeTabId && ids.includes(session.activeTabId)
      ? session.activeTabId
      : ids[0]
  }

  private selectedUseForTab(id: SessionTabId): ToolUseId | undefined {
    const ids = this.useIdsByTab.get(id) ?? []
    const tab = this.tabsById.get(id)
    return tab?.activeToolUseId && ids.includes(tab.activeToolUseId)
      ? tab.activeToolUseId
      : ids[0]
  }

  private reconcileSelection(): void {
    if (!this.activeSessionId || !this.sessionsById.has(this.activeSessionId) || !this.visibleSessionIds.includes(this.activeSessionId)) {
      this.activeSessionId = this.visibleSessionIds[0]
    }
    if (!this.activeSessionId) {
      this.activeTabId = undefined
      this.activeToolUseId = undefined
      return
    }
    const tabIds = this.visibleTabIdsBySession.get(this.activeSessionId) ?? []
    if (!this.activeTabId || !tabIds.includes(this.activeTabId)) {
      this.activeTabId = this.selectedTabForSession(this.activeSessionId)
    }
    this.activeToolUseId = this.activeTabId
      ? this.activeToolUseId && (this.useIdsByTab.get(this.activeTabId) ?? []).includes(this.activeToolUseId)
        ? this.activeToolUseId
        : this.selectedUseForTab(this.activeTabId)
      : undefined
  }

  private makeSnapshot(): ToolStoreSnapshot {
    return {
      sessionsById: this.sessionsById,
      visibleSessionIds: this.visibleSessionIds,
      tabsById: this.tabsById,
      visibleTabIdsBySession: this.visibleTabIdsBySession,
      usesById: this.usesById,
      useIdsBySession: this.useIdsBySession,
      useIdsByTab: this.useIdsByTab,
      searchResultsByUseId: this.searchResultsByUseId,
      activeSessionId: this.activeSessionId,
      activeTabId: this.activeTabId,
      activeToolUseId: this.activeToolUseId,
      connection: this.connection,
    }
  }

  private publish(): void {
    this.snapshot = this.makeSnapshot()
    for (const listener of this.listeners) listener()
  }

  private notify<K>(map: Map<K, Set<Listener>>, key: K): void {
    for (const listener of map.get(key) ?? []) listener()
  }
}
