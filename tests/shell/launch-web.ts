import { chromium } from "@playwright/test"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { wrapPlaywrightPage } from "./playwright-driver.js"
import type { LaunchShellResult } from "./driver.js"

const REPO_ROOT = path.resolve(__dirname, "../..")
const HOST_SERVER_ENTRY = path.join(REPO_ROOT, "apps/host-server/src/bin.ts")

function resolveTsxCli(): string {
  const candidates = [
    process.env.YAADE_TSX_CLI,
    path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs"),
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  const pnpmDir = path.join(REPO_ROOT, "node_modules/.pnpm")
  if (fs.existsSync(pnpmDir)) {
    for (const name of fs.readdirSync(pnpmDir)) {
      if (!name.startsWith("tsx@")) continue
      const candidate = path.join(pnpmDir, name, "node_modules/tsx/dist/cli.mjs")
      if (fs.existsSync(candidate)) return candidate
    }
  }
  throw new Error(`tsx CLI missing; run pnpm install from repo root`)
}

type LaunchWebOptions = {
  workspaceRel?: string
  env?: Record<string, string>
  userDataDir?: string
  launchWithoutWorkspace?: boolean
  /** Allow AppRoot to stop at its actionable route error screen. */
  expectBootError?: boolean
  /** Browser pathname to open (e.g. `/dev/consultation`). Defaults to the launch project's canonical route. */
  startPath?: string
  /**
   * When set, host `HOME` is this directory so URL paths resolve under it.
   * Defaults to a temp dir under the e2e root when `startPath` is non-root.
   */
  homeDir?: string
  /** Narrow allowlist for tests that intentionally request an HTTP error. */
  expectedHttpErrors?: Array<{
    method: string
    path: string
    status: number
  }>
}

type BrowserFailure = {
  kind: "console" | "pageerror" | "requestfailed" | "http"
  message: string
  url?: string
  method?: string
  status?: number
  navigationRelated?: boolean
}

const EXPECTED_BROWSER_MESSAGES = [
  /^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)\.?$/,
]

function urlPathname(value: string | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value).pathname
  } catch {
    return null
  }
}

function isExpectedBrowserFailure(
  failure: BrowserFailure,
  expectedHttpErrors: LaunchWebOptions["expectedHttpErrors"],
): boolean {
  const firstLine = failure.message.split("\n", 1)[0]?.replace(/^Error: /, "") ?? ""
  if (EXPECTED_BROWSER_MESSAGES.some(pattern => pattern.test(firstLine))) return true
  if (
    failure.kind === "pageerror" &&
    firstLine === "Canceled: Canceled" &&
    failure.message.includes("/assets/monaco-")
  ) {
    return true
  }
  if (
    failure.kind === "requestfailed" &&
    failure.navigationRelated === true &&
    failure.message === "net::ERR_ABORTED"
  ) {
    return true
  }
  const path = urlPathname(failure.url)
  if (!path) return false
  return (expectedHttpErrors ?? []).some(expected => {
    if (expected.path !== path) return false
    if (failure.kind === "http") {
      return expected.method === failure.method && expected.status === failure.status
    }
    if (failure.kind !== "console" || !failure.message.startsWith("Failed to load resource:")) {
      return false
    }
    return failure.message.includes(String(expected.status))
  })
}

function formatBrowserFailure(failure: BrowserFailure): string {
  const request = failure.method ? ` ${failure.method}` : ""
  const status = failure.status == null ? "" : ` ${failure.status}`
  const url = failure.url ? ` ${failure.url}` : ""
  return `[${failure.kind}]${request}${status}${url}: ${failure.message}`
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("no test port"))
      server.close(error => (error ? reject(error) : resolve(address.port)))
    })
  })
}

async function waitForHttpOk(url: string, proc: ChildProcessWithoutNullStreams, logs: () => string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`process exited (${proc.exitCode})\n${logs()}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      /* startup */
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${url}\n${logs()}`)
}

function attachLogs(proc: ChildProcessWithoutNullStreams): () => string {
  let logs = ""
  proc.stdout.on("data", chunk => {
    logs += chunk.toString()
  })
  proc.stderr.on("data", chunk => {
    logs += chunk.toString()
  })
  return () => logs
}

async function killProc(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.exitCode !== null) return
  proc.kill("SIGTERM")
  await new Promise<void>(resolve => {
    const force = setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL")
    }, 1_000)
    proc.once("exit", () => {
      clearTimeout(force)
      resolve()
    })
    setTimeout(resolve, 2_500)
  })
  if (proc.exitCode === null) proc.kill("SIGKILL")
}

export async function launchWeb(options: LaunchWebOptions = {}): Promise<LaunchShellResult> {
  const port = await freePort()
  const temporaryRoot = options.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "jet-web-e2e-"))
  const browserData = path.join(temporaryRoot, "browser")
  const serverData = path.join(temporaryRoot, "server")
  fs.mkdirSync(browserData, { recursive: true })
  fs.mkdirSync(serverData, { recursive: true })
  const sourceWorkspace = path.resolve(REPO_ROOT, options.workspaceRel ?? "fixtures/sample-workspace")
  const isFixture = sourceWorkspace.startsWith(path.join(REPO_ROOT, "fixtures") + path.sep)
  const workspace = isFixture
    ? path.join(temporaryRoot, path.basename(sourceWorkspace))
    : sourceWorkspace
  if (isFixture && !fs.existsSync(workspace)) fs.cpSync(sourceWorkspace, workspace, { recursive: true })
  if (!fs.existsSync(HOST_SERVER_ENTRY)) {
    throw new Error(`Host server entry missing at ${HOST_SERVER_ENTRY}`)
  }
  const tsxCli = resolveTsxCli()

  const sharedEnv = {
    ...process.env,
    JET_ALLOWED_ROOTS: `${REPO_ROOT},${temporaryRoot},${path.dirname(sourceWorkspace)}`,
    YAADE_E2E: "1",
    // Installed YAADE may export JET_STATIC_DIR; e2e must serve the repo build.
    JET_STATIC_DIR: path.join(REPO_ROOT, "apps/yaade/dist"),
    ...options.env,
  }

  const homeDir =
    options.homeDir ??
    (options.startPath && options.startPath !== "/"
      ? path.join(temporaryRoot, "home")
      : undefined)
  if (homeDir) {
    fs.mkdirSync(homeDir, { recursive: true })
    sharedEnv.HOME = homeDir
    sharedEnv.JET_ALLOWED_ROOTS = `${sharedEnv.JET_ALLOWED_ROOTS},${homeDir}`
  }

  const server = spawn(
    process.execPath,
    [
      tsxCli,
      HOST_SERVER_ENTRY,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--data-dir",
      serverData,
      ...(options.launchWithoutWorkspace ? [] : [workspace]),
    ],
    {
      cwd: REPO_ROOT,
      env: sharedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ) as ChildProcessWithoutNullStreams
  const jetLogs = attachLogs(server)
  const url = `http://127.0.0.1:${port}`
  await waitForHttpOk(`${url}/health`, server, jetLogs)

  let defaultStartPath = "/"
  if (options.startPath == null && !options.launchWithoutWorkspace) {
    const response = await fetch(`${url}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ rootPath: workspace }),
    })
    if (!response.ok) {
      throw new Error(`could not register E2E launch project (${response.status})`)
    }
    const project = (await response.json()) as { id: string }
    defaultStartPath = `/_project/${encodeURIComponent(project.id)}`
  }

  const context = await chromium.launchPersistentContext(browserData, {
    headless: process.env.YAADE_HEADED !== "1",
    ...(process.env.YAADE_PLAYWRIGHT_CHANNEL
      ? { channel: process.env.YAADE_PLAYWRIGHT_CHANNEL }
      : {}),
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
  })
  const browserPage = context.pages()[0] ?? (await context.newPage())
  const browserFailures: BrowserFailure[] = []
  let lastMainFrameNavigationAt = 0
  browserPage.on("pageerror", error => {
    browserFailures.push({
      kind: "pageerror",
      message: error.stack ?? error.message,
    })
  })
  browserPage.on("console", message => {
    if (message.type() === "error") {
      const location = message.location()
      browserFailures.push({
        kind: "console",
        message: message.text(),
        url: location.url || undefined,
      })
    }
  })
  browserPage.on("request", request => {
    if (request.isNavigationRequest() && request.frame() === browserPage.mainFrame()) {
      lastMainFrameNavigationAt = Date.now()
    }
  })
  browserPage.on("requestfailed", request => {
    browserFailures.push({
      kind: "requestfailed",
      message: request.failure()?.errorText ?? "request failed",
      url: request.url(),
      method: request.method(),
      navigationRelated: Date.now() - lastMainFrameNavigationAt < 1_000,
    })
  })
  browserPage.on("response", response => {
    if (response.status() < 400) return
    browserFailures.push({
      kind: "http",
      message: response.statusText(),
      url: response.url(),
      method: response.request().method(),
      status: response.status(),
    })
  })

  const startPath = options.startPath ?? defaultStartPath
  const startUrl = `${url}${startPath.startsWith("/") ? startPath : `/${startPath}`}`
  await browserPage.goto(startUrl, { waitUntil: "domcontentloaded" })
  if (options.expectBootError) {
    await browserPage.waitForSelector('[data-yaade-boot="error"]', {
      state: "visible",
      timeout: 30_000,
    })
  } else {
    await browserPage.waitForFunction(() => window.__yaadeAgent != null, null, { timeout: 30_000 })
    await browserPage.evaluate(() => window.__yaadeAgent!.waitForReady())
    if (!options.launchWithoutWorkspace) {
      await browserPage.waitForFunction(
        () => (window.__yaadeAgent?.listWorkspaces().length ?? 0) > 0,
        null,
        { timeout: 30_000 },
      )
    }
  }

  return {
    page: wrapPlaywrightPage(browserPage),
    app: {
      async close() {
        // Ignore request aborts caused by teardown itself, but only after
        // preserving every failure observed while the application was live.
        const failuresBeforeTeardown = [...browserFailures]
        await context.close().catch(() => {})
        await killProc(server)
        const unexpected = failuresBeforeTeardown.filter(
          failure => !isExpectedBrowserFailure(failure, options.expectedHttpErrors),
        )
        if (unexpected.length > 0) {
          throw new Error(
            `Unexpected browser failures:\n${unexpected.map(formatBrowserFailure).join("\n")}`,
          )
        }
      },
    },
    homeDir: homeDir ?? process.env.HOME ?? os.homedir(),
    baseUrl: url,
  }
}
