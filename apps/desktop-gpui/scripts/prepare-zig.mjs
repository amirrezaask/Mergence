import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { arch, platform } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const version = "0.14.1"
const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const contextRoot = join(appRoot, ".context", "zig")
const installRoot = join(contextRoot, version)
const executable = join(installRoot, platform() === "win32" ? "zig.exe" : "zig")
const shimsRoot = join(appRoot, ".context", "tool-shims")

if (platform() === "darwin") {
  await mkdir(shimsRoot, { recursive: true })
  const xcrunShim = join(shimsRoot, "xcrun")
  await writeFile(
    xcrunShim,
    `#!/bin/sh
# Zig 0.14 cannot read SDK stubs newer than the release itself. Its bundled
# macOS stubs remain sufficient for the static Ghostty VT build.
for arg in "$@"; do
  [ "$arg" = "--show-sdk-path" ] && exit 1
done
exec /usr/bin/xcrun "$@"
`,
  )
  await chmod(xcrunShim, 0o755)
  const zigShim = join(shimsRoot, "zig")
  await writeFile(
    zigShim,
    `#!/bin/sh
shim_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH="$shim_dir:$PATH" exec "$shim_dir/../zig/${version}/zig" "$@"
`,
  )
  await chmod(zigShim, 0o755)
}

function versionOf(path) {
  const result = spawnSync(path, ["version"], { encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() : null
}

if (versionOf(executable) === version) {
  console.log(executable)
  process.exit(0)
}

const os = { darwin: "macos", linux: "linux", win32: "windows" }[platform()]
const cpu = { arm64: "aarch64", x64: "x86_64" }[arch()]
if (!os || !cpu) throw new Error(`Unsupported Zig host: ${platform()} ${arch()}`)

const index = await fetch("https://ziglang.org/download/index.json").then(response => {
  if (!response.ok) throw new Error(`Could not fetch Zig index: ${response.status}`)
  return response.json()
})
const artifact = index[version]?.[`${cpu}-${os}`]
if (!artifact?.tarball || !artifact?.shasum) throw new Error("Zig download is missing from the signed release index")

await mkdir(contextRoot, { recursive: true })
const archive = join(contextRoot, artifact.tarball.split("/").at(-1))
const bytes = Buffer.from(await fetch(artifact.tarball).then(async response => {
  if (!response.ok) throw new Error(`Could not download Zig: ${response.status}`)
  return response.arrayBuffer()
}))
const digest = createHash("sha256").update(bytes).digest("hex")
if (digest !== artifact.shasum) throw new Error(`Zig checksum mismatch: expected ${artifact.shasum}, got ${digest}`)
await writeFile(archive, bytes)

const staging = `${installRoot}.staging`
await rm(staging, { recursive: true, force: true })
await mkdir(staging, { recursive: true })
const extract = platform() === "win32"
  ? spawnSync("tar", ["-xf", archive, "-C", staging, "--strip-components=1"], { stdio: "inherit" })
  : spawnSync("tar", ["-xf", archive, "-C", staging, "--strip-components=1"], { stdio: "inherit" })
if (extract.status !== 0) throw new Error("Could not extract Zig archive")
await rm(installRoot, { recursive: true, force: true })
await rename(staging, installRoot)
await rm(archive, { force: true })

if (!existsSync(executable) || versionOf(executable) !== version) {
  throw new Error("Prepared Zig executable did not pass its version check")
}
console.log(executable)
