import { randomUUID } from "node:crypto"
import {
  ensureTerminalSupervisor,
  ensureTerminalSupervisorGeneration,
  type SupervisorManifest,
} from "./terminal-supervisor.js"
import {
  SupervisedTerminalHost,
  type SupervisorConnectionState,
} from "./terminal-supervisor-client.js"
import type {
  TerminalAttachSnapshot,
  TerminalCreateResult,
  TerminalInspectSnapshot,
  TerminalLaunch,
} from "./terminal.js"
import {
  runtimeProcessIsAlive,
  TerminalRuntimeRegistry,
  type TerminalRuntimeManifest,
} from "./terminal-runtime-registry.js"
import {
  TerminalRuntimeRouter,
  type RuntimeConnection,
} from "./terminal-runtime-router.js"
import type { RuntimeCapabilities } from "./terminal-protocol/schema.js"
import type { TerminalMutationFence } from "./terminal-control.js"

export type MultiGenerationRuntimeOptions = {
  readonly runtimeVersion?: string
  readonly ensureCurrentGeneration?: boolean
  readonly requiredProtocol?: number
  readonly requiredCapabilities?: Partial<RuntimeCapabilities>
}

type Owner = RuntimeConnection<SupervisedTerminalHost>

type StateListener = (state: SupervisorConnectionState) => void

type EmitFn = (channel: string, args: unknown[]) => void

function runtimeSupportsCapabilities(
  actual: RuntimeCapabilities,
  required: RuntimeCapabilities,
): boolean {
  return (
    (!required.semanticTerminalState || actual.semanticTerminalState) &&
    (!required.authoritativeLeases || actual.authoritativeLeases) &&
    (!required.structuredInput || actual.structuredInput) &&
    (!required.historyPaging || actual.historyPaging) &&
    (!required.subscriptions || actual.subscriptions) &&
    (!required.draining || actual.draining)
  )
}

function fallbackLegacyManifest(
  socketPath: string,
  manifest: SupervisorManifest | null,
): TerminalRuntimeManifest {
  const supervisorId = manifest?.supervisorId ?? "unmanaged"
  const ownerId = `legacy-${supervisorId.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 96) || "unknown"}`
  return {
    schemaVersion: 2,
    ownerId,
    ownerEpoch: manifest?.supervisorEpoch ?? `legacy:${socketPath}`,
    runtimeVersion: "legacy",
    protocolMin: 1,
    protocolMax: 1,
    state: "active",
    pid: manifest?.pid ?? 0,
    processIdentity: manifest?.processIdentity ?? null,
    socketPath,
    startedAt: manifest?.startedAt ?? new Date().toISOString(),
    capabilities: {
      semanticTerminalState: false,
      authoritativeLeases: false,
      structuredInput: false,
      historyPaging: false,
      subscriptions: false,
      draining: false,
    },
  }
}

/**
 * Host-facing terminal facade over several detached supervisor generations.
 * Existing terminal IDs are routed to their discovered owner; creates select
 * the newest compatible active owner. Disconnecting this facade never stops a
 * child process.
 */
export class MultiGenerationTerminalHost {
  private readonly dataDir: string
  private readonly options: MultiGenerationRuntimeOptions
  private readonly registry: TerminalRuntimeRegistry
  private readonly router = new TerminalRuntimeRouter<SupervisedTerminalHost>()
  private readonly owners = new Map<string, Owner>()
  private readonly localByExternal = new Map<string, string>()
  private readonly externalByOwnerAndLocal = new Map<string, string>()
  private readonly stateListeners = new Set<StateListener>()
  private emit: EmitFn = () => {}
  private state: SupervisorConnectionState = "connecting"
  private terminalOwnerLossTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  private constructor(dataDir: string, options: MultiGenerationRuntimeOptions) {
    this.dataDir = dataDir
    this.options = options
    this.registry = new TerminalRuntimeRegistry(dataDir)
  }

  static async connect(
    dataDir: string,
    options: MultiGenerationRuntimeOptions = {},
  ): Promise<MultiGenerationTerminalHost> {
    const host = new MultiGenerationTerminalHost(dataDir, options)
    await host.connectDiscoveredOwners()
    if (host.owners.size === 0) {
      const ensured = await ensureTerminalSupervisor(dataDir)
      await host.connectDiscoveredOwners()
      // A pingable legacy supervisor may predate the manifest/registry. Keep
      // it usable instead of returning a host with no create owner.
      if (host.owners.size === 0) {
        await host.connectOwner(fallbackLegacyManifest(ensured.socketPath, ensured.manifest))
      }
    }
    if (options.ensureCurrentGeneration === true) {
      const generation = await ensureTerminalSupervisorGeneration(dataDir, {
        runtimeVersion: options.runtimeVersion,
        requiredProtocol: options.requiredProtocol ?? 1,
        requiredCapabilities: options.requiredCapabilities,
      })
      await host.connectOwner(generation.manifest)
    }
    host.updateState()
    return host
  }

  get connectionState(): SupervisorConnectionState {
    return this.state
  }

  get currentSupervisorEpoch(): string | null {
    const owners = [...this.owners.values()]
      .sort((left, right) => left.manifest.startedAt.localeCompare(right.manifest.startedAt))
    return owners.at(-1)?.manifest.ownerEpoch ?? null
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  setEmit(emit: EmitFn): void {
    this.emit = emit
  }

  async create(
    cwdUri: string,
    launch: TerminalLaunch | null | undefined,
    clientId: string,
    requestId?: string,
  ): Promise<TerminalCreateResult> {
    const owner = this.createOwner()
    if (!owner) throw new Error("SUPERVISOR_UNAVAILABLE")
    const result = await owner.runtime.create(cwdUri, launch, clientId, requestId)
    const externalId = this.externalId(owner.manifest, result.id)
    this.router.registerTerminal({
      id: externalId,
      ownerId: owner.manifest.ownerId,
      ownerEpoch: owner.manifest.ownerEpoch,
      terminalEpoch: result.terminalEpoch,
    })
    return { ...result, id: externalId, ownerId: owner.manifest.ownerId, ownerEpoch: owner.manifest.ownerEpoch, protocolVersion: owner.manifest.protocolMax }
  }

  write(id: string, data: string): Promise<null> {
    return this.route(id).runtime.write(this.localId(id), data)
  }

  writeBinary(id: string, dataBase64: string): Promise<null> {
    return this.route(id).runtime.writeBinary(this.localId(id), dataBase64)
  }

  resize(id: string, cols?: number, rows?: number): Promise<null> {
    return this.route(id).runtime.resize(this.localId(id), cols, rows)
  }

  acknowledgeData(id: string, chars: number, clientId?: string): Promise<null> {
    return this.route(id).runtime.acknowledgeData(this.localId(id), chars, clientId)
  }

  clearUnacknowledgedChars(id: string): Promise<null> {
    return this.route(id).runtime.clearUnacknowledgedChars(this.localId(id))
  }

  pauseForBackpressure(ids?: readonly string[]): Promise<null> {
    const targets = ids ? ids.map(id => this.route(id)) : [...this.owners.values()]
    return Promise.all(targets.map(target => target.runtime.pauseForBackpressure()))
      .then(() => null)
  }

  armLiveViewer(id: string, clientId: string): Promise<void> {
    const owner = this.routeOrNull(id)
    if (!owner) return Promise.resolve()
    return owner.runtime
      .armLiveViewer(this.localId(id), clientId)
      .catch(() => undefined)
  }

  resumeForClient(clientId: string): Promise<void> {
    return Promise.all([...this.owners.values()].map(owner => owner.runtime.resumeForClient(clientId)))
      .then(() => undefined)
  }

  resumeAllLiveViewers(): Promise<void> {
    return Promise.all([...this.owners.values()].map(owner => owner.runtime.resumeAllLiveViewers()))
      .then(() => undefined)
  }

  async attach(id: string, clientId: string, afterSequence?: number): Promise<TerminalAttachSnapshot | null> {
    const owner = this.route(id)
    const snapshot = await owner.runtime.attach(this.localId(id), clientId, afterSequence)
    if (snapshot) {
      this.router.registerTerminal({
        id,
        ownerId: owner.manifest.ownerId,
        ownerEpoch: owner.manifest.ownerEpoch,
        terminalEpoch: snapshot.terminalEpoch,
      })
    }
    return snapshot
      ? {
          ...snapshot,
          id,
          ownerId: owner.manifest.ownerId,
          ownerEpoch: owner.manifest.ownerEpoch,
          protocolVersion: owner.manifest.protocolMax,
        }
      : null
  }

  markReplayReady(id: string, clientId: string): Promise<null> {
    return this.route(id).runtime.markReplayReady(this.localId(id), clientId)
  }

  hasViewer(id: string, clientId: string): Promise<boolean> {
    return this.route(id).runtime.hasViewer(this.localId(id), clientId)
  }

  async readOutput(id: string, maxBytes?: number): Promise<{ output: string; truncated: boolean } | null> {
    return this.route(id).runtime.readOutput(this.localId(id), maxBytes)
  }

  async inspect(id: string): Promise<TerminalInspectSnapshot | null> {
    const owner = this.routeOrNull(id)
    if (!owner) return null
    const snapshot = await owner.runtime.inspect(this.localId(id))
    if (snapshot) {
      this.router.registerTerminal({
        id,
        ownerId: owner.manifest.ownerId,
        ownerEpoch: owner.manifest.ownerEpoch,
        terminalEpoch: snapshot.terminalEpoch ?? randomUUID(),
      })
    }
    return snapshot
      ? {
          ...snapshot,
          id,
          ownerId: owner.manifest.ownerId,
          ownerEpoch: owner.manifest.ownerEpoch,
          protocolVersion: owner.manifest.protocolMax,
        }
      : null
  }

  async listRunning(): Promise<TerminalInspectSnapshot[]> {
    const all: TerminalInspectSnapshot[] = []
    await Promise.all([...this.owners.values()].map(async owner => {
      try {
        const running = await owner.runtime.listRunning()
        for (const item of running) {
          const id = this.externalId(owner.manifest, item.id)
          this.router.registerTerminal({
            id,
            ownerId: owner.manifest.ownerId,
            ownerEpoch: owner.manifest.ownerEpoch,
            terminalEpoch: item.terminalEpoch ?? randomUUID(),
          })
          all.push({
            ...item,
            id,
            ownerId: owner.manifest.ownerId,
            ownerEpoch: owner.manifest.ownerEpoch,
            protocolVersion: owner.manifest.protocolMax,
          })
        }
      } catch {
        /* One old owner may be unavailable while other generations remain live. */
      }
    }))
    return all
  }

  getCwd(id: string): Promise<string | null> {
    return this.route(id).runtime.getCwd(this.localId(id))
  }

  getForegroundProcess(id: string, fresh = false): Promise<string | null> {
    return this.route(id).runtime.getForegroundProcess(this.localId(id), fresh)
  }

  waitForExit(id: string): Promise<{ exitCode: number | null; signal?: string }> {
    return this.route(id).runtime.waitForExit(this.localId(id))
  }

  async dispose(id: string): Promise<null> {
    const owner = this.route(id)
    const result = await owner.runtime.dispose(this.localId(id))
    this.forget(id, owner.manifest.ownerEpoch)
    return result
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.owners.values()].map(owner => owner.runtime.stopAll()))
  }

  async markDraining(ownerEpoch: string): Promise<boolean> {
    const owner = this.owners.get(ownerEpoch)
    if (!owner) return false
    const manifest = this.registry.updateState(owner.manifest.ownerId, ownerEpoch, "draining")
    if (!manifest) return false
    const next: Owner = { manifest, runtime: owner.runtime }
    this.owners.set(ownerEpoch, next)
    this.router.register(next)
    this.emit("runtime:draining", [ownerEpoch])
    return true
  }

  async shutdownWhenEmpty(ownerEpoch: string): Promise<boolean> {
    const owner = this.owners.get(ownerEpoch)
    if (!owner) return false
    const running = await owner.runtime.listRunning()
    if (running.length > 0) return false
    await owner.runtime.shutdownSupervisor()
    this.owners.delete(ownerEpoch)
    this.router.unregister(ownerEpoch)
    return true
  }

  async disconnect(): Promise<void> {
    this.closed = true
    this.setState("closed")
    if (this.terminalOwnerLossTimer) clearTimeout(this.terminalOwnerLossTimer)
    this.terminalOwnerLossTimer = null
    await Promise.all([...this.owners.values()].map(owner => owner.runtime.disconnect()))
  }

  async shutdownSupervisor(): Promise<void> {
    this.closed = true
    if (this.terminalOwnerLossTimer) clearTimeout(this.terminalOwnerLossTimer)
    this.terminalOwnerLossTimer = null
    await Promise.all([...this.owners.values()].map(owner => owner.runtime.shutdownSupervisor()))
    this.setState("closed")
  }

  acquireLease(
    id: string,
    terminalEpoch: string,
    principalId: string,
    connectionId: string,
    mode: "writer" | "observer",
  ) {
    return this.route(id).runtime.acquireLease(
      this.localId(id), terminalEpoch, principalId, connectionId, mode,
    ).then(lease => ({ ...lease, terminalId: id }))
  }

  renewLease(id: string, epoch: string, leaseId: string, principalId: string, connectionId: string) {
    return this.route(id).runtime.renewLease(
      this.localId(id), epoch, leaseId, principalId, connectionId,
    ).then(lease => ({ ...lease, terminalId: id }))
  }

  releaseLease(id: string, epoch: string, leaseId: string, principalId: string, connectionId: string) {
    return this.route(id).runtime.releaseLease(
      this.localId(id), epoch, leaseId, principalId, connectionId,
    )
  }

  async releaseConnection(connectionId: string): Promise<null> {
    await Promise.all([...this.owners.values()].map(owner => owner.runtime.releaseConnection(connectionId)))
    return null
  }

  forceTakeover(id: string, epoch: string, principalId: string, connectionId: string) {
    return this.route(id).runtime.forceTakeover(
      this.localId(id), epoch, principalId, connectionId,
    ).then(lease => ({ ...lease, terminalId: id }))
  }

  listLeases(id: string) {
    return this.route(id).runtime.listLeases(this.localId(id))
      .then(leases => leases.map(lease => ({ ...lease, terminalId: id })))
  }

  currentWriterLease(id: string) {
    return this.route(id).runtime.currentWriterLease(this.localId(id))
      .then(lease => lease ? { ...lease, terminalId: id } : null)
  }

  transferLease(
    id: string,
    epoch: string,
    leaseId: string,
    principalId: string,
    connectionId: string,
    targetPrincipalId: string,
    targetConnectionId: string,
  ) {
    return this.route(id).runtime.transferLease(
      this.localId(id),
      epoch,
      leaseId,
      principalId,
      connectionId,
      targetPrincipalId,
      targetConnectionId,
    ).then(lease => ({ ...lease, terminalId: id }))
  }

  writeFenced(id: string, data: string, fence: TerminalMutationFence) {
    return this.route(id).runtime.writeFenced(
      this.localId(id),
      data,
      { ...fence, terminalId: this.localId(id) },
    )
  }

  writeBinaryFenced(id: string, dataBase64: string, fence: TerminalMutationFence) {
    return this.route(id).runtime.writeBinaryFenced(
      this.localId(id),
      dataBase64,
      { ...fence, terminalId: this.localId(id) },
    )
  }

  resizeFenced(
    id: string,
    cols: number | undefined,
    rows: number | undefined,
    fence: TerminalMutationFence,
  ) {
    return this.route(id).runtime.resizeFenced(
      this.localId(id),
      cols,
      rows,
      { ...fence, terminalId: this.localId(id) },
    )
  }

  pasteFenced(id: string, data: string, fence: TerminalMutationFence) {
    return this.route(id).runtime.pasteFenced(
      this.localId(id),
      data,
      { ...fence, terminalId: this.localId(id) },
    )
  }

  focusFenced(id: string, focused: boolean, fence: TerminalMutationFence) {
    return this.route(id).runtime.focusFenced(
      this.localId(id),
      focused,
      { ...fence, terminalId: this.localId(id) },
    )
  }

  mouseFenced(
    id: string,
    input: import("@yaade/ghostty-core").GhosttyMouseInput,
    fence: TerminalMutationFence,
  ) {
    return this.route(id).runtime.mouseFenced(
      this.localId(id),
      input,
      { ...fence, terminalId: this.localId(id) },
    )
  }

  disposeFenced(id: string, fence: TerminalMutationFence) {
    return this.route(id).runtime.disposeFenced(
      this.localId(id),
      { ...fence, terminalId: this.localId(id) },
    )
  }

  readSemanticSnapshot(id: string) {
    return this.route(id).runtime.readSemanticSnapshot(this.localId(id))
  }

  readSemanticHistory(id: string, offset: number, limit: number) {
    return this.route(id).runtime.readSemanticHistory(this.localId(id), offset, limit)
  }

  authoritativeLeasesFor(id: string): boolean {
    return this.routeOrNull(id)?.manifest.capabilities.authoritativeLeases === true
  }

  private async connectDiscoveredOwners(): Promise<void> {
    this.registry.pruneStale()
    this.registry.rebuild()
    const manifests = this.registry.listManifests().filter(
      manifest => manifest.processIdentity === null || runtimeProcessIsAlive(manifest),
    )
    await Promise.all(manifests.map(manifest => this.connectOwner(manifest)))
  }

  private async connectOwner(manifest: TerminalRuntimeManifest): Promise<void> {
    if (this.owners.has(manifest.ownerEpoch)) return
    try {
      const runtime = await SupervisedTerminalHost.connectGeneration(this.dataDir, manifest.socketPath)
      if (
        manifest.runtimeVersion !== "legacy" &&
        manifest.protocolMax >= 2 &&
        (!runtime.negotiatedCapabilities ||
          !runtimeSupportsCapabilities(runtime.negotiatedCapabilities, manifest.capabilities))
      ) {
        await runtime.disconnect()
        return
      }
      const owner: Owner = { manifest, runtime }
      this.owners.set(manifest.ownerEpoch, owner)
      this.router.register(owner)
      runtime.setEmit((channel, args) => this.forwardEvent(manifest, channel, args))
      runtime.onState(() => this.updateState())
      await this.listRunningForOwner(owner)
    } catch {
      /* A stale or concurrently-draining owner is not a create target. */
    }
  }

  private async listRunningForOwner(owner: Owner): Promise<void> {
    try {
      const running = await owner.runtime.listRunning()
      for (const item of running) {
        const id = this.externalId(owner.manifest, item.id)
        this.router.registerTerminal({
          id,
          ownerId: owner.manifest.ownerId,
          ownerEpoch: owner.manifest.ownerEpoch,
          terminalEpoch: item.terminalEpoch ?? randomUUID(),
        })
      }
    } catch {
      /* State is reconciled again after the owner reconnects. */
    }
  }

  private createOwner(): Owner | null {
    const selected = this.router.chooseCreateOwner(
      this.options.requiredProtocol ?? 1,
      this.options.requiredCapabilities,
    )
    return selected ?? null
  }

  private route(id: string): Owner {
    const owner = this.routeOrNull(id)
    if (!owner) throw new Error(`SUPERVISOR_UNAVAILABLE: terminal owner not found: ${id}`)
    return owner
  }

  private routeOrNull(id: string): Owner | null {
    const routed = this.router.route(id)
    if (routed) return routed

    // Running-terminal reconciliation intentionally excludes exited entries,
    // but the owner keeps them attachable until its replay TTL expires. Newer
    // external IDs contain the owner ID, so recover the route lazily when a
    // persisted tab is reopened after the host reconnects.
    for (const owner of this.owners.values()) {
      const prefix = `pty-${owner.manifest.ownerId}-`
      if (!id.startsWith(prefix)) continue
      const localId = id.slice(prefix.length)
      if (!localId.startsWith("term-")) continue
      this.localByExternal.set(id, localId)
      this.externalByOwnerAndLocal.set(
        `${owner.manifest.ownerEpoch}\u0000${localId}`,
        id,
      )
      return owner
    }
    return null
  }

  private localId(externalId: string): string {
    const local = this.localByExternal.get(externalId)
    if (!local) throw new Error(`terminal owner not found: ${externalId}`)
    return local
  }

  private externalId(manifest: TerminalRuntimeManifest, localId: string): string {
    const key = `${manifest.ownerEpoch}\u0000${localId}`
    const existing = this.externalByOwnerAndLocal.get(key)
    if (existing) return existing
    const external = manifest.runtimeVersion === "legacy"
      ? localId
      : `pty-${manifest.ownerId}-${localId}`
    this.externalByOwnerAndLocal.set(key, external)
    this.localByExternal.set(external, localId)
    return external
  }

  private forget(externalId: string, ownerEpoch: string): void {
    const localId = this.localByExternal.get(externalId)
    this.localByExternal.delete(externalId)
    if (localId) this.externalByOwnerAndLocal.delete(`${ownerEpoch}\u0000${localId}`)
    this.router.unregisterTerminal(externalId)
  }

  private forwardEvent(
    manifest: TerminalRuntimeManifest,
    channel: string,
    args: unknown[],
  ): void {
    if (
      channel === "terminal:data" ||
      channel === "terminal:semantic" ||
      channel === "terminal:exit"
    ) {
      const localId = String(args[0] ?? "")
      const externalId = this.externalId(manifest, localId)
      // Semantic frames carry the owner epoch explicitly. The newest owner is
      // not necessarily the owner of an existing terminal during a drain.
      const forwarded = [externalId, ...args.slice(1)]
      if (channel === "terminal:semantic") forwarded.push(manifest.ownerEpoch)
      this.emit(channel, forwarded)
      return
    }
    this.emit(channel, args)
  }

  private updateState(): void {
    if (this.closed) {
      this.setState("closed")
      return
    }
    const owners = [...this.owners.values()]
    const states = owners.map(owner => owner.runtime.connectionState)
    const ownerProcessAlive = owners.some(owner => {
      if (owner.manifest.processIdentity === null) return true
      return runtimeProcessIsAlive(owner.manifest)
    })
    const terminalOwnerTransitioning = owners.some(
      owner =>
        this.router.ownerHasTerminals(owner.manifest.ownerEpoch) &&
        owner.runtime.connectionState !== "healthy",
    )
    if (terminalOwnerTransitioning && !this.terminalOwnerLossTimer) {
      this.terminalOwnerLossTimer = setTimeout(() => {
        this.terminalOwnerLossTimer = null
        this.updateState()
      }, 1_000)
      this.terminalOwnerLossTimer.unref?.()
    } else if (!terminalOwnerTransitioning && this.terminalOwnerLossTimer) {
      clearTimeout(this.terminalOwnerLossTimer)
      this.terminalOwnerLossTimer = null
    }
    const terminalOwnerLost = owners.some(
      owner =>
        this.router.ownerHasTerminals(owner.manifest.ownerEpoch) &&
        (owner.runtime.connectionState === "lost" || !runtimeProcessIsAlive(owner.manifest)),
    )
    const next = terminalOwnerLost
      ? "lost"
      : states.includes("healthy")
        ? "healthy"
      : states.includes("incompatible")
        ? "incompatible"
        : !ownerProcessAlive
          ? "lost"
          : states.some(state => state === "connecting" || state === "reconnecting" || state === "degraded")
            ? "degraded"
            : "lost"
    this.setState(next)
  }

  private setState(next: SupervisorConnectionState): void {
    if (this.state === next) return
    this.state = next
    for (const listener of this.stateListeners) listener(next)
  }
}
