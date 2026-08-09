import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import type { DatabaseSync } from "node:sqlite"
import type {
  AgentDriverContext,
  AgentDriverDetectionContext,
  AgentCommandResolver,
  AgentProcessSpawner,
  AgentSpawnedProcess,
} from "@yaade/agent-driver"
import { assertAllowedUri } from "@yaade/node-host"
import { fileUriToPath } from "@yaade/shared"
import { readAgentAttachment, resolveAgentAttachment } from "./attachments.js"

const MAX_AGENT_FILE_BYTES = 16 * 1024 * 1024
const MAX_AGENT_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_AGENT_TERMINAL_INPUT_BYTES = 256 * 1024
const MAX_AGENT_TERMINALS = 8
const MAX_AGENT_PROCESSES = 8
const AGENT_PROCESS_ABORT_GRACE_MS = 1_500
const MAX_AGENT_PROBE_OUTPUT_BYTES = 64 * 1024
const AGENT_PROBE_TIMEOUT_MS = 2_000
const SAFE_ENV_KEYS = [
  "HOME",
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
] as const

type AgentContextRuntime = {
  readonly config: {
    readonly allowedRoots: ReadonlyArray<string>
    readonly dataDir: string
  }
  readonly terminal: {
    create(
      cwdUri: string,
      command: { readonly command: string; readonly args: string[] },
      owner: string,
    ): { readonly id: string }
    write(id: string, data: string): void
    dispose(id: string): void
    readOutput(id: string, maxBytes?: number): { output: string; truncated: boolean } | null
    waitForExit(id: string): Promise<{ exitCode: number | null; signal?: string }>
  }
  readonly db: { raw(): DatabaseSync }
}

function safeBaseEnvironment(): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) result[key] = value
  }
  return result
}

function commandResolver(
  assertAllowed: (uri: string) => Promise<string>,
  cwdUri: string,
  signal: AbortSignal,
): AgentCommandResolver {
  return {
    async resolveExecutable(candidates) {
      for (const command of candidates) {
        const paths = path.isAbsolute(command) || command.includes(path.sep)
          ? [command]
          : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(root => path.join(root, command))
        for (const candidate of paths) {
          try {
            await fs.access(candidate, constants.X_OK)
            return candidate
          } catch {
            // Try the next host-resolved candidate.
          }
        }
      }
      return undefined
    },
    async probe(command, args) {
      if (signal.aborted) throw new Error("aborted")
      const cwd = await assertAllowed(cwdUri)
      return new Promise((resolve, reject) => {
        const child = spawn(command, [...args], {
          cwd,
          env: safeBaseEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
        })
        let output = ""
        let bytes = 0
        let settled = false
        const finish = (result: { readonly exitCode: number | null; readonly output: string } | Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener("abort", abort)
          if (result instanceof Error) reject(result)
          else resolve(result)
        }
        const abort = (): void => {
          child.kill("SIGKILL")
          finish(new Error("aborted"))
        }
        const append = (chunk: Buffer): void => {
          bytes += chunk.byteLength
          if (bytes > MAX_AGENT_PROBE_OUTPUT_BYTES) {
            child.kill("SIGKILL")
            finish(new Error(`probe output exceeded ${MAX_AGENT_PROBE_OUTPUT_BYTES} bytes`))
            return
          }
          output += chunk.toString("utf8")
        }
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          finish(new Error("probe timed out"))
        }, AGENT_PROBE_TIMEOUT_MS)
        timer.unref()
        child.stdout.on("data", append)
        child.stderr.on("data", append)
        child.once("error", finish)
        child.once("exit", exitCode => finish({ exitCode, output }))
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      })
    },
  }
}

/** Host-owned executable discovery and bounded version/auth probes. */
export function createAgentDriverDetectionContext(
  runtime: AgentContextRuntime,
  input: { readonly cwdUri: string; readonly signal: AbortSignal },
): AgentDriverDetectionContext {
  const assertAllowed = (uri: string): Promise<string> =>
    assertAllowedUri(uri, [...runtime.config.allowedRoots], fileUriToPath)
  return {
    ...input,
    commands: commandResolver(assertAllowed, input.cwdUri, input.signal),
  }
}

function boundedOutput(
  source: AsyncIterable<Uint8Array>,
  pid: number | undefined,
): AsyncIterable<Uint8Array> {
  return (async function* (): AsyncIterable<Uint8Array> {
    let total = 0
    for await (const chunk of source) {
      total += chunk.byteLength
      if (total > MAX_AGENT_PROCESS_OUTPUT_BYTES) {
        signalChild(pid, "SIGKILL")
        throw new Error(`agent process output exceeds ${MAX_AGENT_PROCESS_OUTPUT_BYTES} bytes`)
      }
      yield chunk
    }
  })()
}

function processSpawner(
  assertAllowed: (uri: string) => Promise<string>,
  signal: AbortSignal,
): AgentProcessSpawner {
  const children = new Set<ReturnType<typeof spawn>>()
  const forceCleanup = (): void => {
    for (const child of children) signalChild(child.pid, "SIGKILL")
    children.clear()
  }
  const scheduleCleanup = (): void => {
    const timer = setTimeout(forceCleanup, AGENT_PROCESS_ABORT_GRACE_MS)
    timer.unref()
  }
  if (signal.aborted) scheduleCleanup()
  else signal.addEventListener("abort", scheduleCleanup, { once: true })
  return {
    async spawn(options): Promise<AgentSpawnedProcess> {
      if (signal.aborted) throw new Error("agent driver context is closed")
      if (children.size >= MAX_AGENT_PROCESSES) {
        throw new Error(`agent process limit is ${MAX_AGENT_PROCESSES}`)
      }
      const cwd = await assertAllowed(options.cwdUri)
      const child = spawn(options.command, [...options.args], {
        cwd,
        env: { ...safeBaseEnvironment(), ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      })
      const settled = new Promise<{ exitCode: number | null; signal?: string }>(
        resolve => {
          child.once("exit", (exitCode, signal) => {
            children.delete(child)
            resolve({
              exitCode,
              ...(signal ? { signal } : {}),
            })
          })
        },
      )
      await new Promise<void>((resolve, reject) => {
        const onSpawn = (): void => {
          child.off("error", onError)
          resolve()
        }
        const onError = (error: Error): void => {
          child.off("spawn", onSpawn)
          reject(error)
        }
        child.once("spawn", onSpawn)
        child.once("error", onError)
      })
      children.add(child)
      if (child.exitCode !== null || child.signalCode !== null) children.delete(child)
      if (signal.aborted) {
        children.delete(child)
        signalChild(child.pid, "SIGKILL")
        throw new Error("agent driver context is closed")
      }
      // Provider stderr is never sent to the browser or retained. Drain it so a
      // noisy provider cannot block on a full pipe without risking secret logs.
      void (async () => {
        for await (const _chunk of child.stderr) {
          // Intentionally discarded.
        }
      })()
      return {
        id: `agent-process:${child.pid ?? randomUUID()}`,
        stdout: boundedOutput(child.stdout as AsyncIterable<Uint8Array>, child.pid),
        stderr: (async function* (): AsyncIterable<Uint8Array> { return })(),
        writeStdin(data) {
          return new Promise<void>((resolve, reject) => {
            child.stdin.write(data, error => (error ? reject(error) : resolve()))
          })
        },
        wait: () => settled,
        async stop(graceMs) {
          if (child.exitCode !== null || child.signalCode !== null) return
          signalChild(child.pid, "SIGTERM")
          const exited = await Promise.race([
            settled.then(() => true),
            new Promise<false>(resolve => {
              setTimeout(() => resolve(false), Math.max(0, graceMs)).unref()
            }),
          ])
          if (!exited) signalChild(child.pid, "SIGKILL")
        },
      }
    },
  }
}

function signalChild(
  pid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (!pid) return
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // Process already exited.
    }
  }
}

function mediaTypeFor(filePath: string): string | undefined {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png": return "image/png"
    case ".jpg":
    case ".jpeg": return "image/jpeg"
    case ".gif": return "image/gif"
    case ".webp": return "image/webp"
    case ".svg": return "image/svg+xml"
    case ".json": return "application/json"
    case ".md": return "text/markdown"
    case ".txt": return "text/plain"
    default: return undefined
  }
}

/** Capability-limited host adapters passed to provider drivers. */
export function createAgentDriverContext(
  runtime: AgentContextRuntime,
  input: {
    readonly threadId: string
    readonly cwdUri: string
    /** Project root when a thread runs in a worktree. */
    readonly projectRootUri?: string
    /** Explicitly granted roots beyond the project and current workspace. */
    readonly additionalRootUris?: ReadonlyArray<string>
    /** Host-authoritative, unsaved editor content for this project session. */
    readonly getEditorBuffer?: (uri: string) => Promise<Uint8Array | null>
    /** Runtime-owned lifetime for every process and terminal created here. */
    readonly signal?: AbortSignal
  },
): AgentDriverContext {
  const allowedRoots = [
    input.cwdUri,
    ...(input.projectRootUri ? [input.projectRootUri] : []),
    ...(input.additionalRootUris ?? []),
  ].map(fileUriToPath)
  const assertAllowed = async (uri: string): Promise<string> => {
    await assertAllowedUri(uri, [...runtime.config.allowedRoots], fileUriToPath)
    return assertAllowedUri(uri, allowedRoots, fileUriToPath)
  }
  const terminalIds = new Set<string>()
  const signal = input.signal ?? new AbortController().signal
  const cleanupTerminals = (): void => {
    for (const terminalId of terminalIds) runtime.terminal.dispose(terminalId)
    terminalIds.clear()
  }
  if (signal.aborted) cleanupTerminals()
  else signal.addEventListener("abort", cleanupTerminals, { once: true })
  return {
    workspace: {
      rootUri: input.cwdUri,
      additionalRoots: [
        ...(input.projectRootUri && input.projectRootUri !== input.cwdUri
          ? [input.projectRootUri]
          : []),
        ...(input.additionalRootUris ?? []),
      ],
      async assertAllowed(uri) {
        await assertAllowed(uri)
      },
    },
    filesystem: {
      async readFile(uri) {
        const filePath = await assertAllowed(uri)
        const buffered = await input.getEditorBuffer?.(uri)
        if (buffered !== undefined && buffered !== null) return buffered
        const stat = await fs.stat(filePath)
        if (stat.size > MAX_AGENT_FILE_BYTES) {
          throw new Error(`agent file exceeds ${MAX_AGENT_FILE_BYTES} bytes`)
        }
        return fs.readFile(filePath)
      },
      async writeFile(uri, content) {
        if (content.byteLength > MAX_AGENT_FILE_BYTES) {
          throw new Error(`agent file exceeds ${MAX_AGENT_FILE_BYTES} bytes`)
        }
        const filePath = await assertAllowed(uri)
        if (!input.getEditorBuffer) {
          throw new Error("agent file writes require authoritative editor buffer conflict checks")
        }
        if (await input.getEditorBuffer(uri) !== null) {
          throw new Error("agent file write conflicts with a dirty editor buffer")
        }
        await fs.writeFile(filePath, content)
      },
      async stat(uri) {
        const filePath = await assertAllowed(uri)
        const stat = await fs.stat(filePath)
        return {
          size: stat.size,
          ...(mediaTypeFor(filePath) ? { mediaType: mediaTypeFor(filePath) } : {}),
        }
      },
    },
    terminal: {
      async open(options) {
        if (signal.aborted) throw new Error("agent driver context is closed")
        await assertAllowed(options.cwdUri)
        if (terminalIds.size >= MAX_AGENT_TERMINALS) {
          throw new Error(`agent terminal limit is ${MAX_AGENT_TERMINALS}`)
        }
        const created = runtime.terminal.create(
          options.cwdUri,
          { command: options.command, args: [...options.args] },
          `agent:${input.threadId}`,
        )
        terminalIds.add(created.id)
        if (signal.aborted) {
          terminalIds.delete(created.id)
          runtime.terminal.dispose(created.id)
          throw new Error("agent driver context is closed")
        }
        return {
          id: created.id,
          async write(data) {
            if (Buffer.byteLength(data) > MAX_AGENT_TERMINAL_INPUT_BYTES) {
              throw new Error(`agent terminal input exceeds ${MAX_AGENT_TERMINAL_INPUT_BYTES} bytes`)
            }
            runtime.terminal.write(created.id, data)
          },
          async readOutput() {
            const snapshot = runtime.terminal.readOutput(created.id)
            if (!snapshot) throw new Error("agent terminal not found")
            return snapshot
          },
          waitForExit() {
            return runtime.terminal.waitForExit(created.id)
          },
          async close() {
            if (terminalIds.delete(created.id)) runtime.terminal.dispose(created.id)
          },
        }
      },
    },
    processSpawner: processSpawner(assertAllowed, signal),
    commands: commandResolver(assertAllowed, input.cwdUri, signal),
    attachments: {
      async resolve(attachmentId) {
        return resolveAgentAttachment(
          runtime.db.raw(),
          runtime.config.dataDir,
          input.threadId,
          attachmentId,
        )
      },
      async read(attachmentId) {
        return readAgentAttachment(
          runtime.db.raw(),
          runtime.config.dataDir,
          input.threadId,
          attachmentId,
        )
      },
    },
    credentials: {
      async get(name) {
        const bindings = new Map(
          (process.env.JET_AGENT_CREDENTIALS ?? "")
            .split(",")
            .flatMap(binding => {
              const [credentialName, environmentName, ...extra] = binding
                .split("=")
                .map(part => part.trim())
              if (
                !credentialName ||
                !environmentName ||
                extra.length > 0 ||
                /[\s=]/.test(credentialName) ||
                !/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName)
              ) return []
              return [[credentialName, environmentName] as const]
            }),
        )
        const environmentName = bindings.get(name)
        return environmentName ? process.env[environmentName] : undefined
      },
    },
    mcp: { async listServers() { return [] } },
    clock: {
      now: () => new Date(),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    },
    logger: {
      debug(message, fields) { console.debug(`[agent] ${message}`, fields ?? "") },
      info(message, fields) { console.info(`[agent] ${message}`, fields ?? "") },
      warn(message, fields) { console.warn(`[agent] ${message}`, fields ?? "") },
      error(message, fields) { console.error(`[agent] ${message}`, fields ?? "") },
    },
    signal,
  }
}
