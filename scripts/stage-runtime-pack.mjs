#!/usr/bin/env node
/**
 * Stage a self-contained runtime for the desktop application.
 *
 * The staged runtime contains the web dist, bundled host, native modules, and
 * an ABI-matched Node binary. The standalone server build uses the same
 * backend staging helpers without copying the web application; see
 * stageServerPack below.
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import https from "node:https"
import os from "node:os"
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

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function resolveVpBin() {
  const binName = process.platform === "win32" ? "vp.cmd" : "vp"
  const vpBin = path.join(repoRoot, "node_modules", ".bin", binName)
  if (!fs.existsSync(vpBin)) throw new Error(`Vite+ CLI missing at ${vpBin}; run vp install`)
  return vpBin
}

function packBackendEntry(backendDir, entryPoint, outputName, clean) {
  const generatedName = `${path.basename(entryPoint).replace(/\.[^.]+$/, "")}.mjs`
  const args = [
    "pack",
    entryPoint,
    "--platform",
    "node",
    "--format",
    "esm",
    "--out-dir",
    backendDir,
    "--no-dts",
    "--no-report",
  ]
  if (!clean) args.push("--no-clean")
  run(resolveVpBin(), args)

  const generatedPath = path.join(backendDir, generatedName)
  if (!fs.existsSync(generatedPath)) {
    throw new Error(`Vite+ pack did not produce ${generatedName} for ${entryPoint}`)
  }
  fs.renameSync(generatedPath, path.join(backendDir, outputName))
  console.log(`Bundled ${outputName}`)
}

export async function bundleBackends(
  backendDir,
  entryPoint = path.join(repoRoot, "packages/yaade-host-server/src/cli.ts"),
) {
  fs.rmSync(backendDir, { recursive: true, force: true })
  fs.mkdirSync(backendDir, { recursive: true })

  packBackendEntry(backendDir, entryPoint, "host-server.mjs", true)
}

function writeBackendPackageJson(backendDir) {
  const pkg = {
    name: "yaade-backend-runtime",
    private: true,
    type: "module",
    dependencies: {
      "@ff-labs/fff-node": "^0.9.6",
      "@vscode/ripgrep": "1.18.0",
      "node-pty": "^1.1.0",
    },
  }
  fs.writeFileSync(path.join(backendDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`)
}

function fixPackagedNodePtyPerms(backendDir) {
  const script = path.join(
    repoRoot,
    "packages/yaade-node-host/scripts/fix-node-pty-perms.mjs",
  )
  run("node", [script, backendDir], repoRoot)
}

function installBackendNatives(backendDir) {
  writeBackendPackageJson(backendDir)
  run("npm", ["install", "--omit=dev", "--no-fund", "--no-audit"], backendDir)
  fixPackagedNodePtyPerms(backendDir)

  const rgBinName = process.platform === "win32" ? "rg.exe" : "rg"
  const vscodeMods = path.join(backendDir, "node_modules", "@vscode")
  if (fs.existsSync(vscodeMods)) {
    for (const entry of fs.readdirSync(vscodeMods)) {
      if (!entry.startsWith("ripgrep-")) continue
      const rgBin = path.join(vscodeMods, entry, "bin", rgBinName)
      if (fs.existsSync(rgBin)) fs.chmodSync(rgBin, 0o755)
    }
  }

  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `import { rgPath } from "@vscode/ripgrep";
import fs from "node:fs";
if (!rgPath || !fs.existsSync(rgPath)) {
  console.error("rgPath missing:", rgPath);
  process.exit(1);
}
console.log("rgPath ok:", rgPath);
`,
    ],
    { cwd: backendDir, encoding: "utf8" },
  )
  if (probe.status !== 0) {
    console.error(probe.stderr || probe.stdout)
    throw new Error(
      `Bundled @vscode/ripgrep failed to resolve for ${process.platform}-${process.arch}`,
    )
  }
  process.stdout.write(probe.stdout)
  console.log("Installed backend native deps")
}

function nodePlatformTriple() {
  const platform = process.platform
  const arch = process.arch
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64"
  if (platform === "darwin" && arch === "x64") return "darwin-x64"
  if (platform === "linux" && arch === "arm64") return "linux-arm64"
  if (platform === "linux" && arch === "x64") return "linux-x64"
  throw new Error(`Unsupported Node download target: ${platform}-${arch}`)
}

function nodeBinRelative() {
  return process.platform === "win32" ? "node.exe" : "bin/node"
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    https
      .get(url, res => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close()
          fs.unlinkSync(dest)
          download(res.headers.location, dest).then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`GET ${url} → ${res.statusCode}`))
          return
        }
        res.pipe(file)
        file.on("finish", () => file.close(() => resolve()))
      })
      .on("error", err => {
        try {
          fs.unlinkSync(dest)
        } catch {
          /* ignore */
        }
        reject(err)
      })
  })
}

async function ensureNodeRuntime(packDir, nodeDest) {
  const version = process.version.replace(/^v/, "")
  const triple = nodePlatformTriple()
  const base = `node-v${version}-${triple}`
  const cacheDir = path.join(os.homedir(), ".cache", "yaade-node")
  fs.mkdirSync(cacheDir, { recursive: true })
  const tarball = path.join(cacheDir, `${base}.tar.gz`)
  const url = `https://nodejs.org/dist/v${version}/${base}.tar.gz`

  if (!fs.existsSync(tarball)) {
    console.log(`Downloading Node ${version} (${triple})…`)
    await download(url, tarball)
  } else {
    console.log(`Using cached Node tarball ${tarball}`)
  }

  fs.rmSync(nodeDest, { recursive: true, force: true })
  fs.rmSync(path.join(packDir, base), { recursive: true, force: true })
  run("tar", ["-xzf", tarball, "-C", packDir])
  const extracted = path.join(packDir, base)
  if (!fs.existsSync(extracted)) throw new Error(`Node extract missing: ${extracted}`)
  fs.renameSync(extracted, nodeDest)
  const nodeBin = path.join(nodeDest, nodeBinRelative())
  if (!fs.existsSync(nodeBin)) throw new Error(`node binary missing at ${nodeBin}`)
  fs.chmodSync(nodeBin, 0o755)
  console.log(`Node runtime ready: ${nodeBin}`)
}

function copyWebDist(source, destination) {
  if (!fs.existsSync(path.join(source, "index.html"))) {
    throw new Error(`Frontend dist missing at ${source}; run vp run build:web first`)
  }
  fs.rmSync(destination, { recursive: true, force: true })
  fs.cpSync(source, destination, { recursive: true })
  console.log(`Copied SPA → ${destination}`)
}

function writeLauncherScripts(packDir, { launcherName, includeWeb }) {
  const nodeRel = nodeBinRelative()
  const staticArg = includeWeb ? `  --static-dir "$ROOT/web" \\\n` : ""
  const launcher = `#!/bin/sh
# YAADE — self-contained ${includeWeb ? "desktop runtime" : "server"}
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$ROOT/node/${nodeRel}" "$ROOT/backend/host-server.mjs" \\
${staticArg}  "$@"
`
  const launcherPath = path.join(packDir, launcherName)
  for (const stale of ["yaade", "yaade-server", "yaade-agent"]) {
    if (stale !== launcherName) fs.rmSync(path.join(packDir, stale), { force: true })
  }
  fs.writeFileSync(launcherPath, launcher)
  fs.chmodSync(launcherPath, 0o755)
  console.log(`Launcher: ${launcherPath}`)
}

async function stageBackendPack(packDir, options) {
  const resolved = path.resolve(packDir)
  const backendDir = path.join(resolved, "backend")
  const nodeDest = path.join(resolved, "node")
  const webDest = path.join(resolved, "web")

  fs.mkdirSync(resolved, { recursive: true })
  if (options.webSource) copyWebDist(options.webSource, webDest)
  else fs.rmSync(webDest, { recursive: true, force: true })
  await bundleBackends(backendDir, options.entryPoint)
  installBackendNatives(backendDir)
  await ensureNodeRuntime(resolved, nodeDest)
  writeLauncherScripts(resolved, options)
  console.log(`Runtime pack staged at ${resolved}`)
  return resolved
}

export async function stageRuntimePack(packDir = resolvePackDir()) {
  return stageBackendPack(packDir, {
    launcherName: "yaade",
    includeWeb: true,
    webSource: webSrc,
    entryPoint: path.join(repoRoot, "packages/yaade-host-server/src/cli.ts"),
  })
}

export async function stageServerPack(packDir = path.join(repoRoot, "dist/server-runtime")) {
  return stageBackendPack(packDir, {
    launcherName: "yaade-server",
    includeWeb: false,
    webSource: null,
    entryPoint: path.join(repoRoot, "apps/server/src/index.ts"),
  })
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) await stageRuntimePack()
