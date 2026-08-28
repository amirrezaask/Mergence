#!/usr/bin/env node
/** Build a self-contained release that serves the API and the web application. */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { packSelfExtracting } from "./pack-sef.mjs"
import { stageRuntimePack } from "./stage-runtime-pack.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runtimeDir = path.join(repoRoot, "dist/runtime")
const output = path.join(repoRoot, "dist/yaade")
const vpBin = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vp.cmd" : "vp",
)
const skipWeb = new Set(process.argv.slice(2)).has("--skip-web")

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (!skipWeb) run(vpBin, ["run", "build:web"])

// `build` publishes one combined executable. Remove artifacts from the
// server-only build so an old binary cannot be mistaken for a release output.
fs.rmSync(path.join(repoRoot, "dist/yaade-server"), { recursive: true, force: true })
fs.rmSync(path.join(repoRoot, "dist/server-runtime"), { recursive: true, force: true })
fs.rmSync(runtimeDir, { recursive: true, force: true })
fs.rmSync(output, { recursive: true, force: true })

await stageRuntimePack(runtimeDir)
packSelfExtracting(runtimeDir, output, {
  launcher: "yaade",
  requireWeb: true,
  cacheName: "yaade",
})
fs.rmSync(runtimeDir, { recursive: true, force: true })
console.log(`Combined release binary: ${output}`)
