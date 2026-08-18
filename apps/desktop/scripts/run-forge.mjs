#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const forgeCli = path.join(
  appDir,
  "node_modules",
  "@electron-forge",
  "cli",
  "dist",
  "electron-forge.js",
)

function nodeMajor(candidate) {
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8" })
  if (result.status !== 0) return null
  const match = /^v?(\d+)/.exec(result.stdout.trim())
  return match ? Number(match[1]) : null
}

function nodeBinaryForPlatform(directory) {
  return process.platform === "win32"
    ? path.join(directory, "node.exe")
    : path.join(directory, "bin", "node")
}

function resolveNode22() {
  const explicit = process.env.YAADE_PACKAGER_NODE
  if (explicit && fs.existsSync(explicit) && nodeMajor(explicit) === 22) return explicit

  const nvmVersions = path.join(process.env.NVM_DIR ?? path.join(os.homedir(), ".nvm"), "versions", "node")
  if (fs.existsSync(nvmVersions)) {
    const candidates = fs
      .readdirSync(nvmVersions)
      .filter(name => name.startsWith("v22."))
      .sort()
      .reverse()
      .map(name => nodeBinaryForPlatform(path.join(nvmVersions, name)))
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate
    }
  }

  const commonCandidates = [
    "/opt/homebrew/opt/node@22/bin/node",
    "/usr/local/opt/node@22/bin/node",
  ]
  return commonCandidates.find(candidate => fs.existsSync(candidate)) ?? null
}

if (!fs.existsSync(forgeCli)) {
  console.error(`Electron Forge CLI is missing at ${forgeCli}; run pnpm install first.`)
  process.exit(1)
}

const currentMajor = nodeMajor(process.execPath)
const packagerNode = currentMajor !== null && currentMajor <= 22 ? process.execPath : resolveNode22()
if (!packagerNode) {
  console.error(
    "Electron Forge 7.11.2 must be run with Node 22 LTS on this repository. Install Node 22 or set YAADE_PACKAGER_NODE to its executable.",
  )
  process.exit(1)
}

const result = spawnSync(packagerNode, [forgeCli, ...process.argv.slice(2)], {
  cwd: appDir,
  env: process.env,
  stdio: "inherit",
})
process.exit(result.status ?? 1)
