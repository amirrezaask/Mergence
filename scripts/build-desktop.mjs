#!/usr/bin/env node
/** Build the web runtime and package the standalone desktop application. */
import { spawnSync } from "node:child_process"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { stageRuntimePack } from "./stage-runtime-pack.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const vpBin = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vp.cmd" : "vp",
)
const skipWeb = new Set(process.argv.slice(2)).has("--skip-web")

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (!skipWeb) run(vpBin, ["run", "build:web"])
await stageRuntimePack(path.join(repoRoot, "dist/runtime"))
run(vpBin, ["run", "--filter", "@yaade/desktop", "make"])
