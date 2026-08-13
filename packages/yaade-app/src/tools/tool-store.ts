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
  readonly usesById: ReadonlyMap<ToolUseId, ToolUse>
  readonly useIdsBySession: ReadonlyMap<SessionId, readonly ToolUseId[]>
  readonly searchResultsByUseId: ReadonlyMap<ToolUseId, readonly ProjectSearchResult[]>
  readonly activeSessionId: SessionId | undefined
  readonly activeToolUseId: ToolUseId | undefined
  readonly connection: "connecting" | "connected" | "reconciling" | "offline"
}

type Listener = () => void

export type ToolRevisionGap = {
  readonly entity: "session" | "toolUse" | "search"
  readonly id: SessionId | ToolUseId
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

/** Normalized client state. PTY bytes intentionally never enter this store. */
export class ToolSessionStore {
  private sessionsById = new Map<SessionId, AppSession>()
  private visibleSessionIds: SessionId[] = []
  private usesById = new Map<ToolUseId, ToolUse>()
  private useIdsBySession = new Map<SessionId, ToolUseId[]>()
  private searchResultsByUseId = new Map<ToolUseId, readonly ProjectSearchResult[]>()
  private activeSessionId: SessionId | undefined
  private activeToolUseId: ToolUseId | undefined
  private connection: ToolStoreSnapshot["connection"] = "connecting"
  private snapshot: ToolStoreSnapshot = this.makeSnapshot()
  private readonly listeners = new Set<Listener>()
  private readonly sessionListeners = new Map<SessionId, Set<Listener>>()
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

  subscribeToolUse(id: ToolUseId, listener: Listener): () => void {
    return this.subscribeEntity(this.useListeners, id, listener)
  }

  subscribeSearchResults(id: ToolUseId, listener: Listener): () => void {
    return this.subscribeEntity(this.searchListeners, id, listener)
  }

  private subscribeEntity<K>(map: Map<K, Set<Listener>>, key: K, listener: Listener): () => void {
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
    const uses = [...this.usesById.values()].filter(candidate => candidate.id !== use.id)
    this.replace(sessions, [...uses, use])
  }

  replaceSession(session: AppSession, uses: readonly ToolUse[]): void {
    const sessions = [...this.sessionsById.values()].filter(candidate => candidate.id !== session.id)
    const existingUses = [...this.usesById.values()].filter(candidate => candidate.sessionId !== session.id)
    this.replace([...sessions, session], [...existingUses, ...uses])
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

  replace(sessions: readonly AppSession[], uses: readonly ToolUse[]): void {
    this.sessionsById = new Map(sessions.map(session => [session.id, session]))
    this.visibleSessionIds = sessions
      .filter(session => !session.archivedAt)
      .sort((a, b) => a.position - b.position)
      .map(session => session.id)
    this.usesById = new Map(uses.map(use => [use.id, use]))
    this.useIdsBySession = new Map()
    for (const use of uses) {
      if (use.archivedAt) continue
      const ids = this.useIdsBySession.get(use.sessionId) ?? []
      ids.push(use.id)
      this.useIdsBySession.set(use.sessionId, ids)
    }
    this.reconcileSelection()
    this.publish()
  }

  selectSession(id: SessionId): void {
    if (!this.sessionsById.has(id) || this.activeSessionId === id) return
    this.activeSessionId = id
    this.activeToolUseId = this.selectedUseForSession(id)
    this.publish()
  }

  selectToolUse(id: ToolUseId): void {
    const use = this.usesById.get(id)
    if (!use || this.activeToolUseId === id) return
    this.activeSessionId = use.sessionId
    this.activeToolUseId = id
    this.publish()
  }

  apply(event: ToolEvent): void {
    const isSearchEvent = event._tag === "SearchResultsReset" || event._tag === "SearchResultsAppended"
    let entityKey: string | undefined
    let entity: ToolRevisionGap["entity"] | undefined
    let toolUseEventId: ToolUseId | undefined
    let sessionEventId: SessionId | undefined
    let entityUpdatedAt: string | undefined
    if (!isSearchEvent && "toolUseId" in event) {
      entityKey = `use:${event.toolUseId}`
      entity = "toolUse"
      toolUseEventId = event.toolUseId
      entityUpdatedAt = "toolUse" in event ? event.toolUse.updatedAt : event.occurredAt
    } else if (!isSearchEvent && "session" in event) {
      entityKey = `session:${event.session.id}`
      entity = "session"
      sessionEventId = event.session.id
      entityUpdatedAt = event.session.updatedAt
    }
    const eventToolUse = toolUseEventId ? this.usesById.get(toolUseEventId) : undefined
    const eventSession = sessionEventId ? this.sessionsById.get(sessionEventId) : undefined
    const knownRevision = entityKey && entity === "toolUse"
      ? Math.max(eventToolUse?.revision ?? 0, this.revisions.get(entityKey) ?? 0)
      : entityKey ? this.revisions.get(entityKey) ?? 0 : 0
    const currentSession = entity === "session" ? eventSession : undefined
    if (
      entityKey && knownRevision >= event.revision &&
      (!currentSession || !entityUpdatedAt || currentSession.updatedAt >= entityUpdatedAt)
    ) return
    if (entityKey && entity && knownRevision > 0 && event.revision > knownRevision + 1) {
      if (entity === "toolUse" && toolUseEventId) {
        this.revisionGapHandler?.({
          entity,
          id: toolUseEventId,
          expectedRevision: knownRevision + 1,
          actualRevision: event.revision,
        })
      } else if (entity === "session" && sessionEventId) {
        this.revisionGapHandler?.({
          entity,
          id: sessionEventId,
          expectedRevision: knownRevision + 1,
          actualRevision: event.revision,
        })
      }
    }
    if (entityKey) this.revisions.set(entityKey, event.revision)
    if (isSearchEvent) {
      const resultRevision = event.resultRevision
      const previousRevision = this.searchRevisions.get(event.toolUseId)
      if (previousRevision !== undefined && resultRevision < previousRevision) return
      if (previousRevision !== undefined && resultRevision > previousRevision + 1) {
        this.revisionGapHandler?.({
          entity: "search",
          id: event.toolUseId,
          expectedRevision: previousRevision + 1,
          actualRevision: resultRevision,
        })
      }
      if (event._tag === "SearchResultsReset") {
        this.searchRevisions.set(event.toolUseId, resultRevision)
        this.searchResultsByUseId = new Map(this.searchResultsByUseId).set(event.toolUseId, [])
        this.notify(this.searchListeners, event.toolUseId)
        this.publish()
        return
      }
      if (previousRevision !== resultRevision) return
    }
    switch (event._tag) {
      case "SessionCreated":
      case "SessionUpdated":
      case "SessionArchived":
      case "SessionRestored":
        this.sessionsById = new Map(this.sessionsById).set(event.session.id, event.session)
        this.rebuildVisibleSessions()
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
    const previous = this.useIdsBySession.get(use.sessionId) ?? []
    const nextIds = use.archivedAt
      ? previous.filter(id => id !== use.id)
      : previous.includes(use.id) ? previous : [...previous, use.id]
    this.useIdsBySession = new Map(this.useIdsBySession).set(use.sessionId, nextIds)
    this.notify(this.useListeners, use.id)
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

  private selectedUseForSession(id: SessionId): ToolUseId | undefined {
    const useIds = this.useIdsBySession.get(id) ?? []
    const session = this.sessionsById.get(id)
    return session?.activeToolUseId && useIds.includes(session.activeToolUseId)
      ? session.activeToolUseId
      : useIds[0]
  }

  private reconcileSelection(): void {
    if (!this.activeSessionId || !this.sessionsById.has(this.activeSessionId) || !this.visibleSessionIds.includes(this.activeSessionId)) {
      this.activeSessionId = this.visibleSessionIds[0]
    }
    if (this.activeSessionId) {
      const selected = this.activeToolUseId
      this.activeToolUseId = selected && (this.useIdsBySession.get(this.activeSessionId) ?? []).includes(selected)
        ? selected
        : this.selectedUseForSession(this.activeSessionId)
    } else {
      this.activeToolUseId = undefined
    }
  }

  private makeSnapshot(): ToolStoreSnapshot {
    return {
      sessionsById: this.sessionsById,
      visibleSessionIds: this.visibleSessionIds,
      usesById: this.usesById,
      useIdsBySession: this.useIdsBySession,
      searchResultsByUseId: this.searchResultsByUseId,
      activeSessionId: this.activeSessionId,
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
