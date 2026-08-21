import { chromium, type BrowserContext, type Page } from "@playwright/test"
import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable } from "node:stream"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  captureProcessIdentity,
  isProcessAlive,
  type ProcessIdentity,
} from "../../../packages/yaade-node-host/src/process-identity.js"
import { readDatabaseState } from "./database.js"
import { waitForMockAgent } from "./mock-agent.js"
import { assertProcessAlive, assertProcessDead, readProcessTree, waitForProcessIdentity } from "./process.js"
import {
  attachTerminal,
  createProject,
  createTerminalInstance,
  listTerminalInstances,
  readHealth,
  type TerminalInstanceInfo,
} from "./rpc.js"
import { dropSupervisorClients, listSupervisorPtys, readSupervisorHandle, waitForSupervisor } from "./supervisor.js"
import type {
  ApiHandle,
  BrowserHandle,
  DatabaseSnapshot,
  MockAgentHandle,
  MockAgentOptions,
  ResourceMetrics,
  RuntimeSnapshot,
  ServerOptions,
  SupervisorHandle,
} from "./types.js"
import { waitForHttpOk, waitUntil } from "./wait.js"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const HOST_SERVER_ENTRY = path.join(REPO_ROOT, "packages/yaade-host-server/src/cli.ts")
const RUN_TS_ENTRY = path.join(REPO_ROOT, "scripts/run-ts.mjs")
export const MOCK_AGENT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "mock-agent.mjs",
)

type TestServerProcess = ChildProcessByStdio<null, Readable, Readable>

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        return reject(new Error("no test port"))
      }
      server.close(error => (error ? reject(error) : resolve(address.port)))
    })
  })
}

function attachLogs(proc: TestServerProcess): () => string {
  let logs = ""
  proc.stdout.on("data", chunk => {
    logs += chunk.toString()
  })
  proc.stderr.on("data", chunk => {
    logs += chunk.toString()
  })
  return () => logs
}

async function waitForExit(proc: TestServerProcess, timeoutMs: number): Promise<void> {
  if (proc.exitCode !== null) return
  await new Promise<void>(resolve => {
    const force = setTimeout(() => resolve(), timeoutMs)
    proc.once("exit", () => {
      clearTimeout(force)
      resolve()
    })
  })
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    /* already gone */
  }
}

export type DurableRuntimeHarness = {
  readonly root: string
  readonly dataDir: string
  readonly workspace: string
  readonly origin: string
  readonly port: number
  api: ApiHandle | null
  startApi(): Promise<ApiHandle>
  startDaemon(): Promise<ApiHandle>
  startSupervisor(): Promise<SupervisorHandle>
  startBrowser(userDataDir?: string, startPath?: string): Promise<BrowserHandle>
  startCompetingApi(): Promise<{
    origin: string
    pid: number
    logs: () => string
    startError?: unknown
    close: () => Promise<void>
  }>
  startServer(options?: ServerOptions): Promise<ApiHandle>
  killApi(signal: NodeJS.Signals): Promise<void>
  killSupervisor(signal: NodeJS.Signals): Promise<void>
  interruptSupervisorSocket(): Promise<void>
  restartApi(): Promise<ApiHandle>
  restartDaemon(): Promise<ApiHandle>
  launchMockAgent(options?: MockAgentOptions): Promise<{
    instance: TerminalInstanceInfo
    agent: MockAgentHandle
    processIdentity: ProcessIdentity
  }>
  readProcessIdentity(pid: number): Promise<ProcessIdentity>
  assertProcessAlive(identity: ProcessIdentity): Promise<void>
  assertProcessDead(identity: ProcessIdentity): Promise<void>
  readDatabaseState(): Promise<DatabaseSnapshot>
  readRuntimeSnapshot(): Promise<RuntimeSnapshot>
  waitForServerEpoch(epoch?: string): Promise<string>
  waitForTerminalSequence(terminalId: string, sequence: number): Promise<void>
  collectResourceMetrics(): Promise<ResourceMetrics>
  retainDiagnostics(outputDir: string): Promise<void>
  close(): Promise<void>
}

export async function createDurableRuntimeHarness(
  options: { env?: Record<string, string> } = {},
): Promise<DurableRuntimeHarness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-runtime-e2e-"))
  const dataDir = path.join(root, "data")
  const workspace = path.join(root, "workspace")
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, "README.md"), "runtime e2e workspace\n")
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const supervisorLog = path.join(dataDir, "supervisor.log")
  const browsers: BrowserHandle[] = []
  let apiProc: TestServerProcess | null = null
  let apiLogs = () => ""
  let apiHandle: ApiHandle | null = null
  let projectId: string | null = null
  let closed = false

  const sharedEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    JET_ALLOWED_ROOTS: `${REPO_ROOT},${root}`,
    YAADE_E2E: "1",
    JET_PTY_SUPERVISOR: "1",
    JET_KILL_PTYS_ON_EXIT: "0",
    JET_STATIC_DIR: path.join(REPO_ROOT, "apps/web/dist"),
    YAADE_PTY_SUPERVISOR_LOG: supervisorLog,
    ...options.env,
  })

  const hostToken = options.env?.YAADE_HOST_TOKEN ?? options.env?.JET_HOST_TOKEN

  const spawnApi = (): TestServerProcess =>
    spawn(
      process.execPath,
      [
        RUN_TS_ENTRY,
        HOST_SERVER_ENTRY,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--data-dir",
        dataDir,
        "--pty-supervisor",
        "1",
        "--kill-ptys-on-exit",
        "0",
        "--allowed-roots",
        `${REPO_ROOT},${root}`,
        ...(hostToken ? ["--token", hostToken] : []),
        workspace,
      ],
      {
        cwd: REPO_ROOT,
        env: sharedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    )

  const extraApis: TestServerProcess[] = []

  const waitForApiDown = async (): Promise<void> => {
    await waitUntil(
      async () => {
        try {
          const response = await fetch(`${origin}/health`)
          return !response.ok
        } catch {
          return true
        }
      },
      8_000,
      "API port to close",
    )
  }

  const startApi = async (): Promise<ApiHandle> => {
    if (apiProc && apiProc.exitCode === null && apiHandle) return apiHandle
    if (apiProc) await waitForApiDown()
    apiProc = spawnApi()
    apiLogs = attachLogs(apiProc)
    await new Promise<void>((resolve, reject) => {
      const proc = apiProc
      if (!proc) {
        reject(new Error("API process missing"))
        return
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        reject(new Error(`API exited during startup (${code ?? signal}): ${apiLogs()}`))
      }
      proc.once("exit", onExit)
      void waitForHttpOk(`${origin}/health`, 30_000).then(
        () => {
          proc.off("exit", onExit)
          resolve()
        },
        error => {
          proc.off("exit", onExit)
          reject(error)
        },
      )
    })
    const pid = apiProc.pid
    if (!pid) throw new Error("API process has no pid")
    const health = await readHealth(origin)
    if (!projectId) {
      const project = await createProject(origin, workspace, hostToken)
      projectId = project.id
    }
    apiHandle = {
      pid,
      port,
      origin,
      dataDir,
      processIdentity: captureProcessIdentity(pid),
      logs: apiLogs,
    }
    harness.api = apiHandle
    return apiHandle
  }

  const killApi = async (signal: NodeJS.Signals): Promise<void> => {
    if (!apiProc?.pid || apiProc.exitCode !== null) {
      apiHandle = null
      harness.api = null
      return
    }
    signalPid(apiProc.pid, signal)
    await waitForExit(apiProc, signal === "SIGKILL" ? 2_000 : 8_000)
    if (apiProc.exitCode === null) signalPid(apiProc.pid, "SIGKILL")
    await waitForExit(apiProc, 2_000)
    apiHandle = null
    harness.api = null
  }

  const startSupervisor = async (): Promise<SupervisorHandle> => {
    if (!apiHandle) await startApi()
    return waitForSupervisor(dataDir)
  }

  const startBrowser = async (userDataDir?: string, startPath = "/"): Promise<BrowserHandle> => {
    if (!apiHandle) {
      try {
        const health = await fetch(`${origin}/health`)
        if (health.ok) {
          apiHandle = {
            pid: 0,
            port,
            origin,
            dataDir,
            processIdentity: null,
            logs: () => "",
          }
          harness.api = apiHandle
        } else {
          await startApi()
        }
      } catch {
        await startApi()
      }
    }
    const browserDir = userDataDir ?? fs.mkdtempSync(path.join(root, "browser-"))
    fs.mkdirSync(browserDir, { recursive: true })
    const context: BrowserContext = await chromium.launchPersistentContext(browserDir, {
      headless: process.env.YAADE_HEADED !== "1",
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "dark",
      serviceWorkers: "block",
    })
    const page: Page = context.pages()[0] ?? (await context.newPage())
    const startUrl = `${origin}${startPath.startsWith("/") ? startPath : `/${startPath}`}`
    await page.goto(startUrl, { waitUntil: "domcontentloaded" })
    await page.waitForFunction(() => window.__yaadeAgent != null, null, { timeout: 30_000 })
    const requestedSession = new URL(startUrl).searchParams.get("s")
    try {
      await page.evaluate(() => window.__yaadeAgent!.waitForReady())
    } catch (error) {
      const dump = await page
        .evaluate(expected => ({
          href: location.href,
          expected,
          activeAttr:
            document
              .querySelector("[data-yaade-session-switcher]")
              ?.getAttribute("data-yaade-active-session") ?? null,
          switcherText:
            document.querySelector("[data-yaade-session-switcher]")?.textContent?.trim() ?? null,
          state: window.__yaadeAgent?.getState?.() ?? null,
        }), requestedSession)
        .catch(() => null)
      throw new Error(`waitForReady failed: ${JSON.stringify(dump)}\n${String(error)}`)
    }
    if (requestedSession) {
      try {
        await page.waitForFunction(
          expected => {
            const attr =
              document
                .querySelector("[data-yaade-session-switcher]")
                ?.getAttribute("data-yaade-active-session") ?? ""
            if (!attr || !expected) return false
            return attr === expected || attr.endsWith(expected.replace(/^ses-/, ""))
          },
          requestedSession,
          { timeout: 30_000 },
        )
      } catch (error) {
        const dump = await page
          .evaluate(expected => {
            const switcher = document.querySelector("[data-yaade-session-switcher]")
            return {
              href: location.href,
              expected,
              activeAttr: switcher?.getAttribute("data-yaade-active-session") ?? null,
              switcherText: switcher?.textContent?.trim() ?? null,
              state: window.__yaadeAgent?.getState?.() ?? null,
            }
          }, requestedSession)
          .catch(() => null)
        throw new Error(
          `browser did not select session ${requestedSession}: ${JSON.stringify(dump)}\n${String(error)}`,
        )
      }
    }
    const handle: BrowserHandle = {
      page,
      context,
      userDataDir: browserDir,
      close: async () => {
        await context.close().catch(() => undefined)
      },
    }
    browsers.push(handle)
    return handle
  }

  const harness: DurableRuntimeHarness = {
    root,
    dataDir,
    workspace,
    origin,
    port,
    api: null,
    startApi,
    startDaemon: startApi,
    startSupervisor,
    startBrowser,
    startCompetingApi: async () => {
      const extraPort = await freePort()
      const extraOrigin = `http://127.0.0.1:${extraPort}`
      const extra = spawn(
        process.execPath,
        [
          RUN_TS_ENTRY,
          HOST_SERVER_ENTRY,
          "--host",
          "127.0.0.1",
          "--port",
          String(extraPort),
          "--data-dir",
          dataDir,
          "--pty-supervisor",
          "1",
          "--kill-ptys-on-exit",
          "0",
          "--allowed-roots",
          `${REPO_ROOT},${root}`,
          workspace,
        ],
        {
          cwd: REPO_ROOT,
          env: sharedEnv(),
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        },
      )
      extraApis.push(extra)
      const extraLogs = attachLogs(extra)
      let startError: unknown
      try {
        await waitForHttpOk(`${extraOrigin}/health`, 20_000)
      } catch (error) {
        startError = error
      }
      return {
        origin: extraOrigin,
        pid: extra.pid ?? -1,
        logs: extraLogs,
        startError,
        close: async () => {
          if (extra.pid && extra.exitCode === null) {
            signalPid(extra.pid, "SIGTERM")
            await waitForExit(extra, 5_000)
            if (extra.exitCode === null) signalPid(extra.pid, "SIGKILL")
          }
        },
      }
    },
    startServer: async () => startApi(),
    killApi,
    killSupervisor: async signal => {
      const supervisor = readSupervisorHandle(dataDir)
      if (!supervisor) return
      signalPid(supervisor.pid, signal)
      await waitUntil(() => !isProcessAlive(supervisor.pid), 8_000, "supervisor exit")
    },
    interruptSupervisorSocket: async () => {
      await dropSupervisorClients(dataDir)
    },
    restartApi: async () => {
      await killApi("SIGTERM")
      return startApi()
    },
    restartDaemon: async () => harness.restartApi(),
    launchMockAgent: async (options = {}) => {
      if (!apiHandle) await startApi()
      if (!projectId) throw new Error("project was not registered")
      const controlFile = path.join(root, `mock-agent-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
      const args = [
        MOCK_AGENT_PATH,
        "--mode",
        options.mode ?? "idle",
        "--control-file",
        controlFile,
        "--identity-file",
        `${controlFile}.identity`,
        ...(options.from != null ? ["--from", String(options.from)] : []),
        ...(options.to != null ? ["--to", String(options.to)] : []),
        ...(options.intervalMs != null ? ["--interval-ms", String(options.intervalMs)] : []),
        ...(options.extraArgs ?? []),
      ]
      const instance = await createTerminalInstance(origin, {
        projectId,
        checkoutPath: workspace,
        checkoutKey: "main",
        title: "mock-agent",
        launchRequestId: `mock-${path.basename(controlFile)}`,
        executable: process.execPath,
        args,
      })
      const agent = await waitForMockAgent(controlFile)
      const processIdentity = await waitForProcessIdentity(agent.pid)
      return { instance, agent, processIdentity }
    },
    readProcessIdentity: pid => waitForProcessIdentity(pid),
    assertProcessAlive,
    assertProcessDead,
    readDatabaseState: async () => readDatabaseState(dataDir),
    readRuntimeSnapshot: async () => {
      const health = await readHealth(origin)
      return {
        identity: health.identity,
        health: health.health,
        port,
      }
    },
    waitForServerEpoch: async epoch => {
      if (epoch) {
        await waitUntil(async () => {
          const health = await readHealth(origin)
          return health.identity.serverEpoch === epoch
        }, 15_000, `serverEpoch ${epoch}`)
        return epoch
      }
      const health = await readHealth(origin)
      return health.identity.serverEpoch
    },
    waitForTerminalSequence: async (terminalId, sequence) => {
      await waitUntil(async () => {
        const attached = await attachTerminal(origin, terminalId)
        return (attached?.lastSequence ?? 0) >= sequence
      }, 20_000, `terminal ${terminalId} sequence ${sequence}`)
    },
    collectResourceMetrics: async () => {
      const usage = process.memoryUsage()
      return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed }
    },
    retainDiagnostics: async outputDir => {
      fs.mkdirSync(outputDir, { recursive: true })
      fs.writeFileSync(path.join(outputDir, "api.log"), apiLogs())
      if (fs.existsSync(supervisorLog)) {
        fs.copyFileSync(supervisorLog, path.join(outputDir, "supervisor.log"))
      }
      for (const name of [
        "runtime.json",
        "pty-supervisor.json",
        "pty-supervisor.pid",
        "jet.sqlite3",
        "jet.sqlite3-wal",
        "jet.sqlite3-shm",
      ]) {
        const source = path.join(dataDir, name)
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(outputDir, name))
      }
      fs.writeFileSync(path.join(outputDir, "process-tree.txt"), readProcessTree())
      fs.writeFileSync(
        path.join(outputDir, "database.json"),
        `${JSON.stringify(readDatabaseState(dataDir), null, 2)}\n`,
      )
    },
    close: async () => {
      if (closed) return
      closed = true
      for (const browser of browsers.reverse()) {
        await browser.close().catch(() => undefined)
      }
      for (const extra of extraApis) {
        if (extra.pid && extra.exitCode === null) {
          signalPid(extra.pid, "SIGTERM")
          await waitForExit(extra, 3_000)
          if (extra.exitCode === null) signalPid(extra.pid, "SIGKILL")
        }
      }
      await killApi("SIGTERM")
      const supervisor = readSupervisorHandle(dataDir)
      if (supervisor && isProcessAlive(supervisor.pid)) {
        signalPid(supervisor.pid, "SIGTERM")
        await waitUntil(() => !isProcessAlive(supervisor.pid), 5_000, "supervisor shutdown").catch(
          () => signalPid(supervisor.pid, "SIGKILL"),
        )
      }
      fs.rmSync(root, { recursive: true, force: true })
    },
  }

  return harness
}

export async function waitForInstance(
  origin: string,
  projectId: string,
  launchRequestId: string,
): Promise<TerminalInstanceInfo> {
  let found: TerminalInstanceInfo | undefined
  await waitUntil(async () => {
    const instances = await listTerminalInstances(origin, projectId)
    found = instances.find(item => item.launchRequestId === launchRequestId)
    return Boolean(found?.ptyId && found.processIdentity)
  }, 15_000, `terminal instance ${launchRequestId}`)
  if (!found) throw new Error(`terminal instance ${launchRequestId} missing`)
  return found
}

export { listSupervisorPtys, attachTerminal, listTerminalInstances, readHealth }
