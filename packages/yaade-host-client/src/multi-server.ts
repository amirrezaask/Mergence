import { Schema } from "effect"
import {
  ArchiveSession,
  ArchiveSessionTab,
  ArchiveToolUse,
  CreateSessionTab,
  CreateToolUse,
  RenameSessionTab,
  ReorderSessionTabs,
  ReorderToolUses,
  RestoreSession,
  SaveSessionTabLayout,
  SelectSessionTab,
  SessionId,
  SessionTabId,
  ToolUseId,
  UpdateToolUseContext,
  type AppSession as AppSessionValue,
  type ToolEvent as ToolEventValue,
  type ToolUse,
} from "@yaade/rpc"
import type {
  AgentRunInfo,
  JetElectronAgents,
  JetElectronTerminal,
  JetElectronTools,
  YaadeHostAPI,
  ToolSessionSnapshot,
  TerminalInstanceEvent,
  TerminalInstanceInfo,
} from "@yaade/workspace"
import type {
  YaadeServerConnection,
  YaadeServerDefinition,
  YaadeServerStatus,
} from "@yaade/shared"
import { createYaadeApi } from "./create-yaade-api.js"
import { normalizeHostBaseUrl, WebHostTransport } from "./web-transport.js"

const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/
const SERVER_STORAGE_KEY = "yaade:server-definitions"
const LEGACY_TOKEN_SESSION_KEY = "yaade:legacy-server-tokens"

type StorageLike = Pick<Storage, "getItem" | "setItem">
export type MultiServerGlobalTarget = {
  readonly setYaade: (value: YaadeHostAPI) => void
}
type Listener = () => void

type Owner = {
  readonly serverId: string
  readonly localId: string
}

type ManagedConnection = {
  readonly definition: YaadeServerDefinition
  readonly transport: WebHostTransport
  readonly api: YaadeHostAPI
  status: YaadeServerStatus
  sessionCount: number
  error?: string
  disposeStatus: () => void
  disposeTools: () => void
  disposeTerminal: () => void
  disposeAgents: () => void
}

export type MultiServerSnapshot = {
  readonly connections: readonly YaadeServerConnection[]
  readonly activeServerId: string | undefined
  readonly generation: number
}

export type ServerTestResult =
  | { readonly ok: true; readonly sessionCount: number }
  | { readonly ok: false; readonly error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function normalizeServerDefinition(raw: unknown): YaadeServerDefinition | null {
  if (!isRecord(raw)) return null
  const rawUrl = nonEmptyString(raw.url)
  if (!rawUrl) return null
  let url: string
  try {
    url = normalizeHostBaseUrl(rawUrl)
  } catch {
    return null
  }
  const id = nonEmptyString(raw.id)
  const name = nonEmptyString(raw.name) ?? new URL(url).hostname
  if (!id || !SERVER_ID_PATTERN.test(id)) return null
  const token = nonEmptyString(raw.token)
  return {
    id,
    name,
    url,
    ...(token ? { token } : {}),
  }
}

export function decodeStoredServerDefinitions(raw: unknown): YaadeServerDefinition[] {
  const values = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.servers)
      ? raw.servers
      : []
  const seen = new Set<string>()
  const urls = new Set<string>()
  const definitions: YaadeServerDefinition[] = []
  for (const value of values) {
    const definition = normalizeServerDefinition(value)
    if (!definition || seen.has(definition.id) || urls.has(definition.url)) continue
    seen.add(definition.id)
    urls.add(definition.url)
    definitions.push(definition)
  }
  return definitions
}

function sessionTokenMap(): Record<string, string> {
  if (typeof sessionStorage === "undefined") return {}
  try {
    const raw = sessionStorage.getItem(LEGACY_TOKEN_SESSION_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (!isRecord(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0,
      ),
    )
  } catch {
    return {}
  }
}

function saveSessionTokenMap(tokens: Record<string, string>): void {
  if (typeof sessionStorage === "undefined") return
  try {
    sessionStorage.setItem(LEGACY_TOKEN_SESSION_KEY, JSON.stringify(tokens))
  } catch {
    /* Session storage can be disabled; the user can pair again. */
  }
}

export function loadStoredServerDefinitions(
  storage: StorageLike | null = typeof localStorage === "undefined" ? null : localStorage,
): YaadeServerDefinition[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(SERVER_STORAGE_KEY)
    const definitions = raw ? decodeStoredServerDefinitions(JSON.parse(raw)) : []
    const tokens = sessionTokenMap()
    let migrated = false
    const result = definitions.map(definition => {
      if (definition.token && !tokens[definition.id]) {
        tokens[definition.id] = definition.token
        migrated = true
      }
      return definition.token || !tokens[definition.id]
        ? definition
        : { ...definition, token: tokens[definition.id] }
    })
    if (migrated) {
      saveSessionTokenMap(tokens)
      storage.setItem(
        SERVER_STORAGE_KEY,
        JSON.stringify(result.map(({ token: _token, ...definition }) => definition)),
      )
    }
    return result
  } catch {
    return []
  }
}

export function saveStoredServerDefinitions(
  definitions: readonly YaadeServerDefinition[],
  storage: StorageLike | null = typeof localStorage === "undefined" ? null : localStorage,
): void {
  if (!storage) return
  try {
    const tokens = sessionTokenMap()
    for (const definition of definitions) {
      if (definition.token) tokens[definition.id] = definition.token
    }
    saveSessionTokenMap(tokens)
    // Browser localStorage keeps server metadata only. Legacy bearer tokens
    // are session-scoped during migration; device auth can replace them.
    const persisted = definitions.map(({ token: _token, ...definition }) => definition)
    storage.setItem(SERVER_STORAGE_KEY, JSON.stringify(persisted))
  } catch {
    // Storage can be disabled or full. The live connection still works.
  }
}

function scopedId(
  prefix: "ses" | "tab" | "use",
  serverId: string,
  localId: string,
): string {
  return `${prefix}-${serverId}--${localId.slice(prefix.length + 1)}`
}

function publicSessionId(value: string): SessionId {
  return Schema.decodeUnknownSync(SessionId)(value)
}

function publicTabId(value: string): SessionTabId {
  return Schema.decodeUnknownSync(SessionTabId)(value)
}

function publicToolUseId(value: string): ToolUseId {
  return Schema.decodeUnknownSync(ToolUseId)(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function localProjectId(
  owner: Owner,
  publicProjectId: string,
  projectOwners: ReadonlyMap<string, Owner>,
): string {
  const projectOwner = projectOwners.get(publicProjectId)
  if (projectOwner && projectOwner.serverId === owner.serverId) {
    return projectOwner.localId
  }
  const marker = `${owner.serverId}::`
  return publicProjectId.startsWith(marker)
    ? publicProjectId.slice(marker.length)
    : publicProjectId
}

function scopedProjectId(serverId: string, projectId: string): string {
  return `${serverId}::${projectId}`
}

function scopedTerminalId(serverId: string, terminalId: string): string {
  return `term-${serverId}--${terminalId}`
}

export class MultiServerHostClient {
  readonly tools: JetElectronTools
  readonly ports: YaadeHostAPI

  private readonly currentServerId: string
  private readonly connections = new Map<string, ManagedConnection>()
  private readonly listeners = new Set<Listener>()
  private readonly toolEventListeners = new Set<(event: ToolEventValue) => void>()
  private readonly sessionOwners = new Map<string, Owner>()
  private readonly tabOwners = new Map<string, Owner>()
  private readonly toolUseOwners = new Map<string, Owner>()
  private readonly projectOwners = new Map<string, Owner>()
  private readonly ptyOwners = new Map<string, Owner>()
  private readonly terminalInstanceOwners = new Map<string, Owner>()
  private readonly agentOwners = new Map<string, Owner>()
  private readonly agentEventListeners = new Set<Parameters<JetElectronAgents["onEvent"]>[0]>()
  private readonly terminalExitListeners = new Set<(
    id: string,
    exitCode: number,
    signal?: number,
  ) => void>()
  private readonly terminalInstanceListeners = new Set<
    (event: TerminalInstanceEvent) => void
  >()
  private readonly aggregateTerminal: JetElectronTerminal
  private readonly aggregateAgents: JetElectronAgents
  private activeServerId: string | undefined
  private generation = 0
  private globalTarget?: MultiServerGlobalTarget
  private snapshot: MultiServerSnapshot

  constructor(options: {
    readonly currentServer: YaadeServerDefinition
    readonly servers?: readonly YaadeServerDefinition[]
    readonly globalTarget?: MultiServerGlobalTarget
  }) {
    this.currentServerId = options.currentServer.id
    this.globalTarget = options.globalTarget
    this.aggregateTerminal = this.createTerminal()
    this.aggregateAgents = this.createAgents()
    this.tools = this.createTools()
    this.syncDefinitions(options.currentServer, options.servers ?? [])
    this.ports = this.createPorts(options.currentServer)
    this.snapshot = this.makeSnapshot()
    this.selectServer(this.currentServerId)
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): MultiServerSnapshot => this.snapshot

  setGlobalTarget(target: MultiServerGlobalTarget | undefined): void {
    this.globalTarget = target
    this.publishGlobal()
  }

  getServerDefinitions(): YaadeServerDefinition[] {
    return [...this.connections.values()]
      .map(connection => connection.definition)
      .filter(definition => definition.id !== this.currentServerId)
  }

  setServers(definitions: readonly YaadeServerDefinition[]): void {
    const current = this.connections.get(this.currentServerId)?.definition
    if (!current) return
    this.syncDefinitions(current, definitions)
    this.generation += 1
    this.snapshot = this.makeSnapshot()
    this.publishGlobal()
    this.publish()
  }

  selectSession(sessionId: string): void {
    const owner = this.sessionOwners.get(sessionId)
    if (owner) this.selectServer(owner.serverId)
  }

  selectTab(tabId: string): void {
    const owner = this.tabOwners.get(tabId)
    if (owner) this.selectServer(owner.serverId)
  }

  selectToolUse(toolUseId: string): void {
    const owner = this.toolUseOwners.get(toolUseId)
    if (owner) this.selectServer(owner.serverId)
  }

  serverForSession(sessionId: string): YaadeServerConnection | undefined {
    const owner = this.sessionOwners.get(sessionId)
    return owner ? this.connectionInfo(owner.serverId) : undefined
  }

  onToolEvent(callback: (event: ToolEventValue) => void): () => void {
    this.toolEventListeners.add(callback)
    return () => this.toolEventListeners.delete(callback)
  }

  async testServer(definition: YaadeServerDefinition): Promise<ServerTestResult> {
    let normalized: YaadeServerDefinition
    try {
      normalized = normalizeServerDefinition(definition) ?? (() => {
        throw new Error("Enter a valid http or https server URL")
      })()
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
    const transport = new WebHostTransport({
      baseUrl: normalized.url,
      authToken: normalized.token ?? null,
    })
    const api = createYaadeApi(transport)
    try {
      const sessions = await api.tools.listSessions(false)
      return { ok: true, sessionCount: sessions.length }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    } finally {
      transport.close()
    }
  }

  private createPorts(currentServer: YaadeServerDefinition): YaadeHostAPI {
    const connection = this.connections.get(currentServer.id)
    if (connection) {
      return { ...connection.api, tools: this.tools, terminal: this.aggregateTerminal, agents: this.aggregateAgents }
    }
    // The current connection is installed by syncDefinitions immediately after
    // construction. This branch only keeps the object creation type-safe.
    throw new Error("current YAADE server was not initialized")
  }

  private syncDefinitions(
    currentServer: YaadeServerDefinition,
    definitions: readonly YaadeServerDefinition[],
  ): void {
    const desired = new Map<string, YaadeServerDefinition>()
    desired.set(currentServer.id, currentServer)
    for (const definition of definitions) {
      const normalized = normalizeServerDefinition(definition)
      if (!normalized || normalized.id === currentServer.id || desired.has(normalized.id)) continue
      if ([...desired.values()].some(item => item.url === normalized.url)) continue
      desired.set(normalized.id, normalized)
    }

    for (const [id, connection] of this.connections) {
      const next = desired.get(id)
      if (!next || next.url !== connection.definition.url || next.token !== connection.definition.token) {
        this.disposeConnection(connection)
        this.connections.delete(id)
      }
    }
    for (const definition of desired.values()) {
      if (!this.connections.has(definition.id)) {
        this.connections.set(definition.id, this.createConnection(definition))
      }
    }
    if (!this.activeServerId || !this.connections.has(this.activeServerId)) {
      this.activeServerId = currentServer.id
    }
  }

  private createConnection(definition: YaadeServerDefinition): ManagedConnection {
    const transport = new WebHostTransport({
      baseUrl: definition.url,
      authToken:
        definition.id === this.currentServerId
          ? undefined
          : definition.token ?? null,
    })
    const api = createYaadeApi(transport)
    const connection: ManagedConnection = {
      definition,
      transport,
      api,
      status: "connecting",
      sessionCount: 0,
      disposeStatus: () => undefined,
      disposeTools: () => undefined,
      disposeTerminal: () => undefined,
      disposeAgents: () => undefined,
    }
    const disposeConnectionStatus = transport.on("connection:status", (...args) => {
      const status = args[0]
      if (status === "connected") {
        connection.status = "connected"
        connection.error = undefined
      } else if (status === "synchronizing") {
        connection.status = "synchronizing"
      } else if (status === "disconnected") {
        if (connection.status !== "revoked" && connection.status !== "incompatible") {
          connection.status = "offline"
        }
      }
      this.snapshot = this.makeSnapshot()
      this.publish()
    })
    const disposeProtocolErrors = transport.on("protocol:error", (...args) => {
      const message = String(args[0] ?? "")
      if (/incompatible/i.test(message)) connection.status = "incompatible"
      else if (/revoked/i.test(message)) connection.status = "revoked"
      connection.error = message || connection.error
      this.snapshot = this.makeSnapshot()
      this.publish()
    })
    connection.disposeStatus = () => {
      disposeConnectionStatus()
      disposeProtocolErrors()
    }
    connection.disposeTools = api.tools.onEvent(event => {
      const scoped = this.scopeEvent(connection, event)
      for (const listener of this.toolEventListeners) listener(scoped)
    })
    const disposeExit = api.terminal.onExit((id, exitCode, signal) => {
      const scopedId = this.scopePtyId(connection.definition.id, id)
      for (const listener of this.terminalExitListeners) listener(scopedId, exitCode, signal)
    })
    const disposeInstance = api.terminal.onInstanceEvent(event => {
      const scoped = this.scopeTerminalInstance(connection, event.instance)
      for (const listener of this.terminalInstanceListeners) {
        listener({ ...event, instance: scoped })
      }
    })
    connection.disposeTerminal = () => {
      disposeExit()
      disposeInstance()
    }
    connection.disposeAgents = api.agents.onEvent(event => {
      const run = event.run ? this.scopeAgentRun(connection, event.run) : event.run
      for (const listener of this.agentEventListeners) listener({ ...event, run })
    })
    return connection
  }

  private disposeConnection(connection: ManagedConnection): void {
    connection.disposeStatus()
    connection.disposeTools()
    connection.disposeTerminal()
    connection.disposeAgents()
    connection.transport.close()
  }

  private selectServer(serverId: string): void {
    if (!this.connections.has(serverId)) return
    if (this.activeServerId === serverId) {
      this.publishGlobal()
      return
    }
    this.activeServerId = serverId
    this.publishGlobal()
    this.snapshot = this.makeSnapshot()
    this.publish()
  }

  private activeConnection(): ManagedConnection {
    const active = this.activeServerId
      ? this.connections.get(this.activeServerId)
      : undefined
    const fallback = active ?? this.connections.values().next().value
    if (!fallback) throw new Error("No YAADE servers are configured")
    return fallback
  }

  private connectionForOwner(owner: Owner): ManagedConnection {
    const connection = this.connections.get(owner.serverId)
    if (!connection) throw new Error("YAADE server is no longer connected")
    return connection
  }

  private ownerForSession(sessionId: string): Owner {
    const owner = this.sessionOwners.get(sessionId)
    if (!owner) throw new Error("Session is not available on a connected server")
    return owner
  }

  private ownerForTab(tabId: string): Owner {
    const owner = this.tabOwners.get(tabId)
    if (!owner) throw new Error("Window is not available on a connected server")
    return owner
  }

  private ownerForToolUse(toolUseId: string): Owner {
    const owner = this.toolUseOwners.get(toolUseId)
    if (!owner) throw new Error("Tool is not available on a connected server")
    return owner
  }

  private ownerForProject(projectId: string): Owner {
    const activeServerId = this.activeConnection().definition.id
    const mapped = this.projectOwners.get(projectId)
    return mapped?.serverId === activeServerId
      ? mapped
      : { serverId: activeServerId, localId: projectId }
  }

  private keepLocalIds(connection: ManagedConnection): boolean {
    return connection.definition.id === this.currentServerId
  }

  private scopeSession(connection: ManagedConnection, session: AppSessionValue): AppSessionValue {
    const owner = { serverId: connection.definition.id, localId: session.id }
    this.sessionOwners.set(session.id, owner)
    if (this.keepLocalIds(connection)) return session
    const id = publicSessionId(scopedId("ses", owner.serverId, owner.localId))
    this.sessionOwners.set(id, owner)
    return {
      ...session,
      id,
      ...(session.activeTabId
        ? { activeTabId: publicTabId(scopedId("tab", owner.serverId, session.activeTabId)) }
        : {}),
      ...(session.activeToolUseId
        ? { activeToolUseId: publicToolUseId(scopedId("use", owner.serverId, session.activeToolUseId)) }
        : {}),
    }
  }

  private scopeTab(connection: ManagedConnection, tab: import("@yaade/rpc").SessionTab): import("@yaade/rpc").SessionTab {
    const owner = { serverId: connection.definition.id, localId: tab.id }
    this.tabOwners.set(tab.id, owner)
    const sessionOwner = { serverId: connection.definition.id, localId: tab.sessionId }
    this.sessionOwners.set(tab.sessionId, sessionOwner)
    if (this.keepLocalIds(connection)) return tab
    const id = publicTabId(scopedId("tab", owner.serverId, owner.localId))
    this.tabOwners.set(id, owner)
    const sessionId = publicSessionId(scopedId("ses", sessionOwner.serverId, sessionOwner.localId))
    this.sessionOwners.set(sessionId, sessionOwner)
    return {
      ...tab,
      id,
      sessionId,
      ...(tab.activeToolUseId
        ? { activeToolUseId: publicToolUseId(scopedId("use", owner.serverId, tab.activeToolUseId)) }
        : {}),
    }
  }

  private scopeToolUse(connection: ManagedConnection, use: ToolUse): ToolUse {
    const owner = { serverId: connection.definition.id, localId: use.id }
    this.toolUseOwners.set(use.id, owner)
    const sessionOwner = { serverId: connection.definition.id, localId: use.sessionId }
    this.sessionOwners.set(use.sessionId, sessionOwner)
    const localProjectIdValue = use.context.project.projectId
    const projectOwner = {
      serverId: owner.serverId,
      localId: localProjectIdValue,
    }
    this.projectOwners.set(localProjectIdValue, projectOwner)
    if (use.output.kind === "process" && use.output.ptyId) {
      this.ptyOwners.set(use.output.ptyId, {
        serverId: owner.serverId,
        localId: use.output.ptyId,
      })
    }
    if (this.keepLocalIds(connection)) return use
    const id = publicToolUseId(scopedId("use", owner.serverId, owner.localId))
    this.toolUseOwners.set(id, owner)
    const sessionId = publicSessionId(scopedId("ses", sessionOwner.serverId, sessionOwner.localId))
    this.sessionOwners.set(sessionId, sessionOwner)
    const projectId = scopedProjectId(owner.serverId, localProjectIdValue)
    this.projectOwners.set(projectId, projectOwner)
    const output = this.scopeProcessOutput(owner.serverId, use.output)
    if (use.output.kind === "process" && use.output.ptyId) {
      this.ptyOwners.set(this.scopePtyId(owner.serverId, use.output.ptyId), {
        serverId: owner.serverId,
        localId: use.output.ptyId,
      })
    }
    return {
      ...use,
      id,
      sessionId,
      ...(use.tabId
        ? { tabId: publicTabId(scopedId("tab", owner.serverId, use.tabId)) }
        : {}),
      context: {
        ...use.context,
        project: { ...use.context.project, projectId },
      },
      output,
    }
  }

  private scopePtyId(serverId: string, localId: string): string {
    if (serverId === this.currentServerId) return localId
    return scopedTerminalId(serverId, localId)
  }

  private ownerForPty(ptyId: string): Owner {
    const owner = this.ptyOwners.get(ptyId)
    if (owner) return owner
    return {
      serverId: this.activeConnection().definition.id,
      localId: ptyId,
    }
  }

  private scopeTerminalInstance(
    connection: ManagedConnection,
    instance: TerminalInstanceInfo,
  ): TerminalInstanceInfo {
    const owner = { serverId: connection.definition.id, localId: instance.id }
    this.terminalInstanceOwners.set(instance.id, owner)
    if (instance.ptyId) {
      this.ptyOwners.set(instance.ptyId, {
        serverId: owner.serverId,
        localId: instance.ptyId,
      })
    }
    if (this.keepLocalIds(connection)) return instance
    const id = scopedTerminalId(owner.serverId, owner.localId)
    this.terminalInstanceOwners.set(id, owner)
    if (instance.ptyId) {
      this.ptyOwners.set(this.scopePtyId(owner.serverId, instance.ptyId), {
        serverId: owner.serverId,
        localId: instance.ptyId,
      })
    }
    return {
      ...instance,
      id,
      projectId: scopedProjectId(owner.serverId, instance.projectId),
      ...(instance.workspaceId
        ? { workspaceId: scopedId("ses", owner.serverId, instance.workspaceId) }
        : {}),
      ...(instance.ptyId
        ? { ptyId: this.scopePtyId(owner.serverId, instance.ptyId) }
        : {}),
    }
  }

  private scopeProcessOutput(
    serverId: string,
    output: ToolUse["output"],
  ): ToolUse["output"] {
    if (output.kind !== "process") return output
    return {
      ...output,
      terminalInstanceId: scopedTerminalId(serverId, output.terminalInstanceId),
      ...(output.ptyId
        ? { ptyId: this.scopePtyId(serverId, output.ptyId) }
        : {}),
    }
  }

  private scopeSnapshot(
    connection: ManagedConnection,
    snapshot: ToolSessionSnapshot,
  ): ToolSessionSnapshot {
    return {
      session: this.scopeSession(connection, snapshot.session),
      ...(snapshot.tabs
        ? { tabs: snapshot.tabs.map(tab => this.scopeTab(connection, tab)) }
        : {}),
      toolUses: snapshot.toolUses.map(use => this.scopeToolUse(connection, use)),
    }
  }

  private scopeEvent(
    connection: ManagedConnection,
    event: ToolEventValue,
  ): ToolEventValue {
    switch (event._tag) {
      case "SessionCreated":
      case "SessionUpdated":
      case "SessionArchived":
      case "SessionRestored":
        return { ...event, session: this.scopeSession(connection, event.session) }
      case "SessionTabCreated":
      case "SessionTabUpdated":
      case "SessionTabArchived":
        return { ...event, tab: this.scopeTab(connection, event.tab) }
      case "ToolUseCreated":
      case "ToolUseUpdated":
        return {
          ...event,
          toolUseId: this.keepLocalIds(connection)
            ? event.toolUseId
            : publicToolUseId(scopedId("use", connection.definition.id, event.toolUseId)),
          toolUse: this.scopeToolUse(connection, event.toolUse),
        }
      case "ToolUseOutputChanged":
        if (event.output.kind === "process" && event.output.ptyId) {
          const ptyId = this.keepLocalIds(connection)
            ? event.output.ptyId
            : this.scopePtyId(connection.definition.id, event.output.ptyId)
          this.ptyOwners.set(ptyId, {
            serverId: connection.definition.id,
            localId: event.output.ptyId,
          })
        }
        return {
          ...event,
          toolUseId: this.keepLocalIds(connection)
            ? event.toolUseId
            : publicToolUseId(scopedId("use", connection.definition.id, event.toolUseId)),
          output: this.keepLocalIds(connection)
            ? event.output
            : this.scopeProcessOutput(connection.definition.id, event.output),
        }
      case "ToolUseArchived":
        return {
          ...event,
          toolUseId: this.keepLocalIds(connection)
            ? event.toolUseId
            : publicToolUseId(scopedId("use", connection.definition.id, event.toolUseId)),
        }
    }
  }

  private ownerForAgent(runId: string): Owner {
    const owner = this.agentOwners.get(runId)
    if (owner) return owner
    return {
      serverId: this.activeConnection().definition.id,
      localId: runId,
    }
  }

  private scopeAgentRun(connection: ManagedConnection, run: AgentRunInfo): AgentRunInfo {
    const owner = { serverId: connection.definition.id, localId: run.runId }
    this.agentOwners.set(run.runId, owner)
    if (run.toolUseId) {
      this.toolUseOwners.set(run.toolUseId, {
        serverId: owner.serverId,
        localId: run.toolUseId,
      })
    }
    if (run.ptyId) {
      this.ptyOwners.set(run.ptyId, { serverId: owner.serverId, localId: run.ptyId })
    }
    if (this.keepLocalIds(connection)) return run
    const runId = `run-${owner.serverId}--${owner.localId}`
    this.agentOwners.set(runId, owner)
    const toolUseId = run.toolUseId
      ? publicToolUseId(scopedId("use", owner.serverId, run.toolUseId))
      : run.toolUseId
    if (toolUseId && run.toolUseId) {
      this.toolUseOwners.set(toolUseId, {
        serverId: owner.serverId,
        localId: run.toolUseId,
      })
    }
    const ptyId = run.ptyId ? this.scopePtyId(owner.serverId, run.ptyId) : run.ptyId
    if (ptyId && run.ptyId) {
      this.ptyOwners.set(ptyId, { serverId: owner.serverId, localId: run.ptyId })
    }
    const projectId = scopedProjectId(owner.serverId, run.projectId)
    this.projectOwners.set(projectId, { serverId: owner.serverId, localId: run.projectId })
    this.projectOwners.set(run.projectId, { serverId: owner.serverId, localId: run.projectId })
    return { ...run, runId, toolUseId, ptyId, projectId }
  }

  private createAgents(): JetElectronAgents {
    const self = this
    const collectLive = async (projectId?: string): Promise<AgentRunInfo[]> => {
      const results: AgentRunInfo[] = []
      for (const connection of self.connections.values()) {
        try {
          const values = projectId === undefined
            ? await connection.api.agents.listLive()
            : await connection.api.agents.listLive(projectId)
          connection.status = "connected"
          for (const run of values) results.push(self.scopeAgentRun(connection, run))
        } catch (error) {
          connection.status = "offline"
          connection.error = errorMessage(error)
        }
      }
      self.snapshot = self.makeSnapshot()
      self.publish()
      return results
    }
    return {
      listProviders: refresh => self.activeConnection().api.agents.listProviders(refresh),
      launch: req => self.activeConnection().api.agents.launch(req),
      stop: req => {
        const owner = self.ownerForAgent(req.runId)
        return self.connectionForOwner(owner).api.agents.stop({ ...req, runId: owner.localId })
      },
      close: req => {
        const owner = self.ownerForAgent(req.runId)
        return self.connectionForOwner(owner).api.agents.close({ ...req, runId: owner.localId })
      },
      listLive: projectId => collectLive(projectId),
      listProject: async projectId => {
        const owner = self.ownerForProject(projectId)
        const values = await self.connectionForOwner(owner).api.agents.listProject(
          localProjectId(owner, projectId, self.projectOwners),
        )
        return values.map(run => self.scopeAgentRun(self.connectionForOwner(owner), run))
      },
      get: async runId => {
        const owner = self.ownerForAgent(runId)
        const local = await self.connectionForOwner(owner).api.agents.get(owner.localId)
        return local ? self.scopeAgentRun(self.connectionForOwner(owner), local) : null
      },
      getTranscript: runId => {
        const owner = self.ownerForAgent(runId)
        return self.connectionForOwner(owner).api.agents.getTranscript(owner.localId)
      },
      listActivity: async opts => {
        const runs: AgentRunInfo[] = []
        let nextCursor: string | null = null
        for (const connection of self.connections.values()) {
          try {
            const page = await connection.api.agents.listActivity(opts)
            connection.status = "connected"
            for (const run of page.runs) runs.push(self.scopeAgentRun(connection, run))
            if (page.nextCursor) nextCursor = page.nextCursor
          } catch (error) {
            connection.status = "offline"
            connection.error = errorMessage(error)
          }
        }
        return { runs, nextCursor }
      },
      getSnapshot: sessionId => {
        const owner = self.ownerForSession(sessionId)
        return self.connectionForOwner(owner).api.agents.getSnapshot(owner.localId)
      },
      listEvents: (sessionId, opts) => {
        const owner = self.ownerForSession(sessionId)
        return self.connectionForOwner(owner).api.agents.listEvents(owner.localId, opts)
      },
      ingestNative: req => self.activeConnection().api.agents.ingestNative(req),
      installProjectHooks: req => self.activeConnection().api.agents.installProjectHooks(req),
      onEvent: callback => {
        self.agentEventListeners.add(callback)
        return () => self.agentEventListeners.delete(callback)
      },
    }
  }

  private createTerminal(): JetElectronTerminal {
    const self = this
    return {
      create: async (cwdUri, launch) => {
        const connection = self.activeConnection()
        const local = await connection.api.terminal.create(cwdUri, launch)
        const id = self.scopePtyId(connection.definition.id, local.id)
        self.ptyOwners.set(id, { serverId: connection.definition.id, localId: local.id })
        return { ...local, id }
      },
      attach: (id) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.attach(owner.localId)
      },
      write: (id, data) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.write(owner.localId, data)
      },
      writeBinary: (id, data) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.writeBinary(owner.localId, data)
      },
      resize: (id, cols, rows) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.resize(owner.localId, cols, rows)
      },
      acknowledgeData: (id, count) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.acknowledgeData(owner.localId, count)
      },
      markReplayReady: (id) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.markReplayReady(owner.localId)
      },
      getCwd: (id) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.getCwd(owner.localId)
      },
      getForegroundProcess: (id) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.getForegroundProcess(owner.localId)
      },
      onData: (id, callback) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.onData(owner.localId, callback)
      },
      onExit: (callback) => {
        self.terminalExitListeners.add(callback)
        return () => self.terminalExitListeners.delete(callback)
      },
      dispose: (id) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.dispose(owner.localId)
      },
      listInstances: async projectId => {
        const owner = self.ownerForProject(projectId)
        const values = await self.connectionForOwner(owner).api.terminal.listInstances(
          localProjectId(owner, projectId, self.projectOwners),
        )
        return values.map(value => self.scopeTerminalInstance(self.connectionForOwner(owner), value))
      },
      createInstance: async request => {
        const owner = self.ownerForProject(request.projectId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.terminal.createInstance({
          ...request,
          projectId: localProjectId(owner, request.projectId, self.projectOwners),
        })
        return self.scopeTerminalInstance(connection, local)
      },
      restartInstance: async request => {
        const owner = self.terminalInstanceOwners.get(request.id) ?? self.ownerForPty(request.id)
        const localId = self.terminalInstanceOwners.get(request.id)?.localId ?? owner.localId
        const local = await self.connectionForOwner(owner).api.terminal.restartInstance({ ...request, id: localId })
        return local ? self.scopeTerminalInstance(self.connectionForOwner(owner), local) : null
      },
      resumeInstance: async request => {
        const owner = self.terminalInstanceOwners.get(request.id) ?? self.ownerForPty(request.id)
        const localId = self.terminalInstanceOwners.get(request.id)?.localId ?? owner.localId
        const local = await self.connectionForOwner(owner).api.terminal.resumeInstance({ ...request, id: localId })
        return local ? self.scopeTerminalInstance(self.connectionForOwner(owner), local) : null
      },
      closeInstance: async request => {
        const owner = self.terminalInstanceOwners.get(request.id) ?? self.ownerForPty(request.id)
        const localId = self.terminalInstanceOwners.get(request.id)?.localId ?? owner.localId
        const local = await self.connectionForOwner(owner).api.terminal.closeInstance({ ...request, id: localId })
        return local ? self.scopeTerminalInstance(self.connectionForOwner(owner), local) : null
      },
      getInstanceTranscript: (id) => {
        const owner = self.terminalInstanceOwners.get(id) ?? self.ownerForPty(id)
        const localId = self.terminalInstanceOwners.get(id)?.localId ?? owner.localId
        return self.connectionForOwner(owner).api.terminal.getInstanceTranscript(localId)
      },
      onInstanceEvent: (callback) => {
        self.terminalInstanceListeners.add(callback)
        return () => self.terminalInstanceListeners.delete(callback)
      },
      acquireLease: (id, mode) => {
        const owner = self.ownerForPty(id)
        return mode === undefined
          ? self.connectionForOwner(owner).api.terminal.acquireLease(owner.localId)
          : self.connectionForOwner(owner).api.terminal.acquireLease(owner.localId, mode)
      },
      renewLease: (id, leaseId) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.renewLease(owner.localId, leaseId)
      },
      releaseLease: (id, leaseId) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.releaseLease(owner.localId, leaseId)
      },
      requestControl: id => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.requestControl(owner.localId)
      },
      transferControl: (id, leaseId, targetClientId) => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.transferControl(owner.localId, leaseId, targetClientId)
      },
      listViewers: id => {
        const owner = self.ownerForPty(id)
        return self.connectionForOwner(owner).api.terminal.listViewers(owner.localId)
      },
    }
  }

  private toLocalCommand(command: unknown): unknown {
    if (!isRecord(command) || typeof command._tag !== "string") return command
    switch (command._tag) {
      case "CreateSessionTab": {
        const owner = this.ownerForSession(String(command.sessionId))
        return { ...command, sessionId: publicSessionId(owner.localId) }
      }
      case "RenameSessionTab":
      case "SaveSessionTabLayout":
      case "ArchiveSessionTab": {
        const owner = this.ownerForTab(String(command.tabId))
        return { ...command, tabId: publicTabId(owner.localId) }
      }
      case "ReorderSessionTabs":
      case "SelectSessionTab": {
        const owner = this.ownerForSession(String(command.sessionId))
        const tabIds = Array.isArray(command.tabIds)
          ? command.tabIds.map(value => publicTabId(this.ownerForTab(String(value)).localId))
          : undefined
        return {
          ...command,
          sessionId: publicSessionId(owner.localId),
          ...(tabIds ? { tabIds } : {}),
          ...(command.tabId
            ? { tabId: publicTabId(this.ownerForTab(String(command.tabId)).localId) }
            : {}),
        }
      }
      case "ArchiveSession":
      case "RestoreSession":
      case "RenameSession": {
        const owner = this.ownerForSession(String(command.sessionId))
        return { ...command, sessionId: publicSessionId(owner.localId) }
      }
      case "CreateToolUse": {
        const owner = this.ownerForSession(String(command.sessionId))
        const project = isRecord(command.project)
          ? {
              ...command.project,
              projectId: localProjectId(
                owner,
                String(command.project.projectId),
                this.projectOwners,
              ),
            }
          : command.project
        return {
          ...command,
          sessionId: publicSessionId(owner.localId),
          ...(command.tabId
            ? { tabId: publicTabId(this.ownerForTab(String(command.tabId)).localId) }
            : {}),
          project,
        }
      }
      case "UpdateToolUseContext": {
        const owner = this.ownerForToolUse(String(command.toolUseId))
        const project = isRecord(command.project)
          ? {
              ...command.project,
              projectId: localProjectId(
                owner,
                String(command.project.projectId),
                this.projectOwners,
              ),
            }
          : command.project
        return {
          ...command,
          toolUseId: publicToolUseId(owner.localId),
          project,
        }
      }
      case "ReorderToolUses": {
        const owner = this.ownerForSession(String(command.sessionId))
        return {
          ...command,
          sessionId: publicSessionId(owner.localId),
          ...(command.tabId
            ? { tabId: publicTabId(this.ownerForTab(String(command.tabId)).localId) }
            : {}),
          toolUseIds: Array.isArray(command.toolUseIds)
            ? command.toolUseIds.map(value => publicToolUseId(this.ownerForToolUse(String(value)).localId))
            : command.toolUseIds,
        }
      }
      case "CancelToolUse":
      case "RestartToolUse":
      case "ArchiveToolUse": {
        const owner = this.ownerForToolUse(String(command.toolUseId))
        return { ...command, toolUseId: publicToolUseId(owner.localId) }
      }
      case "SelectSessionToolUse": {
        const owner = this.ownerForSession(String(command.sessionId))
        return {
          ...command,
          sessionId: publicSessionId(owner.localId),
          ...(command.toolUseId
            ? { toolUseId: publicToolUseId(this.ownerForToolUse(String(command.toolUseId)).localId) }
            : {}),
        }
      }
      default:
        return command
    }
  }

  private createTools(): JetElectronTools {
    const self = this
    return {
      listSessions: async includeArchived => {
        let succeeded = 0
        const results = await Promise.all(
          [...self.connections.values()].map(async connection => {
            try {
              const snapshots = await connection.api.tools.listSessions(includeArchived)
              connection.status = "connected"
              connection.error = undefined
              connection.sessionCount = snapshots.filter(snapshot => !snapshot.session.archivedAt).length
              succeeded += 1
              return snapshots.map(snapshot => self.scopeSnapshot(connection, snapshot))
            } catch (error) {
              connection.status = "offline"
              connection.error = errorMessage(error)
              return []
            }
          }),
        )
        self.snapshot = self.makeSnapshot()
        self.publish()
        if (succeeded === 0 && self.connections.size > 0) {
          throw new Error("No YAADE servers are reachable")
        }
        return results.flat()
      },
      reorderSessions: async command => {
        const grouped = new Map<string, SessionId[]>()
        for (const id of command.sessionIds) {
          const owner = self.ownerForSession(id)
          const ids = grouped.get(owner.serverId) ?? []
          ids.push(publicSessionId(owner.localId))
          grouped.set(owner.serverId, ids)
        }
        const results: AppSessionValue[] = []
        for (const [serverId, sessionIds] of grouped) {
          const connection = self.connections.get(serverId)
          if (!connection) continue
          const local = await connection.api.tools.reorderSessions({ ...command, sessionIds })
          results.push(...local.map(session => self.scopeSession(connection, session)))
        }
        return results
      },
      createTab: async command => {
        const owner = self.ownerForSession(command.sessionId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.tools.createTab(
          Schema.decodeUnknownSync(CreateSessionTab)(self.toLocalCommand(command)),
        )
        return self.scopeTab(connection, local)
      },
      renameTab: async command => {
        const owner = self.ownerForTab(command.tabId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.tools.renameTab(
          Schema.decodeUnknownSync(RenameSessionTab)(self.toLocalCommand(command)),
        )
        return self.scopeTab(connection, local)
      },
      saveTabLayout: async command => {
        const owner = self.ownerForTab(command.tabId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.tools.saveTabLayout(
          Schema.decodeUnknownSync(SaveSessionTabLayout)(self.toLocalCommand(command)),
        )
        return self.scopeTab(connection, local)
      },
      reorderTabs: async command => {
        const owner = self.ownerForSession(command.sessionId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.tools.reorderTabs(
          Schema.decodeUnknownSync(ReorderSessionTabs)(self.toLocalCommand(command)),
        )
        return local.map(tab => self.scopeTab(connection, tab))
      },
      archiveTab: async command => {
        const owner = self.ownerForTab(command.tabId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.tools.archiveTab(
          Schema.decodeUnknownSync(ArchiveSessionTab)(self.toLocalCommand(command)),
        )
        return self.scopeTab(connection, local)
      },
      selectTab: async command => {
        const owner = self.ownerForSession(command.sessionId)
        const connection = self.connectionForOwner(owner)
        self.selectServer(owner.serverId)
        const local = await connection.api.tools.selectTab(
          Schema.decodeUnknownSync(SelectSessionTab)(self.toLocalCommand(command)),
        )
        return self.scopeSession(connection, local)
      },
      archiveSession: async command => {
        const owner = self.ownerForSession(command.sessionId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.tools.archiveSession(
          Schema.decodeUnknownSync(ArchiveSession)(self.toLocalCommand(command)),
        )
        return self.scopeSession(connection, local)
      },
      restoreSession: async command => {
        const owner = self.ownerForSession(command.sessionId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.tools.restoreSession(
          Schema.decodeUnknownSync(RestoreSession)(self.toLocalCommand(command)),
        )
        return self.scopeSession(connection, local)
      },
      createSession: async title => {
        const connection = self.activeConnection()
        const local = await connection.api.tools.createSession(title)
        return self.scopeSession(connection, local)
      },
      renameSession: async (sessionId, title) => {
        const owner = self.ownerForSession(sessionId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.tools.renameSession(publicSessionId(owner.localId), title)
        return self.scopeSession(connection, local)
      },
      getSession: async sessionId => {
        const owner = self.ownerForSession(sessionId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.tools.getSession(publicSessionId(owner.localId))
        return local ? self.scopeSnapshot(connection, local) : null
      },
      createUse: async command => {
        const owner = self.ownerForSession(command.sessionId)
        const connection = self.connectionForOwner(owner)
        self.selectServer(owner.serverId)
        const local = await connection.api.tools.createUse(
          Schema.decodeUnknownSync(CreateToolUse)(self.toLocalCommand(command)),
        )
        return self.scopeToolUse(connection, local)
      },
      getUse: async toolUseId => {
        const owner = self.ownerForToolUse(toolUseId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.tools.getUse(publicToolUseId(owner.localId))
        return local ? self.scopeToolUse(connection, local) : null
      },
      reorderUses: async command => {
        const owner = self.ownerForSession(command.sessionId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.tools.reorderUses(
          Schema.decodeUnknownSync(ReorderToolUses)(self.toLocalCommand(command)),
        )
        return local.map(use => self.scopeToolUse(connection, use))
      },
      updateUseContext: async command => {
        const owner = self.ownerForToolUse(command.toolUseId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.tools.updateUseContext(
          Schema.decodeUnknownSync(UpdateToolUseContext)(self.toLocalCommand(command)),
        )
        return self.scopeToolUse(connection, local)
      },
      selectUse: async (sessionId, toolUseId) => {
        const owner = self.ownerForSession(sessionId)
        const connection = self.connectionForOwner(owner)
        self.selectServer(owner.serverId)
        const local = await connection.api.tools.selectUse(
          publicSessionId(owner.localId),
          toolUseId ? publicToolUseId(self.ownerForToolUse(toolUseId).localId) : undefined,
        )
        return self.scopeSession(connection, local)
      },
      cancelUse: async (toolUseId, revision) => {
        const owner = self.ownerForToolUse(toolUseId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.tools.cancelUse(publicToolUseId(owner.localId), revision)
        return self.scopeToolUse(connection, local)
      },
      restartUse: async (toolUseId, revision) => {
        const owner = self.ownerForToolUse(toolUseId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.tools.restartUse(publicToolUseId(owner.localId), revision)
        return self.scopeToolUse(connection, local)
      },
      archiveUse: async command => {
        const owner = self.ownerForToolUse(command.toolUseId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.tools.archiveUse(
          Schema.decodeUnknownSync(ArchiveToolUse)(self.toLocalCommand(command)),
        )
        return self.scopeToolUse(connection, local)
      },
      renameUse: async (toolUseId, title) => {
        const owner = self.ownerForToolUse(toolUseId)
        const connection = self.connectionForOwner(owner)
        const local = await connection.api.tools.renameUse(publicToolUseId(owner.localId), title)
        return self.scopeToolUse(connection, local)
      },
      listCheckoutTargets: async projectId => {
        const owner = self.ownerForProject(projectId)
        const connection = self.connectionForOwner(owner)
        const targets = await connection.api.tools.listCheckoutTargets(
          localProjectId(owner, projectId, self.projectOwners),
        )
        return targets
      },
      addProject: async rootPath => {
        const connection = self.activeConnection()
        const project = await connection.api.tools.addProject(rootPath)
        self.projectOwners.set(project.projectId, {
          serverId: connection.definition.id,
          localId: project.projectId,
        })
        const scoped = scopedProjectId(connection.definition.id, project.projectId)
        self.projectOwners.set(scoped, {
          serverId: connection.definition.id,
          localId: project.projectId,
        })
        return { ...project, projectId: scoped }
      },
      onEvent: callback => self.onToolEvent(callback),
      listProjects: async () => {
        // Projects are local to the active server. Sessions are aggregated
        // across servers, but returning every server's projects here lets a
        // newly selected remote session inherit the old server's project.
        const connection = self.activeConnection()
        try {
          const values = await connection.api.tools.listProjects()
          connection.status = "connected"
          connection.error = undefined
          const results = values.map(project => {
            self.projectOwners.set(project.projectId, {
              serverId: connection.definition.id,
              localId: project.projectId,
            })
            const scoped = scopedProjectId(connection.definition.id, project.projectId)
            self.projectOwners.set(scoped, {
              serverId: connection.definition.id,
              localId: project.projectId,
            })
            return { ...project, projectId: scoped }
          })
          self.snapshot = self.makeSnapshot()
          self.publish()
          return results
        } catch (error) {
          connection.status = "offline"
          connection.error = errorMessage(error)
          self.snapshot = self.makeSnapshot()
          self.publish()
          return []
        }
      },
    }
  }

  private connectionInfo(serverId: string): YaadeServerConnection | undefined {
    const connection = this.connections.get(serverId)
    if (!connection) return undefined
    return {
      id: connection.definition.id,
      name: connection.definition.name,
      url: connection.definition.url,
      status: connection.status,
      sessionCount: connection.sessionCount,
      ...(connection.error ? { error: connection.error } : {}),
    }
  }

  private makeSnapshot(): MultiServerSnapshot {
    return {
      connections: [...this.connections.keys()]
        .map(id => this.connectionInfo(id))
        .filter((value): value is YaadeServerConnection => Boolean(value)),
      activeServerId: this.activeServerId,
      generation: this.generation,
    }
  }

  private publishGlobal(): void {
    const active = this.activeServerId
      ? this.connections.get(this.activeServerId)
      : undefined
    if (active) {
      Object.assign(this.ports, active.api, {
        tools: this.tools,
        terminal: this.aggregateTerminal,
        agents: this.aggregateAgents,
      })
    }
    this.globalTarget?.setYaade(this.ports)
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}

export function createMultiServerHostClient(options: {
  readonly currentServer: YaadeServerDefinition
  readonly servers?: readonly YaadeServerDefinition[]
  readonly globalTarget?: MultiServerGlobalTarget
}): MultiServerHostClient {
  return new MultiServerHostClient(options)
}

export { SERVER_STORAGE_KEY }
