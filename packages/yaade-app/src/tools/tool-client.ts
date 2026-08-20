import { AppSession, RuntimeSnapshot, SessionTab, ToolUse } from "@yaade/rpc"
import { Schema } from "effect"
import type {
  SessionId,
  SessionTabId,
  ToolUseId,
} from "@yaade/rpc"
import type { JetElectronTools, ToolSessionSnapshot } from "@yaade/workspace"
import {
  ToolSessionStore,
  type ToolRevisionGap,
} from "./tool-store.js"

type ToolApi = JetElectronTools

type ToolClientOptions = {
  readonly api?: ToolApi
  readonly store?: ToolSessionStore
  readonly window?: Pick<Window, "addEventListener" | "removeEventListener">
}

function decodeRuntimeSnapshots(value: unknown): ToolSessionSnapshot[] | null {
  try {
    const snapshot = Schema.decodeUnknownSync(RuntimeSnapshot)(value)
    const decoded: ToolSessionSnapshot[] = []
    for (const raw of snapshot.sessions) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
      const record = raw as Record<string, unknown>
      const session = Schema.decodeUnknownSync(AppSession)(record.session)
      const tabs = Array.isArray(record.tabs)
        ? record.tabs.map(tab => Schema.decodeUnknownSync(SessionTab)(tab))
        : []
      const toolUses = Array.isArray(record.toolUses)
        ? record.toolUses.map(use => Schema.decodeUnknownSync(ToolUse)(use))
        : []
      decoded.push({ session, tabs, toolUses })
    }
    return decoded
  } catch {
    return null
  }
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
  private readonly revisionGapHandler = (gap: ToolRevisionGap): void => {
    void this.reconcileGap(gap)
  }

  constructor(options: ToolClientOptions = {}) {
    this.store = options.store ?? new ToolSessionStore()
    this.api = toolApi(options.api)
    this.eventWindow = options.window ?? globalThis.window ?? {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }
    this.store.setRevisionGapHandler(this.revisionGapHandler)
  }

  start(): () => void {
    this.disposed = false
    this.store.setRevisionGapHandler(this.revisionGapHandler)
    if (this.disposeEvents) return this.disposeEvents
    const disposeToolEvents = this.api.onEvent(event => this.store.apply(event))
    const onReconnect = () => { void this.reconcile() }
    const onReplayGap = () => { void this.reconcile() }
    const onRuntimeSnapshot = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const snapshots = decodeRuntimeSnapshots(event.detail)
      if (!snapshots || this.disposed) return
      this.replaceSnapshotsAuthoritatively(snapshots)
      this.store.setConnection("connected")
    }
    this.eventWindow.addEventListener("yaade:host-reconnected", onReconnect)
    this.eventWindow.addEventListener("yaade:host-replay-gap", onReplayGap)
    this.eventWindow.addEventListener("yaade:runtime-snapshot", onRuntimeSnapshot)
    this.disposeEvents = () => {
      disposeToolEvents()
      this.eventWindow.removeEventListener("yaade:host-reconnected", onReconnect)
      this.eventWindow.removeEventListener("yaade:host-replay-gap", onReplayGap)
      this.eventWindow.removeEventListener("yaade:runtime-snapshot", onRuntimeSnapshot)
      this.disposeEvents = undefined
    }
    return this.disposeEvents
  }

  async hydrate(includeArchived = false): Promise<void> {
    if (this.disposed) return
    const baseline = this.store.captureRevisions()
    this.store.setConnection("reconciling")
    try {
      const snapshots = await this.api.listSessions(includeArchived)
      if (this.disposed) return
      this.replaceSnapshots(snapshots, baseline)
      this.store.setConnection("connected")
    } catch (error) {
      if (!this.disposed) this.store.setConnection("offline")
      throw error
    }
  }

  async reconcileSession(sessionId: SessionId): Promise<void> {
    if (this.disposed) return
    const snapshot = await this.api.getSession(sessionId)
    if (!snapshot || this.disposed) return
    this.store.replaceSession(
      snapshot.session,
      snapshot.toolUses,
      snapshot.tabs,
    )
  }

  async reconcile(): Promise<void> {
    if (this.disposed) return
    if (this.reconcilePromise) return this.reconcilePromise
    const promise = this.hydrate().finally(() => {
      if (this.reconcilePromise === promise) this.reconcilePromise = undefined
    })
    this.reconcilePromise = promise
    return promise
  }

  dispose(): void {
    this.disposed = true
    this.disposeEvents?.()
    this.reconcilePromise = undefined
    this.store.setRevisionGapHandler(undefined)
  }

  private async reconcileGap(gap: ToolRevisionGap): Promise<void> {
    try {
      if (gap.entity === "session" || gap.entity === "tab") {
        const sessionId = gap.entity === "session"
          ? gap.id as SessionId
          : this.store.getSnapshot().tabsById.get(gap.id as SessionTabId)?.sessionId
        if (!sessionId) return
        await this.reconcileSession(sessionId)
        return
      }
      const use = await this.api.getUse(gap.id as ToolUseId)
      if (!use || this.disposed) return
      this.store.replaceToolUseIfNewer(use)
    } catch {
      // Reconciliation is best effort; a dropped host connection will trigger
      // the next full snapshot instead of an unhandled rejection.
    }
  }

  private replaceSnapshotsAuthoritatively(
    snapshots: readonly ToolSessionSnapshot[],
  ): void {
    const hasTabs = snapshots.some(snapshot => snapshot.tabs !== undefined)
    this.store.replace(
      snapshots.map(snapshot => snapshot.session),
      snapshots.flatMap(snapshot => snapshot.toolUses),
      hasTabs ? snapshots.flatMap(snapshot => snapshot.tabs ?? []) : [],
    )
  }

  private replaceSnapshots(
    snapshots: readonly ToolSessionSnapshot[],
    baseline: ReturnType<ToolSessionStore["captureRevisions"]>,
  ): void {
    const hasTabs = snapshots.some(snapshot => snapshot.tabs !== undefined)
    this.store.mergeSnapshot(
      snapshots.map(snapshot => snapshot.session),
      snapshots.flatMap(snapshot => snapshot.toolUses),
      snapshots.flatMap(snapshot => snapshot.tabs ?? []),
      hasTabs,
      baseline,
    )
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
  const ids = tabId ? snapshot.useIdsByTab.get(tabId) ?? [] : []
  const activeId = tabId ? snapshot.tabsById.get(tabId)?.activeToolUseId : undefined
  const id = activeId && ids.includes(activeId) ? activeId : ids[0]
  return id ? snapshot.usesById.get(id) : undefined
}

export function sessionById(store: ToolSessionStore, id: SessionId): AppSession | undefined {
  return store.getSnapshot().sessionsById.get(id)
}
