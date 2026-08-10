import type {
  LanguageServerDefinition,
  LspLifecycleEvent,
  LspResolveRequest,
  LspStartResult,
  ResolvedLanguageServerTarget,
  WorkspaceFile,
} from "@yaade/workspace"
import { Emitter, fileUriToPath } from "@yaade/shared"
import { parentDir } from "./project-root.js"

export type LspConnection = {
  id: string
  rootUri: string
  projectRootUri: string
  processCwdUri?: string
  languageIds: readonly string[]
  transportUrl: string
  descriptorId: string
  initializationOptions?: unknown
  settings?: unknown
  catalogVersion: number
}

type LspApi = {
  resolve(request: LspResolveRequest): Promise<ResolvedLanguageServerTarget | null>
  start(target: ResolvedLanguageServerTarget): Promise<LspStartResult>
  stop(id: string): Promise<void>
  listDefinitions(): Promise<LanguageServerDefinition[]>
  onLifecycle?(cb: (event: LspLifecycleEvent) => void): () => void
  onCrashed?(cb: (id: string) => void): () => void
}

function targetKey(target: ResolvedLanguageServerTarget): string {
  return `${target.serverId}\0${target.projectRootUri}\0${target.processCwdUri ?? ""}`
}

function connectionFromResult(result: LspStartResult): LspConnection {
  return {
    id: result.id,
    rootUri: result.target.workspaceRootUri,
    projectRootUri: result.target.projectRootUri,
    processCwdUri: result.target.processCwdUri,
    languageIds: result.target.languageIds,
    transportUrl: result.transportUrl,
    descriptorId: result.target.serverId,
    initializationOptions: result.target.initializationOptions,
    settings: result.target.settings,
    catalogVersion: result.target.catalogVersion,
  }
}

export class LanguageServerManager {
  private readonly connections = new Map<string, LspConnection>()
  private readonly targets = new Map<string, ResolvedLanguageServerTarget>()
  private readonly pendingConnections = new Map<string, Promise<LspConnection | null>>()
  private readonly resolutionCache = new Map<string, ResolvedLanguageServerTarget | null>()
  private readonly pendingResolutions = new Map<string, Promise<ResolvedLanguageServerTarget | null>>()
  private readonly supportedLanguages = new Set<string>()
  private lastSpawnError: string | null = null
  private lastSpawnServerId: string | null = null
  private readonly disposeCrashListener: (() => void) | null
  private readonly disposeLifecycleListener: (() => void) | null
  private lifecycleGeneration = 0
  private disposed = false
  readonly onDiagnostics = new Emitter<unknown>()
  readonly onLifecycle = new Emitter<LspLifecycleEvent>()

  constructor(private readonly lspApi: LspApi) {
    void lspApi.listDefinitions().then(definitions => {
      if (this.disposed) return
      this.supportedLanguages.clear()
      for (const definition of definitions) {
        if (!definition.enabled) continue
        for (const languageId of definition.languages) this.supportedLanguages.add(languageId)
      }
    }).catch(() => {})
    this.disposeLifecycleListener = lspApi.onLifecycle?.(event => {
      this.handleLifecycle(event)
    }) ?? null
    this.disposeCrashListener = lspApi.onCrashed?.(id => {
      // Older hosts only expose this narrow signal.
      this.clearConnection(id)
    }) ?? null
  }

  async ensureServerForFile(
    file: WorkspaceFile,
    workspaceRootUri: string,
    processCwdUri?: string,
  ): Promise<LspConnection | null> {
    if (this.disposed) return null
    const target = await this.resolveTarget(file, workspaceRootUri, processCwdUri)
    if (!target || this.disposed) return null
    const key = targetKey(target)
    this.targets.set(key, target)
    const existing = this.connections.get(key)
    if (existing) return existing
    const pending = this.pendingConnections.get(key)
    if (pending) return pending

    const generation = this.lifecycleGeneration
    const starting = (async (): Promise<LspConnection | null> => {
      try {
        const result = await this.lspApi.start(target)
        if (result.error || !result.id) {
          this.lastSpawnError = result.error ?? "Language server failed to start"
          this.lastSpawnServerId = target.serverId
          return null
        }
        if (this.disposed || generation !== this.lifecycleGeneration) {
          await this.lspApi.stop(result.id).catch(() => {})
          return null
        }
        const connection = connectionFromResult(result)
        this.connections.set(key, connection)
        this.targets.set(key, result.target)
        this.lastSpawnError = null
        this.lastSpawnServerId = null
        return connection
      } catch (error) {
        this.lastSpawnError = error instanceof Error ? error.message : "Language server failed to start"
        this.lastSpawnServerId = target.serverId
        return null
      }
    })()
    this.pendingConnections.set(key, starting)
    try {
      return await starting
    } finally {
      if (this.pendingConnections.get(key) === starting) this.pendingConnections.delete(key)
    }
  }

  isLanguageSupported(languageId: string): boolean {
    return this.supportedLanguages.has(languageId)
  }

  consumeLastSpawnError(): { readonly message: string; readonly serverId: string | null } | null {
    const message = this.lastSpawnError
    if (!message) return null
    const result = { message, serverId: this.lastSpawnServerId }
    this.lastSpawnError = null
    this.lastSpawnServerId = null
    return result
  }

  getConnection(languageId: string, projectRootUri: string): LspConnection | null {
    for (const connection of this.connections.values()) {
      if (
        connection.projectRootUri === projectRootUri &&
        connection.languageIds.includes(languageId)
      ) {
        return connection
      }
    }
    return null
  }

  hasAnyConnection(): boolean {
    return this.connections.size > 0
  }

  listConnections(): LspConnection[] {
    return [...this.connections.values()]
  }

  clearConnection(id: string): void {
    for (const [key, connection] of this.connections) {
      if (connection.id === id) {
        this.connections.delete(key)
        return
      }
    }
  }

  async stopConnection(id: string): Promise<void> {
    this.clearConnection(id)
    await this.lspApi.stop(id).catch(() => {})
  }

  async stopServersForRoot(rootUri: string): Promise<string[]> {
    const toStop: LspConnection[] = []
    for (const [key, connection] of this.connections) {
      if (connection.rootUri === rootUri) {
        toStop.push(connection)
        this.connections.delete(key)
      }
    }
    await Promise.all(toStop.map(connection => this.lspApi.stop(connection.id).catch(() => {})))
    return toStop.map(connection => connection.id)
  }

  async stopAll(): Promise<string[]> {
    this.lifecycleGeneration += 1
    const connections = [...this.connections.values()]
    this.connections.clear()
    this.pendingConnections.clear()
    this.pendingResolutions.clear()
    await Promise.all(connections.map(connection => this.lspApi.stop(connection.id).catch(() => {})))
    return connections.map(connection => connection.id)
  }

  dispose(): void {
    this.disposed = true
    this.lifecycleGeneration += 1
    this.disposeCrashListener?.()
    this.disposeLifecycleListener?.()
    this.resolutionCache.clear()
    this.pendingResolutions.clear()
  }

  private async resolveTarget(
    file: WorkspaceFile,
    workspaceRootUri: string,
    processCwdUri?: string,
  ): Promise<ResolvedLanguageServerTarget | null> {
    const directory = parentDir(fileUriToPath(file.uri))
    const cacheKey = `${file.languageId}\0${workspaceRootUri}\0${processCwdUri ?? ""}\0${directory}`
    if (this.resolutionCache.has(cacheKey)) return this.resolutionCache.get(cacheKey) ?? null
    const pending = this.pendingResolutions.get(cacheKey)
    if (pending) return pending
    const resolving = this.lspApi.resolve({
      languageId: file.languageId,
      fileUri: file.uri,
      workspaceRootUri,
      ...(processCwdUri ? { processCwdUri } : {}),
    }).then(target => {
      if (!this.disposed) this.resolutionCache.set(cacheKey, target)
      return target
    })
    this.pendingResolutions.set(cacheKey, resolving)
    try {
      return await resolving
    } finally {
      if (this.pendingResolutions.get(cacheKey) === resolving) {
        this.pendingResolutions.delete(cacheKey)
      }
    }
  }

  private handleLifecycle(event: LspLifecycleEvent): void {
    if (this.disposed) return
    if (event.kind === "configuration-changed") {
      this.resolutionCache.clear()
      if (event.settingsOnly && event.serverId) {
        for (const [key, target] of this.targets) {
          if (target.serverId !== event.serverId) continue
          this.targets.set(key, { ...target, settings: event.settings })
          const connection = this.connections.get(key)
          if (connection) connection.settings = event.settings
        }
      }
    } else if ((event.kind === "crashed" || event.kind === "stopped") && event.sessionId) {
      this.clearConnection(event.sessionId)
    } else if (
      event.kind === "ready" &&
      event.serverId &&
      event.projectRootUri &&
      event.sessionId &&
      event.transportUrl
    ) {
      const key = `${event.serverId}\0${event.projectRootUri}\0${event.target?.processCwdUri ?? ""}`
      const target = event.target ?? this.targets.get(key)
      if (target) {
        this.targets.set(key, target)
        this.connections.set(key, connectionFromResult({
          id: event.sessionId,
          transportUrl: event.transportUrl,
          target,
        }))
      }
    }
    this.onLifecycle.fire(event)
  }
}
