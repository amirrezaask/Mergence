import { _electron as electron, chromium, type ElectronApplication, type Page } from "@playwright/test"
import { createRequire } from "node:module"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import {
  CreateToolUse,
  MainCheckout,
  ProjectTarget,
  SessionId,
  TerminalToolInput,
} from "../../packages/yaade-rpc/src/tool-session.js"
import { isProcessAlive } from "../../packages/yaade-node-host/src/process-identity.js"
import {
  createProject,
  createSession,
  createToolUse,
  listProjects,
  MOCK_AGENT_PATH,
  waitForMockAgent,
} from "../runtime/harness/index.js"
import { waitUntil } from "../runtime/harness/wait.js"

const require = createRequire(import.meta.url)
const electronBinary = require("electron") as string
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const DESKTOP_APP = path.join(REPO_ROOT, "apps/desktop")

export type DesktopHandle = {
  app: ElectronApplication
  window: Page
  origin: string
  userDataDir: string
  dataDir: string
  workspace: string
  daemonPid: number
}

export function desktopDisplayAvailable(): boolean {
  return process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
}

function readJson(target: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    /* already gone */
  }
}

export function runtimeManifest(userDataDir: string): Record<string, unknown> | null {
  return readJson(path.join(userDataDir, "host", "runtime.json"))
}

export async function stopOwnedRuntime(userDataDir: string): Promise<void> {
  const supervisor = readJson(path.join(userDataDir, "host", "pty-supervisor.json"))
  const runtime = runtimeManifest(userDataDir)
  const supervisorPid = typeof supervisor?.pid === "number" ? supervisor.pid : 0
  const daemonPid = typeof runtime?.pid === "number" ? runtime.pid : 0
  if (supervisorPid > 0) {
    signalPid(supervisorPid, "SIGTERM")
    await waitUntil(() => !isProcessAlive(supervisorPid), 4_000, "supervisor exit").catch(() => undefined)
    signalPid(supervisorPid, "SIGKILL")
  }
  if (daemonPid > 0) {
    signalPid(daemonPid, "SIGTERM")
    await waitUntil(() => !isProcessAlive(daemonPid), 4_000, "daemon exit").catch(() => undefined)
    signalPid(daemonPid, "SIGKILL")
  }
}

export async function closeDesktop(
  handle: DesktopHandle,
  options?: { keepDaemon?: boolean },
): Promise<void> {
  const pid = handle.app.process().pid
  await handle.app.close().catch(() => undefined)
  if (pid && pid > 0) {
    await waitUntil(() => !isProcessAlive(pid), 8_000, "Electron exit").catch(() => undefined)
    signalPid(pid, "SIGKILL")
  }
  if (!options?.keepDaemon) await stopOwnedRuntime(handle.userDataDir)
}

function strippedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith("JET_") || key.startsWith("YAADE_HOST") || key === "VITEST") delete env[key]
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  env.YAADE_REPO_ROOT = REPO_ROOT
  env.YAADE_DESKTOP_USE_DIST = "1"
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = "1"
  env.ELECTRON_ENABLE_LOGGING = "1"
  return env
}

export async function waitForSecondInstanceExit(
  userDataDir: string,
  workspace: string,
): Promise<number> {
  const child = spawn(
    electronBinary,
    [`--user-data-dir=${userDataDir}`, "--no-sandbox", DESKTOP_APP, `--workspace=${workspace}`],
    {
      env: strippedEnv(),
      cwd: REPO_ROOT,
      stdio: "ignore",
    },
  )
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("second Electron instance did not exit"))
    }, 15_000)
    child.once("exit", code => {
      clearTimeout(timer)
      resolve(code ?? 0)
    })
  })
}

export async function launchDesktop(options?: {
  userDataDir?: string
  workspace?: string
  executablePath?: string
  extraArgs?: string[]
}): Promise<DesktopHandle> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yd-"))
  const userDataDir = options?.userDataDir ?? path.join(root, "u")
  const workspace = options?.workspace ?? path.join(root, "w")
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, "README.md"), "desktop e2e workspace\n")
  const executablePath = options?.executablePath ?? electronBinary
  const extraArgs = options?.extraArgs ?? []
  const electronSwitches = [`--user-data-dir=${userDataDir}`, "--no-sandbox"]
  const args = options?.executablePath
    ? [...electronSwitches, `--workspace=${workspace}`, ...extraArgs]
    : [...electronSwitches, DESKTOP_APP, `--workspace=${workspace}`, ...extraArgs]
  const app = await electron.launch({
    executablePath,
    args,
    env: strippedEnv(),
    timeout: 90_000,
    cwd: REPO_ROOT,
  })
  const stderrChunks: string[] = []
  app.process().stderr?.on("data", chunk => {
    stderrChunks.push(String(chunk))
  })
  let window: Page
  try {
    window = await app.firstWindow({ timeout: 90_000 })
  } catch (error) {
    const hostLog = path.join(userDataDir, "host", "host.log")
    const hostText = fs.existsSync(hostLog) ? fs.readFileSync(hostLog, "utf8") : ""
    throw new Error(
      `Electron window did not open.\n${stderrChunks.join("")}\n--- host.log ---\n${hostText}\n${String(error)}`,
    )
  }
  await window.waitForLoadState("domcontentloaded")
  await window.waitForFunction(() => window.__yaadeAgent != null, null, { timeout: 60_000 })
  const dataDir = path.join(userDataDir, "host")
  await waitUntil(() => runtimeManifest(userDataDir) != null, 30_000, "desktop runtime manifest")
  const runtime = runtimeManifest(userDataDir)
  const port = typeof runtime?.port === "number" ? runtime.port : 0
  const daemonPid = typeof runtime?.pid === "number" ? runtime.pid : 0
  if (port <= 0) throw new Error("desktop runtime manifest is missing a port")
  return {
    app,
    window,
    origin: `http://127.0.0.1:${port}`,
    userDataDir,
    dataDir,
    workspace,
    daemonPid,
  }
}

export async function launchMockAgentOnHost(
  origin: string,
  workspace: string,
  controlFile: string,
  title = "mock-agent",
): Promise<{
  sessionId: string
  toolUseId: string
  tabId?: string
  ptyId: string
  agent: Awaited<ReturnType<typeof waitForMockAgent>>
}> {
  let projects = await listProjects(origin)
  if (projects.length === 0) {
    await createProject(origin, workspace)
    projects = await listProjects(origin)
  }
  const project = projects[0]
  if (!project) throw new Error("desktop host has no project")
  const session = await createSession(origin, title)
  const created = await createToolUse(
    origin,
    CreateToolUse.make({
      sessionId: Schema.decodeUnknownSync(SessionId)(session.id),
      kind: "terminal",
      title,
      project: ProjectTarget.make({
        projectId: project.id,
        projectPath: project.rootPath,
        projectName: project.name,
      }),
      checkout: MainCheckout.make({ kind: "main" }),
      input: TerminalToolInput.make({
        kind: "terminal",
        executable: process.execPath,
        shellArgs: [MOCK_AGENT_PATH, "--mode", "idle", "--control-file", controlFile],
      }),
    }),
  )
  const agent = await waitForMockAgent(controlFile)
  const ptyId = created.output.ptyId
  if (!ptyId) throw new Error("desktop mock agent launched without a PTY")
  return {
    sessionId: session.id,
    toolUseId: created.id,
    ...(created.tabId ? { tabId: created.tabId } : {}),
    ptyId,
    agent,
  }
}

export async function openToolInWindow(
  page: Page,
  _origin: string,
  sessionId: string,
  toolUseId: string,
  tabId?: string,
): Promise<void> {
  const url = new URL(page.url())
  url.searchParams.set("s", sessionId)
  if (tabId) url.searchParams.set("t", tabId)
  else url.searchParams.delete("t")
  url.searchParams.set("u", toolUseId)
  await page.goto(url.toString(), { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => window.__yaadeAgent != null, null, { timeout: 30_000 })
}

export async function attachBrowserToOrigin(
  origin: string,
  startPath: string,
): Promise<{ close: () => Promise<void> }> {
  const browser = await chromium.launch({ headless: process.env.YAADE_HEADED !== "1" })
  const page = await browser.newPage()
  await page.goto(`${origin}${startPath}`, { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => window.__yaadeAgent != null, null, { timeout: 30_000 })
  return { close: () => browser.close() }
}

export function findPackagedExecutable(repoRoot = REPO_ROOT): string | null {
  const out = path.join(repoRoot, "apps/desktop/out")
  if (!fs.existsSync(out)) return null
  const visit = (dir: string, depth: number): string | null => {
    if (depth > 6) return null
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".app")) {
          const nested = path.join(full, "Contents/MacOS/yaade")
          if (fs.existsSync(nested)) return nested
        }
        const found = visit(full, depth + 1)
        if (found) return found
      } else if (entry.name === "yaade" || entry.name === "yaade.exe") {
        return full
      }
    }
    return null
  }
  return visit(out, 0)
}

export function processCommandLine(pid: number): string {
  if (process.platform === "linux") {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\u0000/g, " ")
  }
  if (process.platform === "win32") {
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: "utf8" },
    )
  }
  return execFileSync("ps", ["-p", String(pid), "-www", "-o", "command="], { encoding: "utf8" })
}

export type PackagedHandle = {
  pid: number
  origin: string
  userDataDir: string
  dataDir: string
  workspace: string
  daemonPid: number
}

export async function launchPackagedDesktop(executablePath: string): Promise<PackagedHandle> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yd-"))
  const userDataDir = path.join(root, "u")
  const workspace = path.join(root, "w")
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, "README.md"), "desktop e2e workspace\n")
  const child = spawn(
    executablePath,
    [`--user-data-dir=${userDataDir}`, `--workspace=${workspace}`],
    {
      env: strippedEnv(),
      cwd: REPO_ROOT,
      stdio: "ignore",
    },
  )
  const pid = child.pid
  if (!pid) throw new Error("packaged Electron has no pid")
  try {
    await waitUntil(() => runtimeManifest(userDataDir) != null, 60_000, "packaged runtime manifest")
  } catch (error) {
    signalPid(pid, "SIGKILL")
    throw error
  }
  const runtime = runtimeManifest(userDataDir)
  const port = typeof runtime?.port === "number" ? runtime.port : 0
  const daemonPid = typeof runtime?.pid === "number" ? runtime.pid : 0
  if (port <= 0) throw new Error("packaged runtime manifest is missing a port")
  return {
    pid,
    origin: `http://127.0.0.1:${port}`,
    userDataDir,
    dataDir: path.join(userDataDir, "host"),
    workspace,
    daemonPid,
  }
}

export async function closePackagedDesktop(
  handle: PackagedHandle,
  options?: { keepDaemon?: boolean },
): Promise<void> {
  signalPid(handle.pid, "SIGTERM")
  await waitUntil(() => !isProcessAlive(handle.pid), 8_000, "packaged Electron exit").catch(
    () => undefined,
  )
  signalPid(handle.pid, "SIGKILL")
  if (!options?.keepDaemon) await stopOwnedRuntime(handle.userDataDir)
}
