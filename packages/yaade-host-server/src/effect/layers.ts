import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Layer } from "effect"
import { makeTerminalHostScoped } from "@yaade/node-host"
import type { ServerIdentity } from "@yaade/rpc"
import type { HostConfig } from "../config.js"
import { EventHub } from "../events.js"
import { createRuntime, discardPersistedSessions } from "../host-runtime.js"
import { RuntimeDatabase } from "../runtime-database.js"
import { HostRuntimeTag } from "./tags.js"

const EVENT_HUB_CAPACITY = 1024

export type HostLayerServices = HostRuntimeTag

function makeRuntimeDatabaseScoped(
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
  return Layer.scoped(
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
      const events = new EventHub(
        options?.eventHubCapacity ?? EVENT_HUB_CAPACITY,
        16 * 1024 * 1024,
        identity,
      )
      const terminal = yield* makeTerminalHostScoped
      const runtime = createRuntime(config, events, db, terminal, { identity })
      discardPersistedSessions(runtime)
      return runtime
    }),
  )
}
