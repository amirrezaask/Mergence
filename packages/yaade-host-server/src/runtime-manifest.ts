import fs from "node:fs"
import path from "node:path"
import { captureProcessIdentity, type ProcessIdentity } from "@yaade/node-host"
import type { ServerIdentity } from "@yaade/rpc"

export type DaemonRuntimeManifest = {
  schemaVersion: 1
  serverId: string
  serverEpoch: string
  pid: number
  processIdentity: ProcessIdentity | null
  host: "127.0.0.1"
  port: number
  startedAt: string
}

export function daemonRuntimeManifestPath(dataDir: string): string {
  return path.join(dataDir, "runtime.json")
}

export function writeDaemonRuntimeManifest(
  dataDir: string,
  identity: ServerIdentity,
  port: number,
): DaemonRuntimeManifest {
  const manifest: DaemonRuntimeManifest = {
    schemaVersion: 1,
    serverId: identity.serverId,
    serverEpoch: identity.serverEpoch,
    pid: process.pid,
    processIdentity: captureProcessIdentity(process.pid),
    host: "127.0.0.1",
    port,
    startedAt: identity.startedAt,
  }
  const target = daemonRuntimeManifestPath(dataDir)
  const temporary = `${target}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(temporary, JSON.stringify(manifest), { mode: 0o600 })
  try {
    fs.chmodSync(temporary, 0o600)
  } catch {
    /* Windows ignores Unix mode bits. */
  }
  fs.renameSync(temporary, target)
  return manifest
}

function parseProcessIdentity(value: unknown): ProcessIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    typeof record.pid !== "number" ||
    typeof record.startToken !== "string" ||
    (record.platform !== "linux" && record.platform !== "darwin" && record.platform !== "windows")
  ) return null
  return {
    pid: record.pid,
    platform: record.platform,
    startToken: record.startToken,
    ...(typeof record.bootId === "string" ? { bootId: record.bootId } : {}),
    ...(typeof record.executablePath === "string" ? { executablePath: record.executablePath } : {}),
  }
}

export function readDaemonRuntimeManifest(
  dataDir: string,
): DaemonRuntimeManifest | null {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(daemonRuntimeManifestPath(dataDir), "utf8"),
    )
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (
      record.schemaVersion !== 1 ||
      typeof record.serverId !== "string" ||
      typeof record.serverEpoch !== "string" ||
      typeof record.pid !== "number" ||
      record.host !== "127.0.0.1" ||
      typeof record.port !== "number" ||
      typeof record.startedAt !== "string"
    ) return null
    return {
      schemaVersion: 1,
      serverId: record.serverId,
      serverEpoch: record.serverEpoch,
      pid: record.pid,
      processIdentity: parseProcessIdentity(record.processIdentity),
      host: "127.0.0.1",
      port: record.port,
      startedAt: record.startedAt,
    }
  } catch {
    return null
  }
}

export function removeDaemonRuntimeManifest(
  dataDir: string,
  serverEpoch: string,
): void {
  const current = readDaemonRuntimeManifest(dataDir)
  if (current?.serverEpoch !== serverEpoch) return
  try {
    fs.unlinkSync(daemonRuntimeManifestPath(dataDir))
  } catch {
    /* already removed */
  }
}
