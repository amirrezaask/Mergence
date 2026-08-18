#!/usr/bin/env node
/**
 * Production build: Vite SPA → runtime pack → self-extracting server.
 *
 * Output:
 *   apps/yaade/dist                 SPA (intermediate)
 *   dist/runtime/                   unpacked runtime (SEF source)
 *   dist/yaade                      self-extracting server binary
 *   apps/desktop/out/make/*.dmg       macOS DMG (on macOS)
 *
 * Flags:
 *   --server-only   skip the desktop artifact (used by the desktop packaging scripts)
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { packSelfExtracting } from "./pack-sef.mjs"
import { stageRuntimePack } from "./stage-runtime-pack.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runtimeDir = path.join(repoRoot, "dist/runtime")
const sefOut = path.join(repoRoot, "dist/yaade")

const args = new Set(process.argv.slice(2))
const serverOnly = args.has("--server-only")

function run(command, argsList, cwd = repoRoot, env = process.env) {
  const result = spawnSync(command, argsList, {
    cwd,
    stdio: "inherit",
    env,
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run("pnpm", ["--filter", "yaade", "build"])
console.log("Frontend built to apps/yaade/dist")

await stageRuntimePack(runtimeDir)
// Replace legacy directory artifact (old builds wrote dist/yaade/ as a pack).
fs.rmSync(sefOut, { recursive: true, force: true })
// Drop leftover Electron DMGs from older releases.
for (const name of fs.existsSync(path.join(repoRoot, "dist"))
  ? fs.readdirSync(path.join(repoRoot, "dist"))
  : []) {
  if (name.startsWith("YAADE-") && name.endsWith(".dmg")) {
    fs.rmSync(path.join(repoRoot, "dist", name), { force: true })
  }
}
packSelfExtracting(runtimeDir, sefOut)

console.log(`Standalone binary: ${sefOut}`)
console.log(`  ${sefOut}              # serve SPA + API on a loopback ephemeral port`)
console.log(`  ${sefOut} --host 0.0.0.0 # expose the unauthenticated app on the LAN`)
console.log(`  ${sefOut} /path/to/repo  # open workspace at path`)
console.log(`  ${sefOut} --open         # also open the default browser`)

if (process.platform === "darwin" && !serverOnly) {
  console.log("Creating macOS DMG…")
  run("pnpm", ["--filter", "@yaade/desktop", "make:dmg:prepared"])
}
