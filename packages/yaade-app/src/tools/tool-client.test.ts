import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import { AppSession, ProcessToolOutput, ProjectTarget, ToolEvent, ToolUse, ToolUseUpdated } from "@yaade/rpc"
import type { HostTools, ToolSessionSnapshot } from "@yaade/workspace"
import { Schema } from "effect"
import { ToolClient } from "./tool-client.js"
import { ToolSessionStore } from "./tool-store.js"

class FakeWindow {
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type))
  }
}

function makeUse(revision: number): ToolUse {
  return Schema.decodeUnknownSync(ToolUse)({
    id: "use-client-test",
    sessionId: "ses-client-test",
    kind: "terminal",
    title: "Shell",
    position: 0,
    status: "running",
    context: {
      project: ProjectTarget.make({ projectId: "project", projectPath: "/tmp/project", projectName: "Project" }),
      checkoutKey: "main",
      checkoutPath: "/tmp/project",
      checkoutLabel: "Main",
      managedWorktree: false,
    },
    input: { _tag: "TerminalToolInput", kind: "terminal" },
    inputRevision: 1,
    output: ProcessToolOutput.make({
      kind: "process",
      terminalInstanceId: "terminal",
      generation: 1,
      processState: "running",
      activityState: "idle",
      replayAvailable: true,
      truncated: false,
    }),
    revision,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: `2026-08-12T00:00:0${revision}.000Z`,
  })
}

function makeApi(initial: ToolSessionSnapshot, latest: () => ToolUse): HostTools {
  let eventListener: ((event: ToolEvent) => void) | undefined
  return {
    listSessions: async () => [initial],
    reorderSessions: async () => [initial.session],
    archiveSession: async () => initial.session,
    restoreSession: async () => initial.session,
    createSession: async () => initial.session,
    renameSession: async () => initial.session,
    getSession: async () => ({ session: initial.session, toolUses: [latest()] }),
    createUse: async () => latest(),
    getUse: async () => latest(),
    reorderUses: async () => [latest()],
    updateUseInput: async () => latest(),
    loadMore: async () => [],
    selectUse: async () => initial.session,
    cancelUse: async () => latest(),
    restartUse: async () => latest(),
    archiveUse: async () => latest(),
    renameUse: async () => latest(),
    listCheckoutTargets: async () => [],
    onEvent: callback => {
      eventListener = callback
      return () => { eventListener = undefined }
    },
    listProjects: async () => [],
    // Test-only access to the transport callback.
    emit(event: ToolEvent): void {
      eventListener?.(event)
    },
  } as HostTools & { emit(event: ToolEvent): void }
}

describe("ToolClient", () => {
  it("refetches a ToolUse when an event revision jumps", async () => {
    const use = makeUse(1)
    const recovered = makeUse(3)
    const session = AppSession.make({
      id: "ses-client-test",
      title: "Session",
      position: 0,
      activeToolUseId: use.id,
      createdAt: use.createdAt,
      updatedAt: use.createdAt,
    })
    const api = makeApi({ session, toolUses: [use] }, () => recovered)
    const window = new FakeWindow()
    const client = new ToolClient({ api, window })
    client.start()
    await client.hydrate()

    const event = ToolUseUpdated.make({
      eventId: "tool-use-gap",
      toolUseId: recovered.id,
      revision: recovered.revision,
      occurredAt: recovered.updatedAt,
      toolUse: recovered,
    })
    ;(api as HostTools & { emit(event: ToolEvent): void }).emit(event)
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.equal(client.store.getSnapshot().usesById.get(use.id)?.revision, 3)
    client.dispose()
  })

  it("keeps realtime revisions when a stale snapshot resolves later", async () => {
    const use = makeUse(1)
    const newer = makeUse(2)
    const session = AppSession.make({
      id: "ses-client-test",
      title: "Session",
      position: 0,
      activeToolUseId: use.id,
      createdAt: use.createdAt,
      updatedAt: use.createdAt,
    })
    let resolveList: ((value: ToolSessionSnapshot[]) => void) | undefined
    const api = makeApi({ session, toolUses: [use] }, () => use)
    api.listSessions = async () => new Promise(resolve => { resolveList = resolve })
    const window = new FakeWindow()
    const client = new ToolClient({ api, window })
    client.start()
    const hydration = client.hydrate()
    ;(api as HostTools & { emit(event: ToolEvent): void }).emit(
      ToolUseUpdated.make({
        eventId: "newer-event",
        toolUseId: newer.id,
        revision: newer.revision,
        occurredAt: newer.updatedAt,
        toolUse: newer,
      }),
    )
    resolveList?.([{ session, toolUses: [use] }])
    await hydration
    assert.equal(client.store.getSnapshot().usesById.get(use.id)?.revision, 2)
    client.dispose()
  })

  it("can be started again after disposal", async () => {
    const use = makeUse(1)
    const session = AppSession.make({
      id: "ses-client-test",
      title: "Session",
      position: 0,
      activeToolUseId: use.id,
      createdAt: use.createdAt,
      updatedAt: use.createdAt,
    })
    const recovered = makeUse(3)
    const api = makeApi({ session, toolUses: [use] }, () => recovered)
    const window = new FakeWindow()
    const client = new ToolClient({ api, window })
    client.start()
    await client.hydrate()
    client.dispose()
    client.start()
    ;(api as HostTools & { emit(event: ToolEvent): void }).emit(
      ToolUseUpdated.make({
        eventId: "after-restart",
        toolUseId: recovered.id,
        revision: recovered.revision,
        occurredAt: recovered.updatedAt,
        toolUse: recovered,
      }),
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(client.store.getSnapshot().usesById.get(use.id)?.revision, 3)
    client.dispose()
  })

  it("re-fetches through the API for runtime snapshots", async () => {
    const use = makeUse(1)
    const recovered = makeUse(4)
    const session = AppSession.make({
      id: "ses-client-test",
      title: "Session",
      position: 0,
      activeToolUseId: use.id,
      createdAt: use.createdAt,
      updatedAt: use.createdAt,
    })
    const api = makeApi({ session, toolUses: [use] }, () => recovered)
    let listCalls = 0
    api.listSessions = async () => {
      listCalls += 1
      return [{ session, toolUses: [listCalls === 1 ? use : recovered] }]
    }
    const window = new FakeWindow()
    const client = new ToolClient({ api, window })
    client.start()
    await client.hydrate()
    window.dispatch("yaade:runtime-snapshot")
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(listCalls, 2)
    assert.equal(client.store.getSnapshot().usesById.get(use.id)?.revision, 4)
    client.dispose()
  })

  it("reconciles all snapshots after a host reconnect", async () => {
    const use = makeUse(1)
    const session = AppSession.make({
      id: "ses-client-test",
      title: "Session",
      position: 0,
      activeToolUseId: use.id,
      createdAt: use.createdAt,
      updatedAt: use.createdAt,
    })
    const api = makeApi({ session, toolUses: [use] }, () => use)
    const window = new FakeWindow()
    const client = new ToolClient({ api, window, store: new ToolSessionStore() })
    client.start()
    await client.hydrate()
    window.dispatch("yaade:host-reconnected")
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(client.store.getSnapshot().connection, "connected")
    client.dispose()
  })

  it("does not flash reconciling over a known offline connection", async () => {
    const use = makeUse(1)
    const session = AppSession.make({
      id: "ses-client-test",
      title: "Session",
      position: 0,
      activeToolUseId: use.id,
      createdAt: use.createdAt,
      updatedAt: use.createdAt,
    })
    const api = makeApi({ session, toolUses: [use] }, () => use)
    let resolveList: ((value: ToolSessionSnapshot[]) => void) | undefined
    api.listSessions = async () => new Promise(resolve => { resolveList = resolve })
    const store = new ToolSessionStore()
    store.setConnection("offline")
    const client = new ToolClient({ api, window: new FakeWindow(), store })
    const hydration = client.hydrate()
    assert.equal(client.store.getSnapshot().connection, "offline")
    resolveList?.([{ session, toolUses: [use] }])
    await hydration
    assert.equal(client.store.getSnapshot().connection, "connected")
    client.dispose()
  })

  it("reconciles after a protocol replay gap", async () => {
    let listCalls = 0
    const use = makeUse(1)
    const recovered = makeUse(4)
    const session = AppSession.make({
      id: "ses-client-test",
      title: "Session",
      position: 0,
      activeToolUseId: use.id,
      createdAt: use.createdAt,
      updatedAt: use.createdAt,
    })
    const api = makeApi({ session, toolUses: [use] }, () => recovered)
    const originalList = api.listSessions
    api.listSessions = async includeArchived => {
      listCalls += 1
      if (listCalls === 1) return originalList(includeArchived)
      return [{ session, toolUses: [recovered] }]
    }
    const window = new FakeWindow()
    const client = new ToolClient({ api, window })
    client.start()
    await client.hydrate()
    window.dispatch("yaade:host-replay-gap")
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(listCalls >= 2)
    assert.equal(client.store.getSnapshot().usesById.get(use.id)?.revision, 4)
    client.dispose()
  })
})
