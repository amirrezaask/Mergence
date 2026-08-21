import { Schema } from "effect"
import { SessionTab, SessionTabId } from "@yaade/rpc"
import type {
  AppSession,
  SessionId,
  ToolEvent,
  ToolUse,
  ToolUseId,
} from "@yaade/rpc"
import { localResourceKey } from "./tool-session-routing.js"

export type ToolStoreSnapshot = {
  readonly sessionsById: ReadonlyMap<SessionId, AppSession>
  readonly visibleSessionIds: readonly SessionId[]
  readonly tabsById: ReadonlyMap<SessionTabId, SessionTab>
  readonly visibleTabIdsBySession: ReadonlyMap<SessionId, readonly SessionTabId[]>
  readonly usesById: ReadonlyMap<ToolUseId, ToolUse>
  readonly useIdsBySession: ReadonlyMap<SessionId, readonly ToolUseId[]>
  readonly useIdsByTab: ReadonlyMap<SessionTabId, readonly ToolUseId[]>
  readonly activeSessionId: SessionId | undefined
  readonly activeTabId: SessionTabId | undefined
  readonly activeToolUseId: ToolUseId | undefined
  readonly connection: "connecting" | "connected" | "reconciling" | "offline"
}

type Listener = () => void

export type ToolRevisionGap = {
  readonly entity: "session" | "tab" | "toolUse"
  readonly id: SessionId | SessionTabId | ToolUseId
  readonly expectedRevision: number
  readonly actualRevision: number
}

export type ToolStoreRevisionSnapshot = {
  readonly sessions: ReadonlyMap<SessionId, number>
  readonly tabs: ReadonlyMap<SessionTabId, number>
  readonly uses: ReadonlyMap<ToolUseId, number>
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
  private activeSessionId: SessionId | undefined
  private activeTabId: SessionTabId | undefined
  private activeToolUseId: ToolUseId | undefined
  private connection: ToolStoreSnapshot["connection"] = "connecting"
  private snapshot: ToolStoreSnapshot = this.makeSnapshot()
  private readonly listeners = new Set<Listener>()
  private readonly sessionListeners = new Map<SessionId, Set<Listener>>()
  private readonly tabListeners = new Map<SessionTabId, Set<Listener>>()
  private readonly useListeners = new Map<ToolUseId, Set<Listener>>()
  private readonly revisions = new Map<string, number>()
  private revisionGapHandler: ((gap: ToolRevisionGap) => void) | undefined

  setRevisionGapHandler(handler: ((gap: ToolRevisionGap) => void) | undefined): void {
    this.revisionGapHandler = handler
  }

  getSnapshot = (): ToolStoreSnapshot => this.snapshot

  captureRevisions(): ToolStoreRevisionSnapshot {
    return {
      sessions: new Map(
        [...this.sessionsById].map(([id, value]) => [id, value.revision ?? 0]),
      ),
      tabs: new Map(
        [...this.tabsById].map(([id, value]) => [id, value.revision ?? 0]),
      ),
      uses: new Map(
        [...this.usesById].map(([id, value]) => [id, value.revision]),
      ),
    }
  }

  /**
   * Apply an authoritative snapshot without allowing a response that was
   * started earlier to overwrite newer realtime events. Entities changed
   * during the request are retained when the response omits or regresses them.
   */
  mergeSnapshot(
    sessions: readonly AppSession[],
    uses: readonly ToolUse[],
    tabs: readonly SessionTab[],
    hasTabs: boolean,
    baseline: ToolStoreRevisionSnapshot,
  ): void {
    const previousSessions = this.sessionsById
    const previousTabs = this.tabsById
    const previousUses = this.usesById
    const incomingSessions = new Map(sessions.map(value => [value.id, value]))
    const nextSessions = new Map<SessionId, AppSession>()
    for (const [id, incoming] of incomingSessions) {
      const current = this.sessionsById.get(id)
      nextSessions.set(
        id,
        current && (current.revision ?? 0) > (incoming.revision ?? 0)
          ? current
          : incoming,
      )
    }
    for (const [id, current] of this.sessionsById) {
      if (incomingSessions.has(id)) continue
      if ((current.revision ?? 0) > (baseline.sessions.get(id) ?? 0)) {
        nextSessions.set(id, current)
      }
    }

    const incomingTabs = new Map(tabs.map(value => [value.id, value]))
    const nextTabs = hasTabs ? new Map<SessionTabId, SessionTab>() : new Map(this.tabsById)
    if (hasTabs) {
      for (const [id, incoming] of incomingTabs) {
        const current = this.tabsById.get(id)
        nextTabs.set(
          id,
          current && (current.revision ?? 0) > (incoming.revision ?? 0)
            ? current
            : incoming,
        )
      }
      for (const [id, current] of this.tabsById) {
        if (incomingTabs.has(id)) continue
        if ((current.revision ?? 0) > (baseline.tabs.get(id) ?? 0)) {
          nextTabs.set(id, current)
        }
      }
    }

    for (const session of nextSessions.values()) {
      const hasVisibleTab = [...nextTabs.values()].some(
        tab => tab.sessionId === session.id && !tab.archivedAt,
      )
      if (!hasVisibleTab) {
        const fallback = fallbackTab(session)
        nextTabs.set(fallback.id, fallback)
      }
    }

    const incomingUses = new Map(uses.map(value => [value.id, value]))
    const nextUses = new Map<ToolUseId, ToolUse>()
    for (const [id, incoming] of incomingUses) {
      const current = this.usesById.get(id)
      nextUses.set(
        id,
        current && current.revision > incoming.revision ? current : incoming,
      )
    }
    for (const [id, current] of this.usesById) {
      if (incomingUses.has(id)) continue
      if (current.revision > (baseline.uses.get(id) ?? 0)) {
        nextUses.set(id, current)
      }
    }

    this.sessionsById = nextSessions
    this.tabsById = nextTabs
    this.usesById = nextUses
    for (const [id, value] of nextSessions) {
      this.revisions.set(`session:${id}`, Math.max(this.revisions.get(`session:${id}`) ?? 0, value.revision ?? 0))
    }
    for (const [id, value] of nextTabs) {
      this.revisions.set(`tab:${id}`, Math.max(this.revisions.get(`tab:${id}`) ?? 0, value.revision ?? 0))
    }
    for (const [id, value] of nextUses) {
      this.revisions.set(`use:${id}`, Math.max(this.revisions.get(`use:${id}`) ?? 0, value.revision))
    }
    for (const [id, revision] of baseline.sessions) {
      this.revisions.set(`session:${id}`, Math.max(this.revisions.get(`session:${id}`) ?? 0, revision))
    }
    for (const [id, revision] of baseline.tabs) {
      this.revisions.set(`tab:${id}`, Math.max(this.revisions.get(`tab:${id}`) ?? 0, revision))
    }
    for (const [id, revision] of baseline.uses) {
      this.revisions.set(`use:${id}`, Math.max(this.revisions.get(`use:${id}`) ?? 0, revision))
    }
    this.rebuildVisibleSessions()
    this.rebuildVisibleTabs()
    this.reconcileSelection()
    this.notifyMapChanges(previousSessions, nextSessions, this.sessionListeners)
    this.notifyMapChanges(previousTabs, nextTabs, this.tabListeners)
    this.notifyMapChanges(previousUses, nextUses, this.useListeners)
    this.publish()
  }

  replaceToolUseIfNewer(use: ToolUse): void {
    const current = this.usesById.get(use.id)
    if (current && current.revision > use.revision) return
    this.replaceToolUse(use)
  }

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

  replaceTab(tab: SessionTab): void {
    const current = this.tabsById.get(tab.id)
    if (
      current &&
      ((current.revision ?? 0) > (tab.revision ?? 0) ||
        ((current.revision ?? 0) === (tab.revision ?? 0) &&
          current.updatedAt > tab.updatedAt))
    ) return
    this.tabsById = new Map(this.tabsById).set(tab.id, tab)
    this.rebuildVisibleTabs()
    this.reconcileSelection()
    this.notify(this.tabListeners, tab.id)
    this.publish()
  }

  replaceToolUse(use: ToolUse): void {
    const current = this.usesById.get(use.id)
    if (
      current &&
      (current.revision > use.revision ||
        (current.revision === use.revision && current.updatedAt > use.updatedAt))
    ) return
    const sessions = [...this.sessionsById.values()]
    const tabs = [...this.tabsById.values()]
    const uses = [...this.usesById.values()].filter(candidate => candidate.id !== use.id)
    this.replace(sessions, [...uses, use], tabs)
  }

  replaceSession(
    session: AppSession,
    uses: readonly ToolUse[],
    tabs?: readonly SessionTab[],
  ): void {
    const currentSession = this.sessionsById.get(session.id)
    const nextSession =
      currentSession && (currentSession.revision ?? 0) > (session.revision ?? 0)
        ? currentSession
        : session
    const sessions = [...this.sessionsById.values()].filter(candidate => candidate.id !== session.id)
    const existingUses = [...this.usesById.values()].filter(candidate => candidate.sessionId !== session.id)
    const incomingUses = new Map(uses.map(value => [value.id, value]))
    for (const current of this.usesById.values()) {
      if (current.sessionId !== session.id || incomingUses.has(current.id)) continue
      if (current.archivedAt) incomingUses.set(current.id, current)
    }
    for (const incoming of uses) {
      const current = this.usesById.get(incoming.id)
      if (current && current.revision > incoming.revision) {
        incomingUses.set(incoming.id, current)
      }
    }
    const existingTabs = [...this.tabsById.values()].filter(candidate => candidate.sessionId !== session.id)
    const incomingTabs = new Map((tabs ?? []).map(value => [value.id, value]))
    for (const current of this.tabsById.values()) {
      if (current.sessionId !== session.id) continue
      // A legacy host may omit tabs entirely. Retain the local normalized tabs
      // in that case; an explicit empty array remains authoritative.
      if (tabs === undefined) {
        incomingTabs.set(current.id, current)
        continue
      }
      if (incomingTabs.has(current.id)) continue
      if (current.archivedAt) incomingTabs.set(current.id, current)
    }
    for (const incoming of tabs ?? []) {
      const current = this.tabsById.get(incoming.id)
      if (current && (current.revision ?? 0) > (incoming.revision ?? 0)) {
        incomingTabs.set(incoming.id, current)
      }
    }
    this.replace(
      [...sessions, nextSession],
      [...existingUses, ...incomingUses.values()],
      [...existingTabs, ...incomingTabs.values()],
    )
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
    const previousSessions = this.sessionsById
    const previousTabs = this.tabsById
    const previousUses = this.usesById
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
    for (const session of sessions) {
      this.revisions.set(`session:${session.id}`, Math.max(this.revisions.get(`session:${session.id}`) ?? 0, session.revision ?? 0))
    }
    for (const tab of tabs) {
      this.revisions.set(`tab:${tab.id}`, Math.max(this.revisions.get(`tab:${tab.id}`) ?? 0, tab.revision ?? 0))
    }
    for (const use of uses) {
      this.revisions.set(`use:${use.id}`, Math.max(this.revisions.get(`use:${use.id}`) ?? 0, use.revision))
    }
    this.rebuildUseIndexes()
    this.reconcileSelection()
    this.notifyMapChanges(previousSessions, this.sessionsById, this.sessionListeners)
    this.notifyMapChanges(previousTabs, this.tabsById, this.tabListeners)
    this.notifyMapChanges(previousUses, this.usesById, this.useListeners)
    this.publish()
  }

  selectSession(id: SessionId): void {
    const resolved = this.resolveSessionId(id)
    if (!resolved || this.activeSessionId === resolved) return
    this.activeSessionId = resolved
    this.activeTabId = this.selectedTabForSession(resolved)
    this.activeToolUseId = this.activeTabId
      ? this.selectedUseForTab(this.activeTabId)
      : undefined
    this.publish()
  }

  selectTab(id: SessionTabId): void {
    const tab = this.tabsById.get(id) ?? this.findByLocalKey(this.tabsById, id)
    if (!tab || tab.archivedAt) return
    this.activeSessionId = tab.sessionId
    this.activeTabId = id
    this.activeToolUseId = this.selectedUseForTab(id)
    this.publish()
  }

  selectToolUse(id: ToolUseId): void {
    const use = this.usesById.get(id) ?? this.findByLocalKey(this.usesById, id)
    if (!use || use.archivedAt) return
    const tabId = this.tabIdForUse(use)
    if (!tabId) return
    this.activeSessionId = use.sessionId
    this.activeTabId = tabId
    this.activeToolUseId = id
    this.publish()
  }

  apply(event: ToolEvent): void {
    let entityKey: string | undefined
    let entity: ToolRevisionGap["entity"] | undefined
    let entityId: SessionId | SessionTabId | ToolUseId | undefined

    if (event._tag === "SessionTabCreated" || event._tag === "SessionTabUpdated" || event._tag === "SessionTabArchived") {
      entityKey = `tab:${event.tab.id}`
      entity = "tab"
      entityId = event.tab.id
    } else if ("toolUseId" in event) {
      entityKey = `use:${event.toolUseId}`
      entity = "toolUse"
      entityId = event.toolUseId
    } else if ("session" in event) {
      entityKey = `session:${event.session.id}`
      entity = "session"
      entityId = event.session.id
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
          current?.revision ?? 0,
        )
      : 0
    // Revisions are the authoritative ordering. Wall-clock timestamps can
    // differ between host processes, so never let a lower/equal revision
    // regress an entity merely because its timestamp looks newer.
    if (entityKey && knownRevision >= event.revision) return
    if (
      entityKey &&
      entity &&
      entityId &&
      knownRevision > 0 &&
      event.revision > knownRevision + 1
    ) {
      this.revisionGapHandler?.({
        entity,
        id: entityId,
        expectedRevision: knownRevision + 1,
        actualRevision: event.revision,
      })
    }
    if (entityKey) this.revisions.set(entityKey, event.revision)

    switch (event._tag) {
      case "SessionCreated":
      case "SessionUpdated":
      case "SessionArchived":
      case "SessionRestored":
        this.sessionsById = new Map(this.sessionsById).set(event.session.id, event.session)
        this.rebuildVisibleSessions()
        this.notify(this.sessionListeners, event.session.id)
        if (event.session.id === this.activeSessionId) {
          const tabIds = this.visibleTabIdsBySession.get(event.session.id) ?? []
          const nextTabId = event.session.activeTabId && tabIds.includes(event.session.activeTabId)
            ? event.session.activeTabId
            : this.selectedTabForSession(event.session.id)
          this.activeTabId = nextTabId
          this.activeToolUseId = nextTabId
            ? this.selectedUseForTab(nextTabId)
            : undefined
        }
        break
      case "SessionTabCreated":
      case "SessionTabUpdated":
      case "SessionTabArchived": {
        const previousActive =
          current && "activeToolUseId" in current
            ? current.activeToolUseId
            : undefined
        this.tabsById = new Map(this.tabsById).set(event.tab.id, event.tab)
        this.rebuildVisibleTabs()
        this.notify(this.tabListeners, event.tab.id)
        if (this.activeTabId === event.tab.id) {
          const ids = this.useIdsByTab.get(event.tab.id) ?? []
          const keepLocal =
            event._tag === "SessionTabUpdated" &&
            event.tab.activeToolUseId === previousActive &&
            this.activeToolUseId != null &&
            ids.includes(this.activeToolUseId)
          if (!keepLocal) {
            this.activeToolUseId = this.selectedUseForTab(event.tab.id)
          }
        }
        break
      }
      case "ToolUseCreated":
      case "ToolUseUpdated": {
        const currentUse = this.usesById.get(event.toolUse.id)
        if (currentUse?.archivedAt && !event.toolUse.archivedAt) break
        this.upsertUse(event.toolUse)
        break
      }
      case "ToolUseOutputChanged": {
        const use = this.usesById.get(event.toolUseId)
        if (use) this.upsertUse({ ...use, output: event.output, revision: event.revision, updatedAt: event.occurredAt })
        break
      }
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
    const previous = this.usesById.get(use.id)
    this.usesById = new Map(this.usesById).set(use.id, use)
    if (
      !previous ||
      previous.sessionId !== use.sessionId ||
      previous.tabId !== use.tabId ||
      previous.archivedAt !== use.archivedAt ||
      previous.position !== use.position
    ) {
      this.updateUseIndexes(previous, use)
    }
    this.notify(this.useListeners, use.id)
  }

  private updateUseIndexes(previous: ToolUse | undefined, next: ToolUse): void {
    const sessionIndexes = new Map(this.useIdsBySession)
    const tabIndexes = new Map(this.useIdsByTab)
    const touchedSessions = new Set<SessionId>()
    const touchedTabs = new Set<SessionTabId>()

    const remove = (use: ToolUse) => {
      if (use.archivedAt) return
      const tabId = this.tabIdForUse(use)
      const sessionIds = sessionIndexes.get(use.sessionId) ?? []
      sessionIndexes.set(
        use.sessionId,
        sessionIds.filter(id => id !== use.id),
      )
      touchedSessions.add(use.sessionId)
      if (!tabId) return
      const tabIds = tabIndexes.get(tabId) ?? []
      tabIndexes.set(tabId, tabIds.filter(id => id !== use.id))
      touchedTabs.add(tabId)
    }
    const insert = (use: ToolUse) => {
      if (use.archivedAt) return
      const tabId = this.tabIdForUse(use)
      if (!tabId || this.tabsById.get(tabId)?.archivedAt) return
      sessionIndexes.set(use.sessionId, [
        ...(sessionIndexes.get(use.sessionId) ?? []),
        use.id,
      ])
      tabIndexes.set(tabId, [...(tabIndexes.get(tabId) ?? []), use.id])
      touchedSessions.add(use.sessionId)
      touchedTabs.add(tabId)
    }

    if (previous) remove(previous)
    insert(next)
    for (const sessionId of touchedSessions) {
      sessionIndexes.get(sessionId)?.sort(
        (a, b) =>
          (this.usesById.get(a)?.position ?? 0) -
          (this.usesById.get(b)?.position ?? 0),
      )
    }
    for (const tabId of touchedTabs) {
      tabIndexes.get(tabId)?.sort(
        (a, b) =>
          (this.usesById.get(a)?.position ?? 0) -
          (this.usesById.get(b)?.position ?? 0),
      )
    }
    this.useIdsBySession = sessionIndexes
    this.useIdsByTab = tabIndexes
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

  private resolveSessionId(id: string): SessionId | undefined {
    if (this.sessionsById.has(id as SessionId)) return id as SessionId
    return this.findByLocalKey(this.sessionsById, id)?.id
  }

  private findByLocalKey<T extends { readonly id: string }>(
    items: ReadonlyMap<string, T>,
    requested: string,
  ): T | undefined {
    const exact = items.get(requested)
    if (exact) return exact
    const key = localResourceKey(requested)
    for (const item of items.values()) {
      if (localResourceKey(item.id) === key) return item
    }
    return undefined
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

  private notifyMapChanges<K, V>(
    previous: ReadonlyMap<K, V>,
    next: ReadonlyMap<K, V>,
    listeners: Map<K, Set<Listener>>,
  ): void {
    const keys = new Set([...previous.keys(), ...next.keys()])
    for (const key of keys) {
      if (previous.get(key) !== next.get(key)) this.notify(listeners, key)
    }
  }
}
