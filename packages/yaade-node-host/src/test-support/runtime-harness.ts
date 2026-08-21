import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  isProcessAlive,
  matchesProcessIdentity,
  type ProcessIdentity,
} from "../process-identity.js"
import {
  readSupervisorManifestForTests,
  supervisorManifestPath,
  type SupervisorManifest,
} from "../terminal-supervisor.js"
import { TerminalRuntimeRegistry } from "../terminal-runtime-registry.js"
import { SupervisedTerminalHost } from "../terminal-supervisor-client.js"

export type RuntimeHarnessOptions = {
  readonly root?: string
  readonly prefix?: string
  readonly keepDataDir?: boolean
}

export function fixturePath(name: string): string {
  if (!/^[a-z0-9-]+\.mjs$/u.test(name)) {
    throw new Error(`invalid terminal fixture name: ${name}`)
  }
  return fileURLToPath(new URL(`../test-fixtures/${name}`, import.meta.url))
}

export function fixtureLaunch(
  name: string,
  args: readonly string[] = [],
): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [fixturePath(name), ...args],
  }
}

export async function makeRuntimeDataDir(
  options: RuntimeHarnessOptions = {},
): Promise<string> {
  const root = options.root ?? os.tmpdir()
  return fs.promises.mkdtemp(
    path.join(root, options.prefix ?? "yaade-terminal-runtime-"),
  )
}

export class RuntimeHarness {
  readonly dataDir: string
  private readonly keepDataDir: boolean
  private client: SupervisedTerminalHost | null = null

  private constructor(dataDir: string, keepDataDir: boolean) {
    this.dataDir = dataDir
    this.keepDataDir = keepDataDir
  }

  static async start(options: RuntimeHarnessOptions = {}): Promise<RuntimeHarness> {
    const dataDir = await makeRuntimeDataDir(options)
    const harness = new RuntimeHarness(dataDir, options.keepDataDir === true)
    await harness.connectClient()
    return harness
  }

  get connectedClient(): SupervisedTerminalHost {
    if (!this.client) throw new Error("runtime harness client is disconnected")
    return this.client
  }

  async connectClient(): Promise<SupervisedTerminalHost> {
    if (this.client) await this.client.disconnect()
    this.client = await SupervisedTerminalHost.connect(this.dataDir)
    return this.client
  }

  async disconnectClient(): Promise<void> {
    const client = this.client
    this.client = null
    await client?.disconnect()
  }

  async stopSupervisor(): Promise<void> {
    const client = this.client
    this.client = null
    if (client) {
      await client.shutdownSupervisor().catch(() => undefined)
      return
    }
    if (this.manifest()) {
      const cleanup = await SupervisedTerminalHost.connect(this.dataDir)
      await cleanup.shutdownSupervisor().catch(() => undefined)
    }
    const registry = new TerminalRuntimeRegistry(this.dataDir)
    for (const manifest of registry.listManifests()) {
      if (manifest.runtimeVersion === "legacy") continue
      const cleanup = await SupervisedTerminalHost.connectGeneration(
        this.dataDir,
        manifest.socketPath,
      ).catch(() => null)
      await cleanup?.shutdownSupervisor().catch(() => undefined)
    }
  }

  manifest(): SupervisorManifest | null {
    return readSupervisorManifestForTests(supervisorManifestPath(this.dataDir))
  }

  manifestProcessIsAlive(): boolean {
    const manifest = this.manifest()
    if (!manifest) return false
    return manifest.processIdentity
      ? matchesProcessIdentity(manifest.processIdentity)
      : isProcessAlive(manifest.pid)
  }

  async waitFor(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 5_000,
    message = "runtime harness wait timed out",
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await predicate()) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error(message)
  }

  async waitForOutput(
    terminalId: string,
    marker: string,
    timeoutMs = 5_000,
  ): Promise<void> {
    await this.waitFor(async () => {
      const snapshot = await this.connectedClient.attach(terminalId, "harness")
      return Boolean(snapshot?.outputChunks.join("").includes(marker))
    }, timeoutMs, `terminal output marker not found: ${marker}`)
  }

  async waitForChildAlive(
    identity: ProcessIdentity | null,
    timeoutMs = 5_000,
  ): Promise<void> {
    if (!identity) throw new Error("terminal did not expose process identity")
    await this.waitFor(
      () => matchesProcessIdentity(identity),
      timeoutMs,
      "terminal child is not alive",
    )
  }

  async close(): Promise<void> {
    await this.stopSupervisor().catch(() => undefined)
    if (!this.keepDataDir) {
      await fs.promises.rm(this.dataDir, { recursive: true, force: true })
    }
  }
}

export function dataDirUri(dataDir: string): string {
  return pathToFileURL(dataDir).href
}
