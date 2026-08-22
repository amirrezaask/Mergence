import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Layer } from "effect"
import { makeTerminalHostScoped, TerminalHost } from "@yaade/node-host"
import type { ServerIdentity } from "@yaade/rpc"
import type { HostConfig } from "../config.js"
import { EventHub } from "../events.js"
import { createRuntime, discardPersistedSessions, type HostRuntime } from "../host-runtime.js"
import { RuntimeDatabase } from "../runtime-database.js"
import {
  EventHubTag,
  HomeDirTag,
  HostConfigTag,
  HostRuntimeTag,
  RuntimeDatabaseTag,
  MuxSessionStoreTag,
  TerminalServiceTag,
  TerminalHostTag,
} from "./tags.js"

const EVENT_HUB_CAPACITY = 1024

export type HostLayerServices = HostRuntimeTag | MuxSessionStoreTag | TerminalServiceTag

export function makeRuntimeDatabaseScoped(
  dbPath: string,
): Effect.Effect<RuntimeDatabase, never, import("effect/Scope").Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => new RuntimeDatabase(dbPath)),
    db => Effect.sync(() => db.close()),
  )
}

export function makeHostLayers(
  config: HostConfig,
  options?: { eventHubCapacity?: number },
): Layer.Layer<HostLayerServices> {
  const runtimeLayer = Layer.scoped(
    HostRuntimeTag,
    Effect.gen(function* () {
      const db = yield* makeRuntimeDatabaseScoped(path.join(config.dataDir, "yaade.sqlite3"))
      const identity: ServerIdentity = {
        serverId: db.serverId(),
        serverEpoch: randomUUID(),
        protocolVersion: 2,
        runtimeVersion: "0.0.1",
        startedAt: new Date().toISOString(),
      }
      const events = new EventHub(options?.eventHubCapacity ?? EVENT_HUB_CAPACITY, 16 * 1024 * 1024, identity)
      const terminal = yield* makeTerminalHostScoped
      const runtime = createRuntime(config, events, db, terminal, { identity })
      discardPersistedSessions(runtime)
      return runtime
    }),
  )
  const muxStore = Layer.effect(
    MuxSessionStoreTag,
    Effect.map(HostRuntimeTag, runtime => runtime.muxSessions),
  )
  const terminalService = Layer.effect(
    TerminalServiceTag,
    Effect.map(HostRuntimeTag, runtime => runtime.terminalService),
  )
  return Layer.provideMerge(Layer.provideMerge(runtimeLayer)(muxStore))(terminalService)
}

export function hostRuntimeLayer(runtime: HostRuntime): Layer.Layer<HostLayerServices> {
  return Layer.mergeAll(
    Layer.succeed(HostConfigTag, runtime.config),
    Layer.succeed(EventHubTag, runtime.events),
    Layer.succeed(RuntimeDatabaseTag, runtime.db),
    Layer.succeed(TerminalHostTag, runtime.terminal),
    Layer.succeed(MuxSessionStoreTag, runtime.muxSessions),
    Layer.succeed(TerminalServiceTag, runtime.terminalService),
    Layer.succeed(HomeDirTag, runtime.homeDir),
    Layer.succeed(HostRuntimeTag, runtime),
  )
}

export const EventHubLive = Layer.sync(EventHubTag, () => new EventHub(EVENT_HUB_CAPACITY))

export function RuntimeDatabaseLive(config: HostConfig): Layer.Layer<RuntimeDatabaseTag> {
  return Layer.scoped(RuntimeDatabaseTag, makeRuntimeDatabaseScoped(path.join(config.dataDir, "yaade.sqlite3")))
}

export function HomeDirLive(config: HostConfig): Layer.Layer<HomeDirTag> {
  return Layer.succeed(HomeDirTag, process.env.HOME ?? config.allowedRoots[0] ?? "")
}

export const TerminalHostLive = Layer.scoped(TerminalHostTag, makeTerminalHostScoped)
export const TerminalHostUnscopedLive = Layer.sync(TerminalHostTag, () => new TerminalHost())
