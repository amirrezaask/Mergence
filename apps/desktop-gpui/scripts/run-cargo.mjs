import { spawn, spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const prepare = spawnSync(process.execPath, [join(appRoot, "scripts", "prepare-zig.mjs")], {
  cwd: appRoot,
  encoding: "utf8",
  stdio: ["inherit", "pipe", "inherit"],
})
if (prepare.status !== 0) process.exit(prepare.status ?? 1)
const zig = prepare.stdout.trim().split("\n").at(-1)
if (!zig) throw new Error("Zig preparation did not return an executable")

const zigForBuild = process.platform === "darwin"
  ? join(appRoot, ".context", "tool-shims", "zig")
  : zig
const cargoEnvironment = { ...process.env, ZIG: zigForBuild }

const cargoArguments = process.argv.slice(2)
const rustcArguments = cargoArguments.indexOf("--")
const manifestArguments = ["--manifest-path", join(appRoot, "Cargo.toml")]
if (rustcArguments === -1) cargoArguments.push(...manifestArguments)
else cargoArguments.splice(rustcArguments, 0, ...manifestArguments)

const child = spawn(
  "cargo",
  cargoArguments,
  {
    cwd: appRoot,
    env: cargoEnvironment,
    stdio: "inherit",
  },
)
child.on("exit", code => process.exit(code ?? 1))
