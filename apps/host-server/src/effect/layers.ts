import path from "node:path"
import { Effect, Layer, PubSub, Stream } from "effect"
import { makeLspHostScoped, makeTerminalHostScoped, PerfHost, TerminalHost } from "@yaade/node-host"
import type { NotificationStreamEvent } from "@yaade/shared"
import type { HostConfig } from "../config.js"
import { EventHub } from "../events.js"
import { createRuntime, type HostRuntime } from "../host-runtime.js"
import { NotificationService } from "../notifications/index.js"
import { ProjectDatabase } from "../persistence.js"
import { WorkspaceHost } from "../workspace.js"
import { GitServiceLive, GitServiceTag } from "./git.js"
import {
  EventHubTag,
  HomeDirTag,
  HostConfigTag,
  HostRuntimeTag,
  LspHostTag,
  NotificationEventPubSub,
  NotificationServiceTag,
  PerfHostTag,
  ProjectDatabaseTag,
  TerminalHostTag,
  WorkspaceHostTag,
} from "./tags.js"

const EVENT_HUB_CAPACITY = 1024

export type HostLayerServices = HostRuntimeTag | LspHostTag | GitServiceTag

/** Open SQLite project DB for the lifetime of an Effect Scope. */
export function makeProjectDatabaseScoped(
  dbPath: string,
): Effect.Effect<ProjectDatabase, never, import("effect/Scope").Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => new ProjectDatabase(dbPath)),
    db => Effect.sync(() => db.close()),
  )
}

/**
 * Host services Layer.
 * - TerminalHost via {@link makeTerminalHostScoped}
 * - ProjectDatabase via {@link makeProjectDatabaseScoped}
 * - Notification events via PubSub → Stream bridge → EventHub
 * - GitService thin Effect facade over node-host git helpers
 */
export function makeHostLayers(
  config: HostConfig,
  options?: { eventHubCapacity?: number },
): Layer.Layer<HostLayerServices> {
  const runtimeLayer = Layer.scoped(
    HostRuntimeTag,
    Effect.gen(function* () {
      const events = new EventHub(options?.eventHubCapacity ?? EVENT_HUB_CAPACITY)
      const db = yield* makeProjectDatabaseScoped(path.join(config.dataDir, "jet.sqlite3"))
      const terminal = yield* makeTerminalHostScoped
      const homeDir = process.env.HOME ?? config.allowedRoots[0] ?? ""
      const lsp = yield* makeLspHostScoped({
        homeDir,
        allowedRoots: config.allowedRoots,
        onLifecycle: event => {
          events.emit("lsp:lifecycle", [event])
          if (event.kind === "crashed" && event.sessionId) {
            events.emit("lsp:crashed", [event.sessionId])
          }
        },
      })
      const unsubscribeLspInvalidation = events.subscribe(event => {
        if (event.channel === "fs:changed" && typeof event.args[0] === "string") {
          lsp.invalidateForFile(event.args[0])
        }
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribeLspInvalidation))

      // Sliding: drop oldest under notification burst instead of unbounded growth.
      const pubsub = yield* Effect.acquireRelease(
        PubSub.sliding<NotificationStreamEvent>(1024),
        hub => PubSub.shutdown(hub),
      )

      yield* Stream.fromPubSub(pubsub).pipe(
        Stream.runForEach(event =>
          Effect.sync(() => {
            events.emit("notifications:event", [event])
          }),
        ),
        Effect.forkScoped,
      )

      const runtime = createRuntime(config, events, db, terminal, lsp, {
        emitNotification: event => {
          Effect.runSync(PubSub.publish(pubsub, event))
        },
      })
      return runtime
    }),
  )

  const lspFromRuntime = Layer.effect(
    LspHostTag,
    Effect.map(HostRuntimeTag, runtime => runtime.lsp),
  )
  const runtimeWithLsp = Layer.provideMerge(runtimeLayer)(lspFromRuntime)
  return Layer.mergeAll(runtimeWithLsp, GitServiceLive)
}

/** Layer from an existing HostRuntime (e.g. tests — caller owns terminal/db lifetime). */
export function hostRuntimeLayer(runtime: HostRuntime): Layer.Layer<HostLayerServices> {
  return Layer.mergeAll(
    Layer.succeed(HostConfigTag, runtime.config),
    Layer.succeed(EventHubTag, runtime.events),
    Layer.succeed(ProjectDatabaseTag, runtime.db),
    Layer.succeed(NotificationServiceTag, runtime.notifications),
    Layer.succeed(TerminalHostTag, runtime.terminal),
    Layer.succeed(WorkspaceHostTag, runtime.workspace),
    Layer.succeed(PerfHostTag, runtime.perf),
    Layer.succeed(LspHostTag, runtime.lsp),
    Layer.succeed(HomeDirTag, runtime.homeDir),
    Layer.succeed(HostRuntimeTag, runtime),
    GitServiceLive,
  )
}

/** Standalone layers for incremental wiring. */
export const EventHubLive = Layer.sync(EventHubTag, () => new EventHub(EVENT_HUB_CAPACITY))

export function ProjectDatabaseLive(config: HostConfig): Layer.Layer<ProjectDatabaseTag> {
  return Layer.scoped(
    ProjectDatabaseTag,
    makeProjectDatabaseScoped(path.join(config.dataDir, "jet.sqlite3")),
  )
}

export function NotificationServiceLive(
  db: ProjectDatabase,
  events: EventHub,
): Layer.Layer<NotificationServiceTag> {
  return Layer.sync(
    NotificationServiceTag,
    () =>
      new NotificationService(db.raw(), (streamEvent: NotificationStreamEvent) => {
        events.emit("notifications:event", [streamEvent])
      }),
  )
}

/** PubSub fan-out for notification stream events (tests / custom bridges). */
export const NotificationEventPubSubLive = Layer.scoped(
  NotificationEventPubSub,
  Effect.acquireRelease(
    PubSub.sliding<NotificationStreamEvent>(1024),
    hub => PubSub.shutdown(hub),
  ),
)

export const WorkspaceHostLive = Layer.sync(WorkspaceHostTag, () => new WorkspaceHost())

export function PerfHostLive(homeDir: string): Layer.Layer<PerfHostTag> {
  return Layer.sync(PerfHostTag, () => new PerfHost(homeDir, Date.now()))
}

export function HomeDirLive(config: HostConfig): Layer.Layer<HomeDirTag> {
  const homeDir = process.env.HOME ?? config.allowedRoots[0] ?? ""
  return Layer.succeed(HomeDirTag, homeDir)
}

/** Scoped TerminalHost — prefer {@link makeHostLayers} for full host boot. */
export const TerminalHostLive = Layer.scoped(TerminalHostTag, makeTerminalHostScoped)

/** Test helper: unsoped TerminalHost (caller must stopAll). */
export const TerminalHostUnscopedLive = Layer.sync(TerminalHostTag, () => new TerminalHost())

export { GitServiceLive, GitServiceTag }
