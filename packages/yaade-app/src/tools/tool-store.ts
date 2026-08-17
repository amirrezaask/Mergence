import { Schema } from "effect"
import { SessionTab, SessionTabId } from "@yaade/rpc"
import type {
  AppSession,
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
    this.tabsById = new Map(this.tabsById).set(tab.id, tab)
    this.rebuildVisibleTabs()
    this.reconcileSelection()
    this.notify(this.tabListeners, tab.id)
    this.publish()
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
    let entityKey: string | undefined
    let entity: ToolRevisionGap["entity"] | undefined
    let entityId: SessionId | SessionTabId | ToolUseId | undefined
    let entityUpdatedAt: string | undefined

    if (event._tag === "SessionTabCreated" || event._tag === "SessionTabUpdated" || event._tag === "SessionTabArchived") {
      entityKey = `tab:${event.tab.id}`
      entity = "tab"
      entityId = event.tab.id
      entityUpdatedAt = event.tab.updatedAt
    } else if ("toolUseId" in event) {
      entityKey = `use:${event.toolUseId}`
      entity = "toolUse"
      entityId = event.toolUseId
      entityUpdatedAt = "toolUse" in event ? event.toolUse.updatedAt : event.occurredAt
    } else if ("session" in event) {
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
          current?.revision ?? 0,
        )
      : 0
    if (
      entityKey && knownRevision >= event.revision &&
      (!current || !entityUpdatedAt || current.updatedAt >= entityUpdatedAt)
    ) return
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
}
