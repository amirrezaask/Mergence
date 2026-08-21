import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  session,
  shell,
} from "electron"
import {
  contentSecurityPolicy,
  externalHttpUrl,
  isAllowedAppUrl,
  workspaceFromArgs,
} from "./policy.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOOPBACK_HOST = "127.0.0.1"
const HOST_ENTRY = path.join("packages", "yaade-host-server", "src", "cli.ts")
const RUN_TS_ENTRY = path.join("scripts", "run-ts.mjs")
const VP_ENTRY = path.join("apps", "web", "node_modules", "vite-plus", "bin", "vp")
const HOISTED_VP_ENTRY = path.join("node_modules", "vite-plus", "bin", "vp")
const CHILD_READY_TIMEOUT_MS = 45_000
const RUNTIME_MANIFEST_FILE = "runtime.json"
// Keep the native overlay aligned with --yaade-tab-bar-height (3.5rem at the
// app's 13px root font size). The renderer owns the visual titlebar; Electron
// only supplies the platform window controls.
const TITLE_BAR_HEIGHT = 46
/** @type {"hidden"} */
const TITLE_BAR_STYLE = "hidden"
const SERVER_DEFINITIONS_FILE = "server-definitions.bin"
const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/

/** @typedef {import("node:child_process").ChildProcess} ChildProcess */
/** @typedef {import("electron").WebContents} WebContents */
/** @typedef {import("electron").BrowserWindow} BrowserWindowInstance */
/** @typedef {{ child: ChildProcess | null, port: number, stop: () => Promise<void> }} ManagedChild */
/** @typedef {{ host: ManagedChild, vite: ManagedChild | null, url: string, origins: string[] }} DesktopServices */

/** @type {BrowserWindowInstance | null} */
let mainWindow = null
/** @type {DesktopServices | null} */
let services = null
/** @type {Promise<void> | null} */
let shutdownPromise = null
let shuttingDown = false
/** @type {Promise<void> | null} */
let bootPromise = null
let recreatingWindow = false

/** @param {number} milliseconds */
function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/** @param {string} candidate */
function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/** @param {import("electron").IpcMainInvokeEvent} event */
function trustedIpcSender(event) {
  return Boolean(mainWindow && event.sender === mainWindow.webContents)
}

/** @param {unknown} value */
function sanitizeServerDefinitions(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const urls = new Set()
  const servers = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue
    const id = typeof candidate.id === "string" ? candidate.id.trim() : ""
    const name = typeof candidate.name === "string" ? candidate.name.trim() : ""
    const rawUrl = typeof candidate.url === "string" ? candidate.url.trim() : ""
    if (!id || !SERVER_ID_PATTERN.test(id) || !name || seen.has(id)) continue
    let url
    try {
      const parsed = new URL(rawUrl)
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      ) continue
      url = `${parsed.protocol}//${parsed.host}`
    } catch {
      continue
    }
    if (urls.has(url)) continue
    const token = typeof candidate.token === "string" ? candidate.token.trim() : ""
    seen.add(id)
    urls.add(url)
    servers.push({ id, name, url, ...(token ? { token } : {}) })
  }
  return servers
}

async function loadServerDefinitions() {
  if (!safeStorage.isEncryptionAvailable()) return []
  try {
    const encoded = await fs.promises.readFile(
      path.join(app.getPath("userData"), SERVER_DEFINITIONS_FILE),
      "utf8",
    )
    const decoded = safeStorage.decryptString(Buffer.from(encoded, "base64"))
    return sanitizeServerDefinitions(JSON.parse(decoded))
  } catch {
    return []
  }
}

/** @param {unknown} value */
async function saveServerDefinitions(value) {
  if (!safeStorage.isEncryptionAvailable()) return
  const servers = sanitizeServerDefinitions(value)
  const userData = app.getPath("userData")
  await fs.promises.mkdir(userData, { recursive: true })
  const target = path.join(userData, SERVER_DEFINITIONS_FILE)
  const temporary = `${target}.${process.pid}.tmp`
  const encrypted = safeStorage.encryptString(JSON.stringify(servers)).toString("base64")
  await fs.promises.writeFile(temporary, encrypted, "utf8")
  await fs.promises.rename(temporary, target)
}

function hostDataDir() {
  return path.join(app.getPath("userData"), "host")
}

/** @param {string} target */
function readJsonFile(target) {
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"))
  } catch {
    return null
  }
}

/**
 * @param {number} pid
 * @param {NodeJS.Signals} signal
 */
function signalPid(pid, signal) {
  if (typeof pid !== "number" || pid <= 0) return
  try {
    process.kill(pid, signal)
  } catch {
    /* already gone */
  }
}

/**
 * @param {number} pid
 * @param {number} timeoutMs
 */
async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await delay(50)
  }
}

async function inspectLocalDaemon() {
  const origin = services ? `http://${LOOPBACK_HOST}:${services.host.port}` : ""
  if (!origin) {
    return { running: false, runningTerminals: 0, origin: "", pid: 0 }
  }
  try {
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_500) })
    if (!response.ok) {
      return { running: false, runningTerminals: 0, origin, pid: 0 }
    }
    const body = await response.json()
    const runningTerminals =
      body && typeof body === "object" && body.health && typeof body.health.runningTerminals === "number"
        ? body.health.runningTerminals
        : 0
    const runtime = readJsonFile(path.join(hostDataDir(), RUNTIME_MANIFEST_FILE))
    return {
      running: true,
      runningTerminals,
      origin,
      pid: typeof runtime?.pid === "number" ? runtime.pid : 0,
    }
  } catch {
    return { running: false, runningTerminals: 0, origin, pid: 0 }
  }
}

async function stopLocalDaemon() {
  const dataDir = hostDataDir()
  const supervisor = readJsonFile(path.join(dataDir, "pty-supervisor.json"))
  const runtime = readJsonFile(path.join(dataDir, RUNTIME_MANIFEST_FILE))
  if (typeof supervisor?.pid === "number") {
    signalPid(supervisor.pid, "SIGTERM")
    await waitForPidExit(supervisor.pid, 4_000)
    signalPid(supervisor.pid, "SIGKILL")
  }
  if (services?.host.child) {
    await services.host.stop()
  } else if (typeof runtime?.pid === "number") {
    signalPid(runtime.pid, "SIGTERM")
    await waitForPidExit(runtime.pid, 4_000)
    signalPid(runtime.pid, "SIGKILL")
  }
}

function installServerStorageIpc() {
  ipcMain.handle("yaade:servers:load", event => {
    if (!trustedIpcSender(event)) return []
    return loadServerDefinitions()
  })
  ipcMain.handle("yaade:servers:save", async (event, value) => {
    if (!trustedIpcSender(event)) throw new Error("untrusted renderer")
    await saveServerDefinitions(value)
  })
  ipcMain.handle("yaade:daemon:inspect", event => {
    if (!trustedIpcSender(event)) throw new Error("untrusted renderer")
    return inspectLocalDaemon()
  })
  ipcMain.handle("yaade:daemon:stop", async event => {
    if (!trustedIpcSender(event)) throw new Error("untrusted renderer")
    await stopLocalDaemon()
  })
}

function resolveNodeBinary() {
  const explicitCandidates = [process.env.YAADE_NODE_BIN, process.env.npm_node_execpath]
    .filter(candidate => candidate !== undefined)
    .map(candidate => path.resolve(candidate))
  for (const candidate of explicitCandidates) {
    if (isFile(candidate)) return candidate
  }

  const executable = process.platform === "win32" ? "node.exe" : "node"
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue
    const candidate = path.join(directory, executable)
    if (isFile(candidate)) return candidate
  }

  // The packaged runtime never reaches this fallback. In development, let
  // spawn resolve `node` when the shell omitted PATH metadata.
  return process.platform === "win32" ? "node.exe" : "node"
}

function resolveRuntimeRoot() {
  if (!app.isPackaged) return null

  const runtimeRoot = path.join(process.resourcesPath, "runtime")
  const nodeBinary =
    process.platform === "win32"
      ? path.join(runtimeRoot, "node", "node.exe")
      : path.join(runtimeRoot, "node", "bin", "node")
  const required = [
    path.join(runtimeRoot, "backend", "host-server.mjs"),
    path.join(runtimeRoot, "web", "index.html"),
    nodeBinary,
  ]
  if (required.every(isFile)) return runtimeRoot

  throw new Error(
    `Packaged YAADE runtime is missing from ${runtimeRoot}. Run vp run build:desktop before packaging.`,
  )
}

/**
 * Do not carry Electron's run-as-node/debug environment into the backend.
 * @param {Record<string, string | undefined>} overrides
 */
function childEnvironment(overrides) {
  const environment = { ...process.env, ...overrides }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.NODE_OPTIONS
  return environment
}

/**
 * @param {ChildProcess} child
 * @param {string} label
 * @param {(line: string) => void} onLine
 */
function observeChildOutput(child, label, onLine) {
  let stdoutRemainder = ""
  /** @param {string} chunk */
  const handleStdout = chunk => {
    stdoutRemainder += String(chunk)
    const lines = stdoutRemainder.split(/\r?\n/)
    stdoutRemainder = lines.pop() ?? ""
    for (const line of lines) {
      onLine(line)
      if (process.env.YAADE_DESKTOP_VERBOSE === "1" && line.trim()) {
        console.log(`[desktop:${label}] ${line}`)
      }
    }
  }

  child.stdout?.setEncoding("utf8")
  child.stdout?.on("data", handleStdout)
  child.stderr?.setEncoding("utf8")
  /** @param {string} chunk */
  child.stderr?.on("data", chunk => {
    if (process.env.YAADE_DESKTOP_VERBOSE === "1") {
      console.error(`[desktop:${label}] ${String(chunk).trimEnd()}`)
    }
  })
}

/**
 * @param {() => string | null} url
 * @param {ChildProcess} child
 * @param {string} label
 */
async function waitForHttp(url, child, label) {
  const deadline = Date.now() + CHILD_READY_TIMEOUT_MS
  let lastError = "not ready"

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label} exited before becoming ready`)
    }

    const target = url()
    if (!target) {
      await delay(100)
      continue
    }

    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await delay(100)
  }

  throw new Error(`Timed out waiting for ${label}: ${lastError}`)
}

/** @param {ChildProcess} child @returns {Promise<void>} */
function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()

  return new Promise(resolve => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(forceTimer)
      child.off("exit", finish)
      resolve()
    }
    const forceTimer = setTimeout(() => {
      if (finished) return
      try {
        child.kill("SIGKILL")
      } catch {
        // The process may have exited between the checks.
      }
      setTimeout(finish, 250)
    }, 2_000)

    child.once("exit", finish)
    try {
      child.kill("SIGTERM")
    } catch {
      finish()
    }
  })
}

/**
 * @param {string} repoRoot
 * @param {string | null} workspace
 */
async function launchHost(repoRoot, workspace) {
  // 0 = OS-assigned ephemeral port. The daemon publishes the bound port in an
  // atomic runtime manifest so Electron never has to parse child stdout.
  const port = 0
  const runtimeRoot = resolveRuntimeRoot()
  const dataDir = path.join(app.getPath("userData"), "host")
  await fs.promises.mkdir(dataDir, { recursive: true })
  const manifestPath = path.join(dataDir, RUNTIME_MANIFEST_FILE)
  try {
    const raw = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"))
    if (
      raw &&
      typeof raw === "object" &&
      raw.host === LOOPBACK_HOST &&
      typeof raw.port === "number" &&
      raw.port > 0
    ) {
      const response = await fetch(`http://${LOOPBACK_HOST}:${raw.port}/health`, {
        signal: AbortSignal.timeout(750),
      })
      if (response.ok) {
        return { child: null, port: raw.port, stop: async () => undefined }
      }
    }
  } catch {
    // A stale or incomplete manifest is replaced by the singleton daemon.
  }

  const args = [
    "--host",
    LOOPBACK_HOST,
    "--port",
    String(port),
    "--data-dir",
    dataDir,
    "--pty-supervisor",
    "1",
    "--kill-ptys-on-exit",
    "0",
  ]
  const allowedRoots = [app.getPath("home"), repoRoot]
  if (workspace) allowedRoots.push(path.resolve(workspace))
  args.push("--allowed-roots", [...new Set(allowedRoots)].join(","))
  let command
  let commandArgs
  let cwd

  if (runtimeRoot) {
    command = path.join(
      runtimeRoot,
      "node",
      process.platform === "win32" ? "node.exe" : "bin/node",
    )
    commandArgs = [
      path.join(runtimeRoot, "backend", "host-server.mjs"),
      ...args,
      "--static-dir",
      path.join(runtimeRoot, "web"),
    ]
    cwd = path.join(runtimeRoot, "backend")
  } else {
    command = resolveNodeBinary()
    commandArgs = [path.join(repoRoot, RUN_TS_ENTRY), path.join(repoRoot, HOST_ENTRY), ...args]
    const webDist = path.join(repoRoot, "apps", "web", "dist")
    if (isFile(path.join(webDist, "index.html"))) {
      commandArgs.push("--static-dir", webDist)
    }
    cwd = repoRoot
  }

  if (workspace) commandArgs.push(workspace)

  const hostLog = fs.openSync(path.join(dataDir, "host.log"), "a")
  const child = spawn(command, commandArgs, {
    cwd,
    env: childEnvironment({
      JET_HOST: LOOPBACK_HOST,
      JET_PORT: String(port),
      JET_DATA_DIR: dataDir,
      JET_SKIP_LOCAL_HOST: "1",
    }),
    detached: true,
    stdio: ["ignore", hostLog, hostLog],
    windowsHide: true,
  })
  fs.closeSync(hostLog)

  const readPort = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
      if (
        raw &&
        typeof raw === "object" &&
        raw.host === LOOPBACK_HOST &&
        typeof raw.port === "number" &&
        raw.port > 0
      ) return raw.port
    } catch {
      // The daemon may still be writing its manifest.
    }
    return 0
  }

  try {
    await waitForHttp(
      () => {
        const observedPort = readPort()
        return observedPort > 0
          ? `http://${LOOPBACK_HOST}:${observedPort}/health`
          : null
      },
      child,
      "host server",
    )
  } catch (error) {
    await stopChild(child)
    throw error
  }

  const observedPort = readPort()
  child.unref()
  return {
    child,
    port: observedPort,
    stop: () => stopChild(child),
  }
}

/**
 * @param {string} repoRoot
 * @param {number} hostPort
 */
async function launchVite(repoRoot, hostPort) {
  const port = 0
  const command = resolveNodeBinary()
  const vpCandidates = [path.join(repoRoot, VP_ENTRY), path.join(repoRoot, HOISTED_VP_ENTRY)]
  const vpEntry = vpCandidates.find(isFile)
  if (!vpEntry) {
    throw new Error(`Vite+ entry is missing; run vp install`)
  }

  const child = spawn(command, [vpEntry, "dev"], {
    cwd: path.join(repoRoot, "apps", "web"),
    env: childEnvironment({
      JET_HOST: LOOPBACK_HOST,
      JET_WEB_HOST: LOOPBACK_HOST,
      JET_WEB_PORT: String(port),
      JET_PORT: String(hostPort),
      JET_PROXY_HOST: LOOPBACK_HOST,
      JET_ALLOWED_HOSTS: "127.0.0.1,localhost",
      JET_SKIP_LOCAL_HOST: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  let observedPort = 0
  observeChildOutput(child, "vite+", line => {
    const match = /Local:\s+http:\/\/[^:]+:(\d+)/.exec(line)
    if (match) observedPort = Number(match[1])
  })

  try {
    await waitForHttp(
      () => (observedPort > 0 ? `http://${LOOPBACK_HOST}:${observedPort}/` : null),
      child,
      "Vite+ server",
    )
  } catch (error) {
    await stopChild(child)
    throw error
  }

  return {
    child,
    port: observedPort,
    stop: () => stopChild(child),
  }
}

/** @param {string} repoRoot */
function useBuiltWeb(repoRoot) {
  if (app.isPackaged) return true
  if (process.env.YAADE_DESKTOP_VITE === "1") return false
  return (
    process.env.YAADE_DESKTOP_USE_DIST === "1" ||
    isFile(path.join(repoRoot, "apps", "web", "dist", "index.html"))
  )
}

/** @param {string | null} workspace */
async function startServices(workspace) {
  const repoRoot = process.env.YAADE_REPO_ROOT ?? path.resolve(__dirname, "../../..")
  const host = await launchHost(repoRoot, workspace)

  if (useBuiltWeb(repoRoot)) {
    const origin = `http://${LOOPBACK_HOST}:${host.port}`
    return { host, vite: null, url: `${origin}/`, origins: [origin] }
  }

  try {
    const vite = await launchVite(repoRoot, host.port)
    const hostOrigin = `http://${LOOPBACK_HOST}:${host.port}`
    const viteOrigin = `http://${LOOPBACK_HOST}:${vite.port}`
    return {
      host,
      vite,
      url: `${viteOrigin}/`,
      origins: [viteOrigin, hostOrigin],
    }
  } catch (error) {
    await host.stop()
    throw error
  }
}

/** @param {readonly string[]} trustedOrigins */
function installSessionSecurity(trustedOrigins) {
  const csp = contentSecurityPolicy(trustedOrigins, !app.isPackaged)
  const defaultSession = session.defaultSession
  defaultSession.setPermissionCheckHandler(() => false)
  defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })

  defaultSession.webRequest.onHeadersReceived(
    { urls: trustedOrigins.map(origin => `${origin}/*`) },
    (details, callback) => {
      if (!isAllowedAppUrl(details.url, trustedOrigins)) {
        callback({ responseHeaders: details.responseHeaders })
        return
      }

      const responseHeaders = { ...details.responseHeaders }
      for (const key of Object.keys(responseHeaders)) {
        if (key.toLowerCase() === "content-security-policy") delete responseHeaders[key]
      }
      responseHeaders["Content-Security-Policy"] = [csp]
      callback({ responseHeaders })
    },
  )
}

/** @param {string} candidate */
function openExternal(candidate) {
  const url = externalHttpUrl(candidate)
  if (!url) return
  void shell.openExternal(url).catch(() => {
    console.warn("The operating system rejected an external URL")
  })
}

/**
 * @param {WebContents} contents
 * @param {readonly string[]} trustedOrigins
 */
function installWebContentsPolicy(contents, trustedOrigins) {
  if (String(contents.getType()) === "devtools") return

  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: "deny" }
  })

  contents.on("will-navigate", (event, url) => {
    if (isAllowedAppUrl(url, trustedOrigins)) return
    event.preventDefault()
    openExternal(url)
  })

  contents.on("will-attach-webview", event => {
    event.preventDefault()
  })

  contents.on("render-process-gone", (_event, details) => {
    console.error(`[desktop] renderer exited: ${details.reason}`)
    if (contents !== mainWindow?.webContents || shuttingDown) return
    recreatingWindow = true
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
  })
}

/** @param {string} url */
function createMainWindow(url) {
  const titleBarOptions =
    process.platform === "darwin"
      ? {
          titleBarStyle: TITLE_BAR_STYLE,
          trafficLightPosition: { x: 16, y: 17 },
        }
      : {
          titleBarStyle: TITLE_BAR_STYLE,
          titleBarOverlay: { height: TITLE_BAR_HEIGHT },
        }

  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    backgroundColor: "#01040a",
    ...titleBarOptions,
    webPreferences: {
      preload: path.join(app.getAppPath(), "src", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  })

  mainWindow = window
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show()
  })
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null
  })
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      console.error(`[desktop] renderer failed to load: ${errorDescription}`)
    },
  )

  // The app-wide web-contents hook is installed before this window is made.
  void window.loadURL(url).catch(error => {
    if (shuttingDown || window.isDestroyed()) return
    const aborted =
      error &&
      typeof error === "object" &&
      "errno" in error &&
      error.errno === -3
    if (aborted) return
    console.error("[desktop] failed to load the local application", error)
    dialog.showErrorBox(
      "YAADE could not open",
      "The local application failed to load. Check the desktop logs and try again.",
    )
    void requestQuit()
  })

  return window
}

/** @param {readonly string[]} trustedOrigins */
function installAppWebContentsHook(trustedOrigins) {
  app.on("web-contents-created", (_event, contents) => {
    installWebContentsPolicy(contents, trustedOrigins)
  })
}

async function stopServices(stopHost = false) {
  const active = services
  services = null
  if (!active) return
  if (active.vite) await active.vite.stop()
  // Closing Electron is a client detach. The daemon and supervisor are
  // deliberately left running; explicit daemon management is separate.
  if (stopHost) await active.host.stop()
}

function requestQuit(stopHost = false) {
  if (shutdownPromise) return shutdownPromise
  shuttingDown = true
  shutdownPromise = stopServices(stopHost)
    .catch(error => {
      console.error("[desktop] service shutdown failed", error)
    })
    .then(() => {
      app.quit()
    })
  return shutdownPromise
}

async function boot() {
  if (bootPromise) return bootPromise
  bootPromise = (async () => {
    await app.whenReady()
    Menu.setApplicationMenu(null)

    const workspace = workspaceFromArgs(process.argv)
    services = await startServices(workspace)
    installSessionSecurity(services.origins)
    installAppWebContentsHook(services.origins)
    installServerStorageIpc()
    createMainWindow(services.url)
    app.on("activate", () => {
      if (shuttingDown || !services) return
      if (!mainWindow || mainWindow.isDestroyed()) createMainWindow(services.url)
    })
  })()
  return bootPromise
}

/** @param {unknown} error */
async function handleBootFailure(error) {
  console.error("[desktop] startup failed", error)
  if (app.isReady()) {
    dialog.showErrorBox(
      "YAADE could not start",
      "The local host could not be started. Run vp run dev:desktop from a checkout or reinstall the desktop app.",
    )
  }
  await requestQuit()
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on("second-instance", (_event, commandLine) => {
    // Validate the argument shape even though an already-running host owns the
    // workspace. Never forward arbitrary second-instance arguments to a shell.
    workspaceFromArgs(commandLine)
    if (!services) return
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow(services.url)
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.on("before-quit", event => {
    if (shuttingDown) return
    event.preventDefault()
    void requestQuit()
  })
  app.on("window-all-closed", () => {
    if (recreatingWindow) {
      recreatingWindow = false
      if (!shuttingDown && services) createMainWindow(services.url)
      return
    }
    void requestQuit()
  })

  void boot().catch(handleBootFailure)
}
