#!/usr/bin/env bun
import fs from "node:fs"
import path from "node:path"
import {
  STORAGE_FAILURE_FILE,
  controlUserService,
  installUserService,
  loadConfig,
  runHostServer,
  uninstallUserService,
} from "@yaade/host-server"

const argv = process.argv.slice(2)
const command = argv[0]
const serviceCommands = new Set(["install", "uninstall", "start", "stop", "restart"])
const inspectionCommands = new Set(["status", "doctor", "pair"])
type InspectionCommand = "status" | "doctor" | "pair"
type ServiceControlCommand = "start" | "stop" | "restart"
function isServiceControlCommand(value: string): value is ServiceControlCommand {
  return value === "start" || value === "stop" || value === "restart"
}
function isInspectionCommand(value: string): value is InspectionCommand {
  return inspectionCommands.has(value)
}

async function inspectRuntime(action: "status" | "doctor" | "pair", args: string[]): Promise<void> {
  const config = await loadConfig(args)
  const manifestPath = path.join(config.dataDir, "runtime.json")
  let manifest: { host?: string; port?: number; serverId?: string; serverEpoch?: string } | null = null
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const value = raw as Record<string, unknown>
      manifest = {
        ...(typeof value.host === "string" ? { host: value.host } : {}),
        ...(typeof value.port === "number" ? { port: value.port } : {}),
        ...(typeof value.serverId === "string" ? { serverId: value.serverId } : {}),
        ...(typeof value.serverEpoch === "string" ? { serverEpoch: value.serverEpoch } : {}),
      }
    }
  } catch {
    /* stale/missing manifests are reported below */
  }
  let storageFailure: unknown = null
  try {
    storageFailure = JSON.parse(
      fs.readFileSync(path.join(config.dataDir, STORAGE_FAILURE_FILE), "utf8"),
    )
  } catch {
    /* no storage failure record */
  }
  if (action === "pair") {
    if (!config.authToken) throw new Error("pairing-code requires the configured host token")
    const targetHost = manifest?.host ?? config.host
    const targetPort = manifest?.port ?? config.port
    const response = await fetch(`http://${targetHost}:${targetPort}/api/v1/security/pairing-code`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.authToken}` },
    })
    console.log(await response.text())
    return
  }
  const health = manifest?.port
    ? await fetch(`http://${manifest.host ?? "127.0.0.1"}:${manifest.port}/health`).then(async response => ({
        status: response.status,
        body: await response.text(),
      })).catch(error => ({ status: 0, body: String(error) }))
    : { status: 0, body: "runtime manifest is missing" }
  console.log(JSON.stringify({ action, dataDir: config.dataDir, manifest, health, storageFailure }, null, 2))
  if (action === "doctor" && (health.status !== 200 || storageFailure)) process.exitCode = 1
}

if (!command || command === "run" || (!serviceCommands.has(command) && !inspectionCommands.has(command))) {
  runHostServer(command === "run" ? argv.slice(1) : argv)
} else if (serviceCommands.has(command)) {
  const config = await loadConfig(argv.slice(1))
  const executable = process.env.YAADE_SERVER_EXECUTABLE ?? process.execPath
  const entry = process.env.YAADE_SERVER_ENTRY ?? path.resolve(process.argv[1] ?? "")
  const options = {
    executable,
    dataDir: config.dataDir,
    args: [entry, "run", "--data-dir", config.dataDir],
  }
  const result = command === "install"
    ? await installUserService(options)
    : command === "uninstall"
      ? await uninstallUserService(options)
      : isServiceControlCommand(command)
        ? await controlUserService(command, options)
        : await uninstallUserService(options)
  console.log(JSON.stringify(result))
} else if (isInspectionCommand(command)) {
  await inspectRuntime(command, argv.slice(1))
}
