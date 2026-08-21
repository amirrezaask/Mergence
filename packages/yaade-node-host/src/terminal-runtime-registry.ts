import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import {
  matchesProcessIdentity,
  isProcessAlive,
  type ProcessIdentity,
} from "./process-identity.js"
import type { RuntimeCapabilities } from "./terminal-protocol/schema.js"

// This module is the untrusted manifest boundary. It validates JSON records
// before converting them into the owned TerminalRuntimeManifest shape.
/* oxlint-disable anti-slop/no-unknown-parameters */
/* oxlint-disable anti-slop/no-unsafe-dictionary-type */
/* oxlint-disable anti-slop/no-runtime-typeof */

export type TerminalRuntimeManifest = {
  readonly schemaVersion: 2
  readonly ownerId: string
  readonly ownerEpoch: string
  readonly runtimeVersion: string
  readonly protocolMin: number
  readonly protocolMax: number
  readonly state: "active" | "draining"
  readonly pid: number
  readonly processIdentity: ProcessIdentity | null
  readonly socketPath: string
  readonly startedAt: string
  readonly capabilities: RuntimeCapabilities
}

export type RuntimeRegistrySnapshot = {
  readonly schemaVersion: 1
  readonly owners: readonly string[]
  readonly updatedAt: string
}

export function runtimeRegistryDirectory(dataDir: string): string {
  return path.join(dataDir, "pty-runtimes")
}

export function runtimeRegistryPath(dataDir: string): string {
  return path.join(runtimeRegistryDirectory(dataDir), "registry.json")
}

export function runtimeOwnerDirectory(dataDir: string, ownerId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(ownerId)) throw new Error("invalid runtime owner ID")
  return path.join(runtimeRegistryDirectory(dataDir), ownerId)
}

export function runtimeManifestPath(dataDir: string, ownerId: string): string {
  return path.join(runtimeOwnerDirectory(dataDir, ownerId), "manifest.json")
}

export function runtimeSocketPath(dataDir: string, ownerId: string): string {
  const directory = runtimeOwnerDirectory(dataDir, ownerId)
  const socket = path.join(directory, "runtime.sock")
  if (process.platform === "win32") {
    const digest = createHash("sha256").update(socket).digest("hex").slice(0, 24)
    return `\\\\.\\pipe\\yaade-pty-${digest}`
  }
  if (Buffer.byteLength(socket) <= 100) return socket
  const digest = createHash("sha256").update(socket).digest("hex").slice(0, 24)
  return path.join(os.tmpdir(), `yaade-runtime-${digest}.sock`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isCapabilities(value: unknown): value is RuntimeCapabilities {
  if (!isRecord(value)) return false
  const record = value
  return (
    typeof record.semanticTerminalState === "boolean" &&
    typeof record.authoritativeLeases === "boolean" &&
    typeof record.structuredInput === "boolean" &&
    typeof record.historyPaging === "boolean" &&
    typeof record.subscriptions === "boolean" &&
    typeof record.draining === "boolean"
  )
}

function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!isRecord(value)) return false
  return (
    typeof value.pid === "number" && Number.isSafeInteger(value.pid) &&
    (value.platform === "linux" || value.platform === "darwin" || value.platform === "windows") &&
    typeof value.startToken === "string" &&
    (value.bootId === undefined || typeof value.bootId === "string") &&
    (value.executablePath === undefined || typeof value.executablePath === "string")
  )
}

export function parseRuntimeManifest(value: unknown): TerminalRuntimeManifest | null {
  if (!isRecord(value)) return null
  const record = value
  if (
    record.schemaVersion !== 2 ||
    typeof record.ownerId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(record.ownerId) ||
    typeof record.ownerEpoch !== "string" ||
    typeof record.runtimeVersion !== "string" ||
    typeof record.protocolMin !== "number" ||
    typeof record.protocolMax !== "number" ||
    typeof record.state !== "string" ||
    (record.state !== "active" && record.state !== "draining") ||
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    typeof record.socketPath !== "string" ||
    typeof record.startedAt !== "string" ||
    !isCapabilities(record.capabilities)
  ) return null
  const identity = record.processIdentity
  const processIdentity = isProcessIdentity(identity) ? identity : null
  return {
    schemaVersion: 2,
    ownerId: record.ownerId,
    ownerEpoch: record.ownerEpoch,
    runtimeVersion: record.runtimeVersion,
    protocolMin: record.protocolMin,
    protocolMax: record.protocolMax,
    state: record.state,
    pid: record.pid,
    processIdentity,
    socketPath: record.socketPath,
    startedAt: record.startedAt,
    capabilities: record.capabilities,
  }
}

export function runtimeSupports(
  manifest: TerminalRuntimeManifest,
  requiredProtocol: number,
  requiredCapabilities: Partial<RuntimeCapabilities> = {},
): boolean {
  if (
    manifest.state !== "active" ||
    manifest.protocolMin > requiredProtocol ||
    manifest.protocolMax < requiredProtocol
  ) return false
  const capabilityNames = [
    "semanticTerminalState",
    "authoritativeLeases",
    "structuredInput",
    "historyPaging",
    "subscriptions",
    "draining",
  ] as const
  for (const name of capabilityNames) {
    if (requiredCapabilities[name] && !manifest.capabilities[name]) return false
  }
  return true
}

export function runtimeProcessIsAlive(manifest: TerminalRuntimeManifest): boolean {
  return manifest.processIdentity
    ? matchesProcessIdentity(manifest.processIdentity)
    : isProcessAlive(manifest.pid)
}

export class TerminalRuntimeRegistry {
  constructor(private readonly dataDir: string) {}

  listManifests(): TerminalRuntimeManifest[] {
    const root = runtimeRegistryDirectory(this.dataDir)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      entries = []
    }
    const manifests: TerminalRuntimeManifest[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const manifest = this.readManifest(path.join(root, entry.name, "manifest.json"))
      if (manifest) manifests.push(manifest)
    }
    const legacy = this.readLegacyManifest(path.join(this.dataDir, "pty-supervisor.json"))
    if (legacy && !manifests.some(manifest => manifest.ownerEpoch === legacy.ownerEpoch)) {
      manifests.push(legacy)
    }
    return manifests.sort((left, right) => left.startedAt.localeCompare(right.startedAt))
  }

  readManifest(manifestPath: string): TerminalRuntimeManifest | null {
    try {
      return parseRuntimeManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")))
    } catch {
      return null
    }
  }

  writeManifest(manifest: TerminalRuntimeManifest): void {
    const target = runtimeManifestPath(this.dataDir, manifest.ownerId)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600 })
    try {
      fs.chmodSync(temporary, 0o600)
    } catch {
      /* Windows does not expose Unix mode bits. */
    }
    fs.renameSync(temporary, target)
    this.writeRegistry()
  }

  updateState(
    ownerId: string,
    ownerEpoch: string,
    state: "active" | "draining",
  ): TerminalRuntimeManifest | null {
    const target = runtimeManifestPath(this.dataDir, ownerId)
    const current = this.readManifest(target)
    if (!current || current.ownerEpoch !== ownerEpoch) return null
    const next = { ...current, state }
    this.writeManifest(next)
    return next
  }

  removeManifest(ownerId: string, expectedEpoch?: string): boolean {
    const target = runtimeManifestPath(this.dataDir, ownerId)
    const current = this.readManifest(target)
    if (!current || (expectedEpoch && current.ownerEpoch !== expectedEpoch)) return false
    fs.rmSync(runtimeOwnerDirectory(this.dataDir, ownerId), { recursive: true, force: true })
    this.writeRegistry()
    return true
  }

  rebuild(): TerminalRuntimeManifest[] {
    const manifests = this.listManifests()
    this.writeRegistry()
    return manifests
  }

  pruneStale(): TerminalRuntimeManifest[] {
    // A legacy manifest without an OS identity is unknown, not proven stale;
    // leave it for the compatibility adapter to probe before removing it.
    const stale = this.listManifests().filter(
      manifest => manifest.processIdentity !== null && !runtimeProcessIsAlive(manifest),
    )
    for (const manifest of stale) {
      const target = runtimeManifestPath(this.dataDir, manifest.ownerId)
      if (fs.existsSync(target)) {
        this.removeManifest(manifest.ownerId, manifest.ownerEpoch)
      } else if (manifest.runtimeVersion === "legacy") {
        const legacyPath = path.join(this.dataDir, "pty-supervisor.json")
        const current = this.readLegacyManifest(legacyPath)
        if (current?.ownerEpoch === manifest.ownerEpoch) {
          try { fs.unlinkSync(legacyPath) } catch { /* already removed */ }
        }
      }
    }
    this.writeRegistry()
    return this.listManifests()
  }

  chooseCreateRuntime(
    requiredProtocol: number,
    requiredCapabilities: Partial<RuntimeCapabilities> = {},
  ): TerminalRuntimeManifest | null {
    const candidates = this.listManifests().filter(manifest =>
      runtimeSupports(manifest, requiredProtocol, requiredCapabilities),
    )
    return candidates.at(-1) ?? null
  }

  liveManifests(): TerminalRuntimeManifest[] {
    return this.listManifests().filter(runtimeProcessIsAlive)
  }

  private readLegacyManifest(manifestPath: string): TerminalRuntimeManifest | null {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
      if (!isRecord(value)) return null
      if (
        typeof value.supervisorId !== "string" ||
        typeof value.supervisorEpoch !== "string" ||
        typeof value.protocolVersion !== "number" ||
        !Number.isSafeInteger(value.protocolVersion) ||
        typeof value.pid !== "number" ||
        !Number.isSafeInteger(value.pid) ||
        typeof value.socketPath !== "string" ||
        typeof value.startedAt !== "string"
      ) return null
      const ownerSuffix = value.supervisorId.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 96) || "unknown"
      return {
        schemaVersion: 2,
        ownerId: `legacy-${ownerSuffix}`,
        ownerEpoch: value.supervisorEpoch,
        runtimeVersion: "legacy",
        protocolMin: value.protocolVersion,
        protocolMax: value.protocolVersion,
        state: "active",
        pid: value.pid,
        processIdentity: isProcessIdentity(value.processIdentity) ? value.processIdentity : null,
        socketPath: value.socketPath,
        startedAt: value.startedAt,
        capabilities: {
          semanticTerminalState: false,
          authoritativeLeases: false,
          structuredInput: false,
          historyPaging: false,
          subscriptions: false,
          draining: false,
        },
      }
    } catch {
      return null
    }
  }

  private writeRegistry(): void {
    const target = runtimeRegistryPath(this.dataDir)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.tmp`
    const snapshot: RuntimeRegistrySnapshot = {
      schemaVersion: 1,
      owners: this.listManifests().map(manifest => manifest.ownerEpoch),
      updatedAt: new Date().toISOString(),
    }
    fs.writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, target)
  }
}
