import os from "node:os"
import { randomUUID } from "node:crypto"
import type { TerminalHost } from "@yaade/node-host"
import type { RuntimeSnapshot, ServerIdentity } from "@yaade/rpc"
import type { HostConfig } from "./config.js"
import type { EventHub } from "./events.js"
import type { RuntimeDatabase } from "./runtime-database.js"
import { TerminalLeaseService } from "./terminal-leases.js"
import { DeviceAuthService } from "./device-auth.js"
import { MuxSessionStore } from "./mux-store.js"
import { TerminalService, type TerminalServiceDependencies } from "./terminal-runtime/service.js"
import type { ProcessDriverDependencies } from "./terminal-runtime/process-driver.js"

export type RuntimeTerminal = TerminalHost

export type HostRuntime = {
  config: HostConfig
  identity: ServerIdentity
  events: EventHub
  db: RuntimeDatabase
  terminal: RuntimeTerminal
  homeDir: string
  machineHostname: string
  leases: TerminalLeaseService
  devices: DeviceAuthService
  muxSessions: MuxSessionStore
  terminalExecution: ProcessDriverDependencies
  terminalService: TerminalService
  reconcileTimer: ReturnType<typeof setInterval>
}

export function createRuntime(
  config: HostConfig,
  events: EventHub,
  db: RuntimeDatabase,
  terminal: RuntimeTerminal,
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
  const leases = new TerminalLeaseService()
  const devices = new DeviceAuthService(db.session())
  const muxSessions = new MuxSessionStore(db.session(), os.hostname())
  const terminalExecution: ProcessDriverDependencies = { config, terminal }
  const dependencies: TerminalServiceDependencies = {
    config,
    db,
    homeDir,
    events,
    muxSessions,
    process: terminalExecution,
  }
  const terminalService = new TerminalService(dependencies)
  const reconcileTimer = setInterval(() => terminalService.reconcile(), 15_000)
  reconcileTimer.unref?.()

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
    leases,
    devices,
    muxSessions,
    terminalExecution,
    terminalService,
    reconcileTimer,
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
    leases: runtime.leases.listAll(),
  }
}

export function discardPersistedSessions(runtime: HostRuntime): void {
  runtime.muxSessions.reset()
}

export async function shutdownRuntime(runtime: HostRuntime): Promise<void> {
  runtime.events.emit("server:shuttingDown", [])
  clearInterval(runtime.reconcileTimer)
  await runtime.terminalService.close()
  runtime.terminal.stopAll()
}
