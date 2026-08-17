import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveLaunchTarget, type LaunchConfig } from "@yaade/node-host"
import { pathAllowed } from "./sandbox.js"
import { isLoopbackHostname } from "./security.js"

export type HostConfig = {
  host: string
  port: number
  dataDir: string
  allowedRoots: string[]
  openBrowser: boolean
  launchPath: string
  launchConfig: LaunchConfig
  staticDir: string | null
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--open" || arg === "-o") {
      out.open = true
      continue
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith("--")) {
        out[key] = next
        i++
      } else {
        out[key] = true
      }
      continue
    }
    if (!out.path) out.path = arg
  }
  return out
}

export async function loadConfig(argv = process.argv.slice(2)): Promise<HostConfig> {
  const args = parseArgs(argv)
  const home = os.homedir()
  const host = String(args.host ?? process.env.JET_HOST ?? "127.0.0.1")
  if (!isLoopbackHostname(host)) {
    console.warn(
      `[host-server] WARNING: binding to ${host} exposes the unauthenticated host API on the network`,
    )
  }
  const port = Number(args.port ?? process.env.JET_PORT ?? 4747)
  const dataDir = path.resolve(
    String(args["data-dir"] ?? process.env.JET_DATA_DIR ?? path.join(home, ".local", "share", "jet")),
  )
  const allowedFromEnv = (process.env.JET_ALLOWED_ROOTS ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
  const allowedArg = typeof args["allowed-roots"] === "string" ? args["allowed-roots"].split(",") : []
  const allowedRoots = [...allowedArg, ...allowedFromEnv].map(p => path.resolve(p.trim())).filter(Boolean)
  const homeRoot = path.resolve(home)
  if (allowedRoots.length === 0) allowedRoots.push(homeRoot)

  // Explicit CLI path may live outside $HOME (external volume, etc.).
  // Packaged hosts often start with cwd under the extract cache — that must
  // NOT become the default workspace (it fails PATH_OUTSIDE_ALLOWED_ROOTS).
  const explicitPath =
    typeof args.path === "string" && String(args.path).trim()
      ? path.resolve(String(args.path).trim())
      : null
  const cwd = path.resolve(process.cwd())
  const defaultWorkspace = pathAllowed(cwd, allowedRoots) ? cwd : homeRoot
  const launchPath = explicitPath ?? defaultWorkspace
  let launchConfig = await resolveLaunchTarget(
    explicitPath ? [explicitPath] : [],
    cwd,
    explicitPath ? undefined : { defaultCwd: defaultWorkspace },
  )
  if (!pathAllowed(launchConfig.workspacePath, allowedRoots)) {
    if (explicitPath) {
      allowedRoots.push(path.resolve(launchConfig.workspacePath))
    } else {
      launchConfig = { workspacePath: homeRoot, source: "default" }
    }
  }

  const here = path.dirname(fileURLToPath(import.meta.url))
  const repoDist = path.resolve(here, "../../yaade/dist")
  const staticOverride = args["static-dir"] ?? process.env.JET_STATIC_DIR
  const staticCandidate =
    typeof staticOverride === "string" && staticOverride.trim()
      ? path.resolve(staticOverride.trim())
      : repoDist
  const staticDir = fs.existsSync(staticCandidate) ? staticCandidate : null

  fs.mkdirSync(dataDir, { recursive: true })

  return {
    host,
    port,
    dataDir,
    allowedRoots,
    openBrowser: Boolean(args.open ?? process.env.JET_OPEN_BROWSER === "1"),
    launchPath,
    launchConfig,
    staticDir,
  }
}
