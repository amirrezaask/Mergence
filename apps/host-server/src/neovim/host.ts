import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import net from "node:net"
import { NeovimToolOutput, type ToolUseId } from "@yaade/rpc"
import { NeovimEndpointStore, type NeovimEndpoint } from "./endpoint.js"

type RuntimeState = "starting" | "running" | "exited" | "failed" | "disconnected"

type NeovimRuntime = {
  readonly toolUseId: ToolUseId
  readonly serverInstanceId: string
  readonly generation: number
  readonly endpoint: NeovimEndpoint
  readonly cwd: string
  readonly child: ChildProcess
  readonly version: string
  stderr: string
  state: RuntimeState
  exitCode?: number
  stopping: boolean
  lease?: { readonly token: object; readonly socket: net.Socket }
  warmSocket?: net.Socket
  leaseSequence: number
}

export type NeovimExitEvent = {
  readonly toolUseId: ToolUseId
  readonly output: NeovimToolOutput
}

export type NeovimUiLease = {
  readonly socket: net.Socket
  readonly release: () => void
}

export type NeovimHostOptions = {
  readonly binary?: string
  readonly onExit?: (event: NeovimExitEvent) => void
}

const VERSION_TIMEOUT_MS = 3_000
const START_TIMEOUT_MS = 5_000
const STOP_TIMEOUT_MS = 1_500
const ENDPOINT_CONNECT_TIMEOUT_MS = 3_000
const STDERR_LIMIT = 64 * 1024

function appendBounded(previous: string, chunk: string): string {
  const bytes = Buffer.from(previous + chunk)
  if (bytes.byteLength <= STDERR_LIMIT) return bytes.toString("utf8")
  return bytes.subarray(bytes.byteLength - STDERR_LIMIT).toString("utf8")
}

function parseVersion(output: string): string | null {
  const match = output.match(/NVIM\s+v?(\d+)\.(\d+)(?:\.(\d+))?/i)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3] ?? 0)
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null
  if (major < 0 || minor < 0 || patch < 0) return null
  return `${major}.${minor}.${patch}`
}

function supportedVersion(version: string): boolean {
  const [major, minor] = version.split(".").map(Number)
  return major > 0 || minor >= 10
}

function connectEndpoint(endpoint: NeovimEndpoint): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(
      endpoint.kind === "unix" ? { path: endpoint.path } : { path: endpoint.path },
    )
    let settled = false
    const timer = setTimeout(() => fail(new Error("Neovim endpoint connection timed out")), ENDPOINT_CONNECT_TIMEOUT_MS)
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    socket.once("connect", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.setNoDelay(true)
      resolve(socket)
    })
    socket.once("error", fail)
  })
}

function wait(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs))
}

/**
 * Host-owned Neovim processes. A ToolUse id is the only process lifetime key;
 * browser surfaces only receive short-lived socket leases from this registry.
 */
export class NeovimHost {
  private readonly endpointStore = new NeovimEndpointStore()
  private readonly runtimes = new Map<ToolUseId, NeovimRuntime>()
  private readonly binary: string
  private readonly onExit?: (event: NeovimExitEvent) => void
  private versionPromise: Promise<string> | undefined

  constructor(options: NeovimHostOptions = {}) {
    this.binary = options.binary?.trim() || process.env.YAADE_NVIM_BIN?.trim() || "nvim"
    this.onExit = options.onExit
  }

  binaryPath(): string {
    return this.binary
  }

  async version(): Promise<string> {
    this.versionPromise ??= this.probeVersion()
    return this.versionPromise
  }

  async start(
    toolUseId: ToolUseId,
    generation: number,
    cwd: string,
  ): Promise<NeovimToolOutput> {
    const previous = this.runtimes.get(toolUseId)
    if (previous && previous.generation === generation && previous.state === "running") {
      return this.output(previous)
    }
    if (previous) await this.stopRuntime(previous)
    const version = await this.version()
    const endpoint = this.endpointStore.endpoint(toolUseId, generation)
    this.endpointStore.cleanup(endpoint)
    const child = spawn(this.binary, ["--headless", "--listen", endpoint.path], {
      cwd,
      shell: false,
      env: {
        ...process.env,
        YAADE_NVIM: "1",
        COLORTERM: "truecolor",
      },
      stdio: ["ignore", "ignore", "pipe"],
    })
    const runtime: NeovimRuntime = {
      toolUseId,
      serverInstanceId: randomUUID(),
      generation,
      endpoint,
      cwd,
      child,
      version,
      stderr: "",
      state: "starting",
      stopping: false,
      leaseSequence: 0,
    }
    this.runtimes.set(toolUseId, runtime)
    child.stderr?.on("data", chunk => {
      runtime.stderr = appendBounded(runtime.stderr, String(chunk))
    })
    let exited = false
    const markExit = (code: number | null, failed: boolean) => {
      if (exited) return
      exited = true
      runtime.exitCode = code == null ? undefined : code
      runtime.warmSocket?.destroy()
      runtime.warmSocket = undefined
      runtime.state = runtime.stopping
        ? "exited"
        : failed || (code != null && code !== 0)
          ? "failed"
          : "exited"
      runtime.lease?.socket.destroy()
      runtime.lease = undefined
      if (this.runtimes.get(toolUseId) === runtime) this.runtimes.delete(toolUseId)
      try {
        this.endpointStore.cleanup(endpoint)
      } catch {
        /* The socket may already have been removed by Neovim. */
      }
      if (!runtime.stopping) {
        this.onExit?.({ toolUseId, output: this.output(runtime) })
      }
    }
    child.once("error", () => markExit(null, true))
    child.once("exit", (code, signal) => markExit(code, signal !== null && code === null))

    try {
      runtime.warmSocket = await this.waitUntilReady(runtime, () => exited)
      runtime.state = "running"
      return this.output(runtime)
    } catch (error) {
      runtime.stopping = true
      await this.stopRuntime(runtime)
      const detail = runtime.stderr.trim()
      const suffix = detail ? `: ${detail.slice(-1_024)}` : ""
      throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`)
    }
  }

  async restart(
    toolUseId: ToolUseId,
    generation: number,
    cwd: string,
  ): Promise<NeovimToolOutput> {
    await this.stop(toolUseId)
    return this.start(toolUseId, generation, cwd)
  }

  async stop(toolUseId: ToolUseId): Promise<NeovimToolOutput | undefined> {
    const runtime = this.runtimes.get(toolUseId)
    if (!runtime) return undefined
    runtime.stopping = true
    await this.stopRuntime(runtime)
    return this.output(runtime)
  }

  get(toolUseId: ToolUseId): NeovimRuntimeSnapshot | undefined {
    const runtime = this.runtimes.get(toolUseId)
    if (!runtime || runtime.state !== "running") return undefined
    return {
      toolUseId: runtime.toolUseId,
      serverInstanceId: runtime.serverInstanceId,
      generation: runtime.generation,
      endpoint: runtime.endpoint,
      cwd: runtime.cwd,
      version: runtime.version,
    }
  }

  async acquireUi(toolUseId: ToolUseId, generation: number): Promise<NeovimUiLease> {
    const runtime = this.runtimes.get(toolUseId)
    if (!runtime || runtime.state !== "running" || runtime.generation !== generation) {
      throw new Error("Neovim runtime is unavailable or stale")
    }
    const sequence = ++runtime.leaseSequence
    runtime.lease?.socket.destroy()
    runtime.lease = undefined
    const socket = runtime.warmSocket ?? await connectEndpoint(runtime.endpoint)
    runtime.warmSocket = undefined
    if (
      this.runtimes.get(toolUseId) !== runtime ||
      runtime.state !== "running" ||
      runtime.generation !== generation ||
      runtime.leaseSequence !== sequence
    ) {
      socket.destroy()
      throw new Error("Neovim runtime UI lease was superseded while connecting")
    }
    const token = {}
    runtime.lease = { token, socket }
    const release = () => {
      if (runtime.lease?.token !== token) return
      runtime.lease = undefined
      socket.destroy()
    }
    socket.once("close", () => {
      if (runtime.lease?.token === token) runtime.lease = undefined
    })
    return { socket, release }
  }

  async closeAll(): Promise<void> {
    const runtimes = [...this.runtimes.values()]
    await Promise.all(runtimes.map(async runtime => {
      runtime.stopping = true
      await this.stopRuntime(runtime)
    }))
    this.runtimes.clear()
    this.endpointStore.close()
  }

  private output(runtime: NeovimRuntime): NeovimToolOutput {
    const output = {
      kind: "neovim" as const,
      serverInstanceId: runtime.serverInstanceId,
      generation: runtime.generation,
      processState: runtime.state,
      version: runtime.version,
    }
    if (runtime.exitCode == null) return NeovimToolOutput.make(output)
    return NeovimToolOutput.make({ ...output, exitCode: runtime.exitCode })
  }

  private async probeVersion(): Promise<string> {
    const child = spawn(this.binary, ["--version"], {
      shell: false,
      env: { ...process.env, YAADE_NVIM: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    return new Promise((resolve, reject) => {
      let stdout = ""
      let stderr = ""
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill("SIGKILL")
        reject(new Error(`Neovim binary probe timed out: ${this.binary}`))
      }, VERSION_TIMEOUT_MS)
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) {
          reject(error)
          return
        }
        const version = parseVersion(stdout)
        if (!version) {
          reject(new Error(`Neovim version could not be read from ${this.binary}: ${stderr.slice(-1_024)}`))
          return
        }
        if (!supportedVersion(version)) {
          reject(new Error(`Neovim ${version} is too old; YAADE requires Neovim 0.10 or newer`))
          return
        }
        resolve(version)
      }
      child.stdout?.on("data", chunk => { stdout = appendBounded(stdout, String(chunk)) })
      child.stderr?.on("data", chunk => { stderr = appendBounded(stderr, String(chunk)) })
      child.once("error", error => finish(new Error(`Neovim binary is unavailable (${this.binary}): ${error.message}`)))
      child.once("exit", code => {
        if (code !== 0) {
          finish(new Error(`Neovim binary probe failed (${this.binary}): ${stderr.slice(-1_024)}`))
        } else {
          finish()
        }
      })
    })
  }

  private async waitUntilReady(
    runtime: NeovimRuntime,
    hasExited: () => boolean,
  ): Promise<net.Socket> {
    const startedAt = Date.now()
    let lastError = "socket is not ready"
    while (Date.now() - startedAt < START_TIMEOUT_MS) {
      if (hasExited()) throw new Error("Neovim exited before its server socket became ready")
      try {
        return await connectEndpoint(runtime.endpoint)
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        await wait(25)
      }
    }
    throw new Error(`Neovim server did not become ready: ${lastError}`)
  }

  private async stopRuntime(runtime: NeovimRuntime): Promise<void> {
    runtime.leaseSequence += 1
    runtime.warmSocket?.destroy()
    runtime.warmSocket = undefined
    runtime.lease?.socket.destroy()
    runtime.lease = undefined
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
      runtime.child.kill("SIGTERM")
      const exitedGracefully = await this.waitForChildExit(runtime.child, STOP_TIMEOUT_MS)
      if (!exitedGracefully && runtime.child.exitCode === null && runtime.child.signalCode === null) {
        runtime.child.kill("SIGKILL")
        await this.waitForChildExit(runtime.child, 500)
      }
    }
    try {
      this.endpointStore.cleanup(runtime.endpoint)
    } catch {
      /* best effort */
    }
    if (this.runtimes.get(runtime.toolUseId) === runtime) this.runtimes.delete(runtime.toolUseId)
  }

  private waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
    return new Promise(resolve => {
      let settled = false
      const finish = (exited: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.off("exit", onExit)
        resolve(exited)
      }
      const onExit = () => finish(true)
      const timer = setTimeout(() => finish(false), timeoutMs)
      child.once("exit", onExit)
    })
  }
}

export type NeovimRuntimeSnapshot = {
  readonly toolUseId: ToolUseId
  readonly serverInstanceId: string
  readonly generation: number
  readonly endpoint: NeovimEndpoint
  readonly cwd: string
  readonly version: string
}
