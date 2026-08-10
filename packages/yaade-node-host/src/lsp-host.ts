import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import {
  LanguageServerDefinition,
  LspLifecycleEvent,
  LspLogEntry,
  LspLogRequest,
  LspStartResult,
  ResolvedLanguageServerTarget,
  type LspResolveRequest,
} from "@yaade/rpc"
import { LspBridge, type LspSession } from "./lsp-bridge.js"
import {
  builtinLanguageServerDefinitions,
  loadLanguageServerConfig,
  watchLanguageServerConfig,
  type LanguageServerCatalog,
  type LanguageServerConfigWatcher,
} from "./lsp-config.js"
import { assertAllowedPath } from "./sandbox.js"
import { pathToUri, uriToPath } from "./paths.js"

const MAX_LOG_ENTRIES = 1_000
const MAX_RESTART_ATTEMPTS = 3
const RESTART_BASE_DELAY_MS = 500
const RESTART_STABLE_RESET_MS = 30_000

type ActiveConnection = {
  readonly key: string
  readonly target: ResolvedLanguageServerTarget
  readonly sessionId: string
}

type LspHostOptions = {
  readonly homeDir: string
  readonly allowedRoots: readonly string[]
  readonly onLifecycle?: (event: LspLifecycleEvent) => void
  readonly watchConfig?: boolean
  readonly restartBaseDelayMs?: number
}

function connectionKey(
  serverId: string,
  projectRootUri: string,
  processCwdUri?: string,
): string {
  return `${serverId}\0${projectRootUri}\0${processCwdUri ?? ""}`
}

function isWithinPath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function sameUnknown(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function commandPolicyChanged(
  previous: LanguageServerDefinition,
  next: LanguageServerDefinition,
): boolean {
  return !sameUnknown(
    {
      languages: previous.languages,
      commandCandidates: previous.commandCandidates,
      args: previous.args,
      environment: previous.environment,
      candidateArgs: previous.candidateArgs,
      rootMarkers: previous.rootMarkers,
      priority: previous.priority,
      initializationOptions: previous.initializationOptions,
      enabled: previous.enabled,
    },
    {
      languages: next.languages,
      commandCandidates: next.commandCandidates,
      args: next.args,
      environment: next.environment,
      candidateArgs: next.candidateArgs,
      rootMarkers: next.rootMarkers,
      priority: next.priority,
      initializationOptions: next.initializationOptions,
      enabled: next.enabled,
    },
  )
}

function routingPolicyChanged(
  previous: LanguageServerDefinition,
  next: LanguageServerDefinition,
): boolean {
  return !sameUnknown(
    {
      languages: previous.languages,
      rootMarkers: previous.rootMarkers,
      priority: previous.priority,
      enabled: previous.enabled,
    },
    {
      languages: next.languages,
      rootMarkers: next.rootMarkers,
      priority: next.priority,
      enabled: next.enabled,
    },
  )
}

/**
 * Host authority for catalog resolution and LSP process lifetime.
 * One instance belongs to one Effect Scope; no process/session state is global.
 */
export class LspHost {
  private catalog: LanguageServerCatalog
  private catalogVersion = 1
  private readonly bridge: LspBridge
  private readonly rootCache = new Map<string, string | null>()
  private readonly activeByKey = new Map<string, ActiveConnection>()
  private readonly activeBySession = new Map<string, ActiveConnection>()
  private readonly failedKeysBySession = new Map<string, string>()
  private readonly pendingStarts = new Map<string, Promise<LspStartResult>>()
  private readonly retryAttempts = new Map<string, number>()
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly retryResetTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly logEntries: LspLogEntry[] = []
  private readonly lifecycleListeners = new Set<(event: LspLifecycleEvent) => void>()
  private readonly watcher: LanguageServerConfigWatcher | null
  private disposed = false
  private rootProbeCount = 0

  private constructor(
    private readonly options: LspHostOptions,
    initialCatalog: LanguageServerCatalog,
  ) {
    this.catalog = initialCatalog
    this.bridge = new LspBridge({
      allowedRoots: options.allowedRoots,
      resolveDefinition: serverId => this.definition(serverId),
      onCrash: (id, stderr) => this.handleConnectionFailure(id, "crashed", stderr),
      onClientDisconnected: id => this.handleConnectionFailure(id, "disconnected"),
      onLog: (id, stream, message) => this.appendBridgeLog(id, stream, message),
    })
    this.watcher = options.watchConfig === false
      ? null
      : watchLanguageServerConfig(options.homeDir, () => {
          void this.reloadConfig()
        })
  }

  static async create(options: LspHostOptions): Promise<LspHost> {
    const loaded = await loadLanguageServerConfig(options.homeDir)
    const catalog = loaded.ok
      ? loaded.catalog
      : { definitions: builtinLanguageServerDefinitions(), scanRoots: [] }
    const host = new LspHost(options, catalog)
    if (!loaded.ok) {
      host.emitLifecycle(LspLifecycleEvent.make({
        kind: "configuration-invalid",
        timestamp: Date.now(),
        message: loaded.error,
      }))
    }
    return host
  }

  onLifecycle(listener: (event: LspLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener)
    return () => this.lifecycleListeners.delete(listener)
  }

  listDefinitions(): LanguageServerDefinition[] {
    return this.catalog.definitions.map(definition => LanguageServerDefinition.make({
      ...definition,
      // The browser needs selection metadata, never executable secrets.
      environment: {},
    }))
  }

  async resolve(request: LspResolveRequest): Promise<ResolvedLanguageServerTarget | null> {
    if (this.disposed || !request.fileUri.startsWith("file://")) return null
    const workspacePath = await assertAllowedPath(
      uriToPath(request.workspaceRootUri),
      [...this.options.allowedRoots],
    )
    const filePath = await assertAllowedPath(
      uriToPath(request.fileUri),
      [...this.options.allowedRoots],
    )
    if (request.processCwdUri) {
      await assertAllowedPath(
        uriToPath(request.processCwdUri),
        [...this.options.allowedRoots],
      )
    }
    if (!isWithinPath(filePath, workspacePath)) return null

    const candidates = this.catalog.definitions.filter(
      definition => definition.enabled && definition.languages.includes(request.languageId),
    )
    if (candidates.length === 0) return null

    const directory = path.dirname(filePath)
    let fallback: LanguageServerDefinition | null = null
    for (const definition of candidates) {
      fallback ??= definition
      const projectRootPath = await this.resolveProjectRoot(
        definition,
        directory,
        workspacePath,
      )
      if (!projectRootPath) continue
      return this.target(
        definition,
        pathToUri(projectRootPath),
        request.workspaceRootUri,
        request.processCwdUri,
      )
    }
    return fallback
      ? this.target(
          fallback,
          pathToUri(workspacePath),
          request.workspaceRootUri,
          request.processCwdUri,
        )
      : null
  }

  async start(target: ResolvedLanguageServerTarget): Promise<LspStartResult> {
    if (this.disposed) {
      return LspStartResult.make({
        id: "",
        transportUrl: "",
        target,
        error: "LSP host is disposed",
      })
    }
    const definition = this.definition(target.serverId)
    const effectiveTarget = definition?.enabled
      ? this.target(
          definition,
          target.projectRootUri,
          target.workspaceRootUri,
          target.processCwdUri,
        )
      : target
    const key = connectionKey(
      effectiveTarget.serverId,
      effectiveTarget.projectRootUri,
      effectiveTarget.processCwdUri,
    )
    const active = this.activeByKey.get(key)
    if (active) {
      return LspStartResult.make({
        id: active.sessionId,
        transportUrl: `/ws/lsp/${active.sessionId}`,
        target: active.target,
      })
    }
    const pending = this.pendingStarts.get(key)
    if (pending) return pending
    const starting = this.startConnection(key, effectiveTarget)
    this.pendingStarts.set(key, starting)
    try {
      return await starting
    } finally {
      if (this.pendingStarts.get(key) === starting) this.pendingStarts.delete(key)
    }
  }

  async stop(id: string): Promise<void> {
    const failedKey = this.failedKeysBySession.get(id)
    const active = this.activeBySession.get(id) ?? (failedKey ? this.activeByKey.get(failedKey) : undefined)
    const key = active?.key ?? failedKey
    if (key) {
      const timer = this.retryTimers.get(key)
      if (timer) clearTimeout(timer)
      this.retryTimers.delete(key)
      const resetTimer = this.retryResetTimers.get(key)
      if (resetTimer) clearTimeout(resetTimer)
      this.retryResetTimers.delete(key)
      this.retryAttempts.delete(key)
    }
    this.failedKeysBySession.delete(id)
    if (active) this.removeActive(active)
    await this.bridge.stop(active?.sessionId ?? id)
    if (active) {
      this.emitLifecycle(LspLifecycleEvent.make({
        kind: "stopped",
        timestamp: Date.now(),
        serverId: active.target.serverId,
        projectRootUri: active.target.projectRootUri,
        sessionId: active.sessionId,
      }))
    }
  }

  logs(request: LspLogRequest = LspLogRequest.make({})): LspLogEntry[] {
    const limit = Math.max(0, Math.min(request.limit ?? 200, MAX_LOG_ENTRIES))
    const filtered = this.logEntries.filter(entry =>
      (request.serverId == null || entry.serverId === request.serverId) &&
      (request.projectRootUri == null || entry.projectRootUri === request.projectRootUri),
    )
    return filtered.slice(Math.max(0, filtered.length - limit))
  }

  getSession(id: string): LspSession | undefined {
    return this.bridge.getSession(id)
  }

  invalidateForFile(fileUri: string): void {
    if (!fileUri.startsWith("file://")) return
    const normalized = uriToPath(fileUri).replace(/\\/g, "/")
    const isRootMarker = this.catalog.definitions.some(definition =>
      definition.rootMarkers.some(marker =>
        normalized === marker || normalized.endsWith(`/${marker.replace(/\\/g, "/")}`),
      ),
    )
    if (isRootMarker) this.rootCache.clear()
  }

  diagnosticsForTests(): { readonly rootProbeCount: number; readonly rootCacheSize: number } {
    return { rootProbeCount: this.rootProbeCount, rootCacheSize: this.rootCache.size }
  }

  async reloadConfig(): Promise<void> {
    if (this.disposed) return
    const loaded = await loadLanguageServerConfig(this.options.homeDir)
    if (!loaded.ok) {
      this.emitLifecycle(LspLifecycleEvent.make({
        kind: "configuration-invalid",
        timestamp: Date.now(),
        message: loaded.error,
      }))
      return
    }

    const previousById = new Map(this.catalog.definitions.map(definition => [definition.id, definition]))
    const nextById = new Map(loaded.catalog.definitions.map(definition => [definition.id, definition]))
    const restartIds = new Set<string>()
    const rerouteIds = new Set<string>()
    const rerouteLanguages = new Set<string>()
    const settingsIds = new Set<string>()
    for (const id of new Set([...previousById.keys(), ...nextById.keys()])) {
      const previous = previousById.get(id)
      const next = nextById.get(id)
      if (!previous || !next || commandPolicyChanged(previous, next)) {
        restartIds.add(id)
        if (!previous || !next || routingPolicyChanged(previous, next)) {
          rerouteIds.add(id)
          for (const language of previous?.languages ?? []) rerouteLanguages.add(language)
          for (const language of next?.languages ?? []) rerouteLanguages.add(language)
        }
      } else if (!sameUnknown(previous.settings, next.settings)) {
        settingsIds.add(id)
      }
    }

    this.catalog = loaded.catalog
    this.catalogVersion += 1
    this.rootCache.clear()

    for (const serverId of settingsIds) {
      const definition = nextById.get(serverId)
      if (definition) {
        for (const active of [...this.activeByKey.values()]) {
          if (active.target.serverId !== serverId) continue
          const updated: ActiveConnection = {
            ...active,
            target: this.target(
              definition,
              active.target.projectRootUri,
              active.target.workspaceRootUri,
              active.target.processCwdUri,
            ),
          }
          this.activeByKey.set(active.key, updated)
          this.activeBySession.set(active.sessionId, updated)
        }
      }
      this.emitLifecycle(LspLifecycleEvent.make({
        kind: "configuration-changed",
        timestamp: Date.now(),
        serverId,
        settingsOnly: true,
        settings: nextById.get(serverId)?.settings,
      }))
    }
    const activeToRestart = [...this.activeByKey.values()].filter(active =>
      restartIds.has(active.target.serverId) ||
      active.target.languageIds.some(language => rerouteLanguages.has(language)),
    )
    for (const active of activeToRestart) {
      await this.stop(active.sessionId)
      const definition = this.definition(active.target.serverId)
      const needsReroute =
        rerouteIds.has(active.target.serverId) ||
        active.target.languageIds.some(language => rerouteLanguages.has(language))
      if (!definition?.enabled || needsReroute) continue
      const target = this.target(
        definition,
        active.target.projectRootUri,
        active.target.workspaceRootUri,
        active.target.processCwdUri,
      )
      this.retryAttempts.delete(active.key)
      this.scheduleRestart(target, 0)
    }
    if (restartIds.size > 0) {
      this.emitLifecycle(LspLifecycleEvent.make({
        kind: "configuration-changed",
        timestamp: Date.now(),
        message: [...restartIds].sort().join(", "),
        settingsOnly: false,
      }))
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.watcher?.close()
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    for (const timer of this.retryResetTimers.values()) clearTimeout(timer)
    this.retryResetTimers.clear()
    this.pendingStarts.clear()
    this.bridge.stopAll()
    this.activeByKey.clear()
    this.activeBySession.clear()
    this.failedKeysBySession.clear()
    this.lifecycleListeners.clear()
    this.rootCache.clear()
  }

  private definition(serverId: string): LanguageServerDefinition | undefined {
    return this.catalog.definitions.find(definition => definition.id === serverId)
  }

  private target(
    definition: LanguageServerDefinition,
    projectRootUri: string,
    workspaceRootUri: string,
    processCwdUri?: string,
  ): ResolvedLanguageServerTarget {
    return ResolvedLanguageServerTarget.make({
      serverId: definition.id,
      projectRootUri,
      workspaceRootUri,
      ...(processCwdUri ? { processCwdUri } : {}),
      languageIds: definition.languages,
      initializationOptions: definition.initializationOptions,
      settings: definition.settings,
      catalogVersion: this.catalogVersion,
    })
  }

  private async resolveProjectRoot(
    definition: LanguageServerDefinition,
    directory: string,
    workspacePath: string,
  ): Promise<string | null> {
    if (definition.rootMarkers.length === 0) return workspacePath
    const cacheKey = `${this.catalogVersion}\0${definition.id}\0${workspacePath}\0${directory}`
    if (this.rootCache.has(cacheKey)) return this.rootCache.get(cacheKey) ?? null
    this.rootProbeCount += 1
    for (const marker of definition.rootMarkers) {
      let current = directory
      while (isWithinPath(current, workspacePath)) {
        try {
          await fs.promises.stat(path.join(current, marker))
          this.rootCache.set(cacheKey, current)
          return current
        } catch {
          /* expected marker miss */
        }
        if (current === workspacePath) break
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
      }
    }
    this.rootCache.set(cacheKey, null)
    return null
  }

  private async startConnection(
    key: string,
    target: ResolvedLanguageServerTarget,
  ): Promise<LspStartResult> {
    const definition = this.definition(target.serverId)
    if (!definition?.enabled) {
      return LspStartResult.make({
        id: "",
        transportUrl: "",
        target,
        error: `Unknown language server: ${target.serverId}`,
      })
    }
    this.emitLifecycle(LspLifecycleEvent.make({
      kind: "starting",
      timestamp: Date.now(),
      serverId: target.serverId,
      projectRootUri: target.projectRootUri,
      target,
    }))
    const started = await this.bridge.start({
      rootUri: target.processCwdUri ?? target.projectRootUri,
      serverId: target.serverId,
      definition,
    })
    if (started.error) {
      return LspStartResult.make({
        id: "",
        transportUrl: "",
        target,
        error: started.error,
      })
    }
    const active: ActiveConnection = { key, target, sessionId: started.id }
    this.activeByKey.set(key, active)
    this.activeBySession.set(started.id, active)
    for (const [failedId, failedKey] of this.failedKeysBySession) {
      if (failedKey === key) this.failedKeysBySession.delete(failedId)
    }
    if (this.retryAttempts.has(key)) {
      const previousReset = this.retryResetTimers.get(key)
      if (previousReset) clearTimeout(previousReset)
      this.retryResetTimers.set(key, setTimeout(() => {
        this.retryResetTimers.delete(key)
        if (this.activeByKey.has(key)) this.retryAttempts.delete(key)
      }, RESTART_STABLE_RESET_MS))
    }
    const result = LspStartResult.make({
      id: started.id,
      transportUrl: `/ws/lsp/${started.id}`,
      target,
    })
    this.emitLifecycle(LspLifecycleEvent.make({
      kind: "ready",
      timestamp: Date.now(),
      serverId: target.serverId,
      projectRootUri: target.projectRootUri,
      sessionId: started.id,
      transportUrl: result.transportUrl,
      target,
    }))
    return result
  }

  private appendBridgeLog(id: string, stream: "host" | "stderr", message: string): void {
    const session = this.bridge.getSession(id)
    if (!session) return
    const trimmed = message.trim()
    if (!trimmed) return
    this.logEntries.push(LspLogEntry.make({
      timestamp: Date.now(),
      level: stream === "stderr" ? "warning" : "info",
      stream,
      serverId: session.serverId,
      projectRootUri: session.rootUri,
      sessionId: id,
      message: trimmed,
    }))
    if (this.logEntries.length > MAX_LOG_ENTRIES) {
      this.logEntries.splice(0, this.logEntries.length - MAX_LOG_ENTRIES)
    }
  }

  private handleConnectionFailure(
    id: string,
    reason: "crashed" | "disconnected",
    message?: string,
  ): void {
    const active = this.activeBySession.get(id)
    if (!active || this.disposed) return
    const resetTimer = this.retryResetTimers.get(active.key)
    if (resetTimer) clearTimeout(resetTimer)
    this.retryResetTimers.delete(active.key)
    this.removeActive(active)
    this.failedKeysBySession.set(id, active.key)
    if (reason === "disconnected") void this.bridge.stop(id)
    this.emitLifecycle(LspLifecycleEvent.make({
      kind: "crashed",
      timestamp: Date.now(),
      serverId: active.target.serverId,
      projectRootUri: active.target.projectRootUri,
      sessionId: id,
      message: message || "LSP WebSocket disconnected",
      target: active.target,
    }))
    this.scheduleRestart(active.target)
  }

  private scheduleRestart(target: ResolvedLanguageServerTarget, explicitDelay?: number): void {
    const key = connectionKey(
      target.serverId,
      target.projectRootUri,
      target.processCwdUri,
    )
    if (this.disposed || this.retryTimers.has(key)) return
    const attempt = (this.retryAttempts.get(key) ?? 0) + 1
    if (attempt > MAX_RESTART_ATTEMPTS) return
    this.retryAttempts.set(key, attempt)
    const delay = explicitDelay ?? (this.options.restartBaseDelayMs ?? RESTART_BASE_DELAY_MS) * 2 ** (attempt - 1)
    this.emitLifecycle(LspLifecycleEvent.make({
      kind: "restarting",
      timestamp: Date.now(),
      serverId: target.serverId,
      projectRootUri: target.projectRootUri,
      attempt,
      target,
    }))
    const timer = setTimeout(() => {
      this.retryTimers.delete(key)
      if (this.disposed || this.activeByKey.has(key)) return
      void this.start(target).then(result => {
        if (result.error) this.scheduleRestart(target)
      })
    }, delay)
    this.retryTimers.set(key, timer)
  }

  private removeActive(active: ActiveConnection): void {
    if (this.activeByKey.get(active.key)?.sessionId === active.sessionId) {
      this.activeByKey.delete(active.key)
    }
    this.activeBySession.delete(active.sessionId)
  }

  private emitLifecycle(event: LspLifecycleEvent): void {
    this.options.onLifecycle?.(event)
    for (const listener of this.lifecycleListeners) listener(event)
  }
}

export function makeLspHostScoped(
  options: LspHostOptions,
): Effect.Effect<LspHost, never, import("effect/Scope").Scope> {
  return Effect.acquireRelease(
    Effect.promise(() => LspHost.create(options)),
    host => Effect.sync(() => host.dispose()),
  )
}

export type { LspHostOptions }
