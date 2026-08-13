#!/usr/bin/env node
/**
 * Shared host / Vite spawn helpers for web / packaged SEF runtime.
 * Host always runs under system Node so node-pty stays ABI-safe.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const DEFAULT_HOST = "127.0.0.1"
export const DEFAULT_HOST_PORT = 4747
export const DEFAULT_VITE_PORT = 5174

/**
 * Prefer `startPort` when free; otherwise scan upward.
 * @param {string} host
 * @param {number} startPort
 * @param {{ maxAttempts?: number }} [opts]
 * @returns {Promise<number>}
 */
export function findAvailablePort(host, startPort, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 50
  const preferred = Number(startPort)
  if (!Number.isFinite(preferred) || preferred < 0) {
    return Promise.reject(new Error(`Invalid start port: ${startPort}`))
  }

  function tryListen(port) {
    return new Promise((resolve, reject) => {
      const server = net.createServer()
      server.unref()
      const onError = err => {
        server.close(() => {})
        reject(err)
      }
      server.once("error", onError)
      server.listen(port, host, () => {
        server.off("error", onError)
        const address = server.address()
        const bound =
          address && typeof address === "object" ? address.port : port
        server.close(err => (err ? reject(err) : resolve(bound)))
      })
    })
  }

  return (async () => {
    for (let i = 0; i < maxAttempts; i++) {
      const port = preferred + i
      try {
        return await tryListen(port)
      } catch (err) {
        if (err && typeof err === "object" && err.code === "EADDRINUSE") continue
        throw err
      }
    }
    throw new Error(
      `No free port near ${preferred} on ${host} after ${maxAttempts} attempts`,
    )
  })()
}

export function resolveAppDir(fromMetaUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(fromMetaUrl)), "..")
}

export function resolveRepoRoot(appDir) {
  return path.resolve(appDir, "../..")
}

export function resolveTsxCli(repoRoot) {
  const candidates = [
    process.env.YAADE_TSX_CLI,
    path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  const pnpmDir = path.join(repoRoot, "node_modules/.pnpm")
  if (fs.existsSync(pnpmDir)) {
    for (const name of fs.readdirSync(pnpmDir)) {
      if (!name.startsWith("tsx@")) continue
      const candidate = path.join(pnpmDir, name, "node_modules/tsx/dist/cli.mjs")
      if (fs.existsSync(candidate)) return candidate
    }
  }
  throw new Error("tsx CLI not found; run pnpm install")
}

/**
 * Prefer bundled Node under `runtimeRoot/node` for packaged SEF; else `process.execPath`.
 * @param {{ runtimeRoot?: string }} [opts]
 */
export function resolveNodeBin(opts = {}) {
  const bundled = opts.runtimeRoot
    ? path.join(
        opts.runtimeRoot,
        "node",
        process.platform === "win32" ? "node.exe" : "bin/node",
      )
    : null
  if (bundled && fs.existsSync(bundled)) return bundled
  return process.execPath
}

export function resolveViteBin(appDir) {
  return path.resolve(appDir, "node_modules/.bin/vite")
}

/**
 * Packaged SEF layout:
 *   runtimeRoot/web          SPA dist
 *   runtimeRoot/backend/*.mjs bundled host/agent
 *   runtimeRoot/node/bin/node ABI-matched Node
 * @param {string | undefined} runtimeRoot
 */
export function isPackagedRuntime(runtimeRoot) {
  if (!runtimeRoot) return false
  return (
    fs.existsSync(path.join(runtimeRoot, "backend", "host-server.mjs")) &&
    fs.existsSync(
      path.join(
        runtimeRoot,
        "node",
        process.platform === "win32" ? "node.exe" : "bin/node",
      ),
    )
  )
}

/**
 * @param {{
 *   repoRoot: string
 *   runtimeRoot?: string
 *   port?: number
 *   host?: string
 *   launchPath?: string
 *   watch?: boolean
 *   extraArgs?: string[]
 *   stdio?: import('node:child_process').StdioOptions
 *   env?: NodeJS.ProcessEnv
 * }} opts
 */
export function spawnHostServer(opts) {
  const {
    repoRoot,
    runtimeRoot,
    port = Number(process.env.JET_PORT ?? DEFAULT_HOST_PORT),
    host = process.env.JET_HOST ?? DEFAULT_HOST,
    launchPath,
    watch = false,
    extraArgs = [],
    stdio = "inherit",
    env = process.env,
  } = opts
  const nodeBin = resolveNodeBin({ runtimeRoot })

  if (runtimeRoot && isPackagedRuntime(runtimeRoot)) {
    const backendDir = path.join(runtimeRoot, "backend")
    const entry = path.join(backendDir, "host-server.mjs")
    const webDir = path.join(runtimeRoot, "web")
    const args = [
      entry,
      "--host",
      host,
      "--port",
      String(port),
      "--static-dir",
      webDir,
      ...extraArgs,
    ]
    if (launchPath) args.push(launchPath)
    return spawn(nodeBin, args, {
      cwd: backendDir,
      stdio,
      env: {
        ...env,
        JET_HOST: host,
        JET_PORT: String(port),
        JET_STATIC_DIR: webDir,
      },
    })
  }

  const tsxCli = resolveTsxCli(repoRoot)
  const entry = path.resolve(repoRoot, "apps/host-server/src/bin.ts")
  const args = [
    tsxCli,
    ...(watch ? ["watch"] : []),
    entry,
    "--host",
    host,
    "--port",
    String(port),
    ...extraArgs,
  ]
  if (launchPath) args.push(launchPath)
  return spawn(nodeBin, args, {
    cwd: repoRoot,
    stdio,
    env: {
      ...env,
      JET_HOST: host,
      JET_PORT: String(port),
    },
  })
}

/**
 * @param {{
 *   appDir: string
 *   port?: number
 *   stdio?: import('node:child_process').StdioOptions
 *   env?: NodeJS.ProcessEnv
 * }} opts
 */
export function spawnVite(opts) {
  const {
    appDir,
    port = Number(process.env.JET_WEB_PORT ?? DEFAULT_VITE_PORT),
    stdio = "inherit",
    env = process.env,
  } = opts
  return spawn(resolveViteBin(appDir), [], {
    cwd: appDir,
    stdio,
    env: {
      ...env,
      JET_WEB_PORT: String(port),
    },
  })
}

/**
 * Kill all children on SIGINT/SIGTERM; if any child exits, stop the rest and set exitCode.
 * @param {import('node:child_process').ChildProcess[]} children
 * @param {{ exitProcess?: boolean }} [opts]
 */
export function wireChildLifecycle(children, opts = {}) {
  const { exitProcess = true } = opts
  let stopping = false
  function stop(signal = "SIGTERM") {
    if (stopping) return
    stopping = true
    for (const child of children) {
      try {
        child.kill(signal)
      } catch {
        /* ignore */
      }
    }
  }
  process.on("SIGINT", () => stop("SIGINT"))
  process.on("SIGTERM", () => stop("SIGTERM"))
  for (const child of children) {
    child.on("exit", code => {
      stop()
      if (exitProcess) process.exitCode = code ?? 0
    })
  }
  return { stop }
}

/**
 * @param {string} url
 * @param {{ timeoutMs?: number; intervalMs?: number }} [opts]
 */
export async function waitForUrl(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const intervalMs = opts.intervalMs ?? 200
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status === 404) return
      lastError = new Error(`HTTP ${res.status}`)
    } catch (err) {
      lastError = err
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(
    `Timed out waiting for ${url}${lastError ? `: ${lastError}` : ""}`,
  )
}
