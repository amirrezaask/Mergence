#!/usr/bin/env node
import fs from "node:fs"
import { listenTerminalSupervisor } from "./terminal-supervisor.js"
import {
  TerminalRuntimeRegistry,
  type TerminalRuntimeManifest,
} from "./terminal-runtime-registry.js"

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag)
  if (index < 0) return null
  return process.argv[index + 1] ?? null
}

const socketPath =
  argValue("--socket") ?? process.env.YAADE_PTY_SUPERVISOR_SOCKET
const pidPath = argValue("--pid-file")
const manifestPath = argValue("--manifest")
const ownerId = argValue("--owner-id")
const runtimeManifestPath = argValue("--runtime-manifest")
if (!socketPath) {
  console.error("pty-supervisor: --socket is required")
  process.exit(1)
}

if (pidPath) {
  fs.writeFileSync(pidPath, String(process.pid), "utf8")
}

let requestShutdown: (() => void) | null = null
const supervisorOptions: Parameters<typeof listenTerminalSupervisor>[1] = {
  onShutdown: () => requestShutdown?.(),
  dataDir: process.env.YAADE_PTY_SUPERVISOR_DATA_DIR,
  semanticState: Boolean(ownerId),
  ownerId: ownerId ?? undefined,
  protocolMax: ownerId ? 2 : 1,
}
if (manifestPath) supervisorOptions.manifestPath = manifestPath
const supervisor = await listenTerminalSupervisor(socketPath, supervisorOptions)
const { close } = supervisor
if (ownerId && runtimeManifestPath && process.env.YAADE_PTY_SUPERVISOR_DATA_DIR) {
  const runtimeManifest: TerminalRuntimeManifest = {
    schemaVersion: 2,
    ownerId,
    ownerEpoch: supervisor.manifest.supervisorEpoch,
    runtimeVersion: "generation-v1",
    protocolMin: 1,
    protocolMax: ownerId ? 2 : 1,
    state: "active",
    pid: process.pid,
    processIdentity: supervisor.manifest.processIdentity,
    socketPath,
    startedAt: supervisor.manifest.startedAt,
    capabilities: {
      semanticTerminalState: Boolean(ownerId),
      authoritativeLeases: true,
      structuredInput: Boolean(ownerId),
      historyPaging: Boolean(ownerId),
      subscriptions: Boolean(ownerId),
      draining: true,
    },
  }
  new TerminalRuntimeRegistry(process.env.YAADE_PTY_SUPERVISOR_DATA_DIR).writeManifest(runtimeManifest)
}

const shutdown = () => {
  void close().finally(() => {
    if (ownerId && process.env.YAADE_PTY_SUPERVISOR_DATA_DIR) {
      new TerminalRuntimeRegistry(process.env.YAADE_PTY_SUPERVISOR_DATA_DIR).removeManifest(
        ownerId,
        supervisor.manifest.supervisorEpoch,
      )
    }
    process.exit(0)
  })
}

requestShutdown = shutdown
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
