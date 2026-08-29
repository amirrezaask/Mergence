#!/usr/bin/env node
/** Stage a self-contained Rust server runtime, optionally with the web dist. */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const webSrc = path.join(repoRoot, "apps/web/dist")

function resolvePackDir() {
  const fromEnv = process.env.YAADE_PACK_DIR
  if (fromEnv?.trim()) return path.resolve(fromEnv.trim())
  const fromArg = process.argv[2]
  if (fromArg?.trim()) return path.resolve(fromArg.trim())
  return path.join(repoRoot, "dist/runtime")
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function copyWebDist(source, destination) {
  if (!fs.existsSync(path.join(source, "index.html"))) {
    throw new Error(`Frontend dist missing at ${source}; run vp run build:web first`)
  }
  fs.cpSync(source, destination, { recursive: true })
  console.log(`Copied SPA → ${destination}`)
}

function buildRustBackend(packDir) {
  run("cargo", [
    "build",
    "--release",
    "--locked",
    "--manifest-path",
    "apps/server/Cargo.toml",
  ])
  const executableName = process.platform === "win32" ? "yaade-server.exe" : "yaade-server"
  const source = path.join(repoRoot, "apps/server/target/release", executableName)
  if (!fs.existsSync(source)) throw new Error(`Rust server binary missing at ${source}`)

  const backendDir = path.join(packDir, "backend")
  fs.mkdirSync(backendDir, { recursive: true })
  const destination = path.join(backendDir, executableName)
  fs.copyFileSync(source, destination)
  fs.chmodSync(destination, 0o755)
  return `backend/${executableName}`
}

function writeLauncher(packDir, { launcherName, includeWeb }, executableRelative) {
  const staticArg = includeWeb ? `  --static-dir "$ROOT/web" \\\n` : ""
  const launcher = `#!/bin/sh
# YAADE — self-contained Rust ${includeWeb ? "runtime" : "server"}
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$ROOT/${executableRelative}" \\
${staticArg}  "$@"
`
  const launcherPath = path.join(packDir, launcherName)
  fs.writeFileSync(launcherPath, launcher)
  fs.chmodSync(launcherPath, 0o755)
  console.log(`Launcher: ${launcherPath}`)
}

async function stageRustPack(packDir, options) {
  const resolved = path.resolve(packDir)
  fs.rmSync(resolved, { recursive: true, force: true })
  fs.mkdirSync(resolved, { recursive: true })
  if (options.webSource) copyWebDist(options.webSource, path.join(resolved, "web"))
  const executable = buildRustBackend(resolved)
  writeLauncher(resolved, options, executable)
  console.log(`Rust runtime pack staged at ${resolved}`)
  return resolved
}

export async function stageRuntimePack(packDir = resolvePackDir()) {
  return stageRustPack(packDir, {
    launcherName: "yaade",
    includeWeb: true,
    webSource: webSrc,
  })
}

export async function stageServerPack(packDir = path.join(repoRoot, "dist/server-runtime")) {
  return stageRustPack(packDir, {
    launcherName: "yaade-server",
    includeWeb: false,
    webSource: null,
  })
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) await stageRuntimePack()
