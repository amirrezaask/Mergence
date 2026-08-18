#!/usr/bin/env node
/**
 * Stage self-contained YAADE runtime (SPA + bundled host + Node).
 *
 * Default output: dist/runtime/
 *   yaade                  launcher → host-server on an ephemeral port + static SPA
 *   web/                   Vite SPA dist
 *   backend/               esbuild bundles + native deps (node-pty, fff, ripgrep)
 *   node/                  official Node binary (ABI-matched for natives)
 *
 * Override output: YAADE_PACK_DIR or first CLI arg.
 */
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import fs from "node:fs"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const webSrc = path.join(repoRoot, "apps/yaade/dist")

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

function resolveEsbuild() {
  const vitePkg = path.dirname(
    require.resolve("vite/package.json", { paths: [path.join(repoRoot, "apps/yaade")] }),
  )
  return require(require.resolve("esbuild", { paths: [vitePkg] }))
}

async function bundleBackends(backendDir) {
  const esbuild = resolveEsbuild()
  fs.mkdirSync(backendDir, { recursive: true })
  for (const stale of ["host-server.mjs", "agent-server.mjs", "host-server.cjs", "agent-server.cjs"]) {
    fs.rmSync(path.join(backendDir, stale), { force: true })
  }
  // Banner defines `require` before esbuild's __require shim so CJS deps (ws) resolve.
  const banner = {
    js: `import { createRequire as __yaadeCreateRequire } from "node:module";
const require = __yaadeCreateRequire(import.meta.url);
`,
  }
  const common = {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    banner,
    // @vscode/ripgrep must stay external: its JS require.resolve()'s the
    // platform package (@vscode/ripgrep-<os>-<arch>) at runtime.
    external: [
      "node-pty",
      "@ff-labs/fff-node",
      "@ff-labs/fff-node/*",
      "@vscode/ripgrep",
    ],
    logLevel: "warning",
  }
  await esbuild.build({
    ...common,
    entryPoints: [path.join(repoRoot, "apps/host-server/src/bin.ts")],
    outfile: path.join(backendDir, "host-server.mjs"),
  })
  console.log("Bundled host-server.mjs")
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
  // Fresh install against the Node we will ship (system Node during build — same major).
  run("npm", ["install", "--omit=dev", "--no-fund", "--no-audit"], backendDir)
  fixPackagedNodePtyPerms(backendDir)
  // Ensure platform ripgrep binary is executable (tar extract can drop +x).
  const rgBinName = process.platform === "win32" ? "rg.exe" : "rg"
  const vscodeMods = path.join(backendDir, "node_modules", "@vscode")
  if (fs.existsSync(vscodeMods)) {
    for (const entry of fs.readdirSync(vscodeMods)) {
      if (!entry.startsWith("ripgrep-")) continue
      const rgBin = path.join(vscodeMods, entry, "bin", rgBinName)
      if (fs.existsSync(rgBin)) fs.chmodSync(rgBin, 0o755)
    }
  }
  // Fail the build if @vscode/ripgrep cannot resolve its platform binary.
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
  const extractParent = packDir
  fs.rmSync(path.join(extractParent, base), { recursive: true, force: true })
  run("tar", ["-xzf", tarball, "-C", extractParent])
  const extracted = path.join(extractParent, base)
  if (!fs.existsSync(extracted)) {
    throw new Error(`Node extract missing: ${extracted}`)
  }
  fs.renameSync(extracted, nodeDest)
  const nodeBin = path.join(nodeDest, nodeBinRelative())
  if (!fs.existsSync(nodeBin)) throw new Error(`node binary missing at ${nodeBin}`)
  fs.chmodSync(nodeBin, 0o755)
  console.log(`Node runtime ready: ${nodeBin}`)
}

function copyWebDist(webDest) {
  if (!fs.existsSync(path.join(webSrc, "index.html"))) {
    throw new Error(`Frontend dist missing at ${webSrc}; run vite build first`)
  }
  fs.rmSync(webDest, { recursive: true, force: true })
  fs.cpSync(webSrc, webDest, { recursive: true })
  console.log(`Copied SPA → ${webDest}`)
}

function writeLauncherScripts(packDir) {
  const nodeRel = nodeBinRelative()
  const hostLauncher = `#!/bin/sh
# YAADE — self-contained server (release SPA + host API, ephemeral loopback port)
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$ROOT/node/${nodeRel}" "$ROOT/backend/host-server.mjs" \\
  --static-dir "$ROOT/web" \\
  "$@"
`
  const hostPath = path.join(packDir, "yaade")
  // Drop legacy agent launcher; rewrite host launcher fresh.
  fs.rmSync(path.join(packDir, "yaade-agent"), { force: true })
  fs.writeFileSync(hostPath, hostLauncher)
  fs.chmodSync(hostPath, 0o755)
  console.log(`Launchers: ${hostPath}`)
}

export async function stageRuntimePack(packDir = resolvePackDir()) {
  const resolved = path.resolve(packDir)
  const webDest = path.join(resolved, "web")
  const backendDir = path.join(resolved, "backend")
  const nodeDest = path.join(resolved, "node")

  fs.mkdirSync(resolved, { recursive: true })
  copyWebDist(webDest)
  await bundleBackends(backendDir)
  installBackendNatives(backendDir)
  await ensureNodeRuntime(resolved, nodeDest)
  writeLauncherScripts(resolved)
  console.log(`Runtime pack staged at ${resolved}`)
  return resolved
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  await stageRuntimePack()
}
