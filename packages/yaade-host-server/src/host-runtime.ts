import os from "node:os"
import { randomUUID } from "node:crypto"
import type { TerminalHost } from "@yaade/node-host"
import type { RuntimeSnapshot, ServerIdentity } from "@yaade/rpc"
import type { HostConfig } from "./config.js"
import type { EventHub } from "./events.js"
import type { RuntimeDatabase } from "./runtime-database.js"
import { DeviceAuthService } from "./device-auth.js"
import { MuxSessionStore } from "./mux-store.js"
import { TerminalService } from "./terminal-runtime/service.js"

export type HostRuntime = {
  config: HostConfig
  identity: ServerIdentity
  events: EventHub
  db: RuntimeDatabase
  terminal: TerminalHost
  homeDir: string
  machineHostname: string
  devices: DeviceAuthService
  muxSessions: MuxSessionStore
  terminalService: TerminalService
}

export function createRuntime(
  config: HostConfig,
  events: EventHub,
  db: RuntimeDatabase,
  terminal: TerminalHost,
  options?: { readonly identity?: ServerIdentity },
): HostRuntime {
  const identity = options?.identity ?? {
    serverId: db.serverId(),
    serverEpoch: randomUUID(),
    protocolVersion: 2 as const,
    runtimeVersion: "0.0.1",
    startedAt: new Date().toISOString(),
  }
  const homeDir = process.env.HOME ?? config.allowedRoots[0] ?? ""
  const devices = new DeviceAuthService(db.session())
  const muxSessions = new MuxSessionStore(db.session(), os.hostname())
  const terminalService = new TerminalService({
    config,
    events,
    muxSessions,
    terminal,
  })

  terminal.setEmit((channel, args) => {
    events.emit(channel, args)
    if (channel !== "terminal:exit") return
    const ptyId = String(args[0] ?? "")
    const exitCode = typeof args[1] === "number" ? args[1] : Number(args[1] ?? 0)
    terminalService.onProcessExit(ptyId, exitCode)
  })

  return {
    config,
    identity,
    events,
    db,
    terminal,
    homeDir,
    machineHostname: os.hostname(),
    devices,
    muxSessions,
    terminalService,
  }
}

export function buildRuntimeSnapshot(runtime: HostRuntime): RuntimeSnapshot {
  return {
    type: "runtime:snapshot",
    schemaVersion: 1,
    identity: runtime.identity,
    cursor: {
      serverEpoch: runtime.identity.serverEpoch,
      sequence: runtime.events.lastSequence,
    },
    generatedAt: new Date().toISOString(),
    sessions: runtime.muxSessions.listSessions(false).map(session => ({
      session,
      tabs: runtime.muxSessions.listTabs(session.id),
      muxTerminals: runtime.muxSessions.listMuxTerminals(session.id),
    })),
    leases: runtime.terminal.listAllLeases(),
  }
}

export function discardPersistedSessions(runtime: HostRuntime): void {
  runtime.muxSessions.reset()
}

export async function shutdownRuntime(runtime: HostRuntime): Promise<void> {
  runtime.events.emit("server:shuttingDown", [])
  await runtime.terminalService.close()
  runtime.terminal.stopAll()
}
