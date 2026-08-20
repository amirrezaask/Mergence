#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
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

function rebuildMacosAlias(packagerNode) {
  if (process.platform !== "darwin" || process.argv[2] !== "make") return

  const makerDmgDir = fs.realpathSync(
    path.join(appDir, "node_modules", "@electron-forge", "maker-dmg"),
  )
  const makerRequire = createRequire(path.join(makerDmgDir, "package.json"))
  const installerPackage = makerRequire.resolve("electron-installer-dmg/package.json")
  const aliasPackage = createRequire(installerPackage).resolve("macos-alias/package.json")
  const aliasDir = path.dirname(aliasPackage)
  const compatibilityProbe = spawnSync(
    packagerNode,
    ["-e", `require(${JSON.stringify(aliasDir)})`],
    { stdio: "ignore" },
  )
  if (compatibilityProbe.status === 0) return

  const nodeGyp = path.resolve(
    path.dirname(packagerNode),
    "..",
    "lib",
    "node_modules",
    "npm",
    "node_modules",
    "node-gyp",
    "bin",
    "node-gyp.js",
  )

  if (!fs.existsSync(nodeGyp)) {
    throw new Error(
      `Node 22's node-gyp is missing at ${nodeGyp}; install a complete Node 22 LTS distribution.`,
    )
  }

  console.log("Rebuilding macOS DMG native dependencies for Node 22…")
  const result = spawnSync(packagerNode, [nodeGyp, "rebuild"], {
    cwd: aliasDir,
    env: {
      ...process.env,
      NODE: packagerNode,
      npm_node_execpath: packagerNode,
    },
    stdio: "inherit",
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (!fs.existsSync(forgeCli)) {
  console.error(`Electron Forge CLI is missing at ${forgeCli}; run vp install first.`)
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

rebuildMacosAlias(packagerNode)

const result = spawnSync(packagerNode, [forgeCli, ...process.argv.slice(2)], {
  cwd: appDir,
  env: process.env,
  stdio: "inherit",
})
process.exit(result.status ?? 1)
