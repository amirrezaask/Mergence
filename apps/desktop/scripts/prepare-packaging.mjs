#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const forgeCorePackage = path.join(
  appDir,
  "node_modules",
  "@electron-forge",
  "core",
  "package.json",
)

if (fs.existsSync(forgeCorePackage)) process.exit(0)

console.log("Preparing a physical Electron Forge dependency tree for packaging…")
const result = spawnSync(
  "pnpm",
  ["install", "--ignore-workspace", "--node-linker=hoisted", "--prefer-offline", "--lockfile=false"],
  { cwd: appDir, stdio: "inherit" },
)
if (result.status !== 0) process.exit(result.status ?? 1)
