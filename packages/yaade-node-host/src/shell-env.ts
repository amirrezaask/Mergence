import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const SYSTEM_DIRS = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin"])

function loginShellPath(): string | null {
  if (process.platform === "win32") return null
  const shell = process.env.SHELL || "/bin/zsh"
  for (const args of [
    ["-ilc", "printenv PATH"],
    ["-lc", "printenv PATH"],
  ] as const) {
    try {
      const out = execFileSync(shell, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }).trim()
      if (out) return out
    } catch {
      /* try next */
    }
  }
  return null
}

function isGuiStrippedPath(value: string): boolean {
  const dirs = value.split(":").filter(Boolean)
  if (dirs.length === 0) return true
  return dirs.every(d => SYSTEM_DIRS.has(d))
}

const USER_BIN_RELS = [".local/bin", ".cargo/bin", "bin", ".opencode/bin"] as const
const SYSTEM_BIN_DIRS = [
  "/usr/sbin",
  "/sbin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
] as const

/**
 * Enrich PATH for GUI-spawned host processes so PTY shells and
 * interactive commands resolve the same binaries as a login terminal.
 *
 * Fully stripped macOS GUI PATHs get a full login-shell rebuild. Partially
 * populated PATHs (e.g. system dirs + /usr/local/bin only) still get missing
 * user bins such as ~/.local/bin are prepended for locally installed commands.
 */
export function enrichProcessPath(): { path: string; enriched: boolean } {
  const current = process.env.PATH ?? ""
  const force = process.env.YAADE_SHELL_ENV_FORCE === "1"
  const fullRebuild = force || isGuiStrippedPath(current)

  const dirs: string[] = []
  const push = (p: string) => {
    if (!p || dirs.includes(p)) return
    dirs.push(p)
  }

  if (fullRebuild) {
    const login = loginShellPath()
    if (login) {
      for (const d of login.split(":")) push(d)
    }
  }

  const home = os.homedir()
  const currentDirs = new Set(current.split(":").filter(Boolean))
  for (const rel of USER_BIN_RELS) {
    const candidate = path.join(home, rel)
    if (!fs.existsSync(candidate)) continue
    if (fullRebuild || !currentDirs.has(candidate)) push(candidate)
  }
  for (const system of SYSTEM_BIN_DIRS) {
    if (!fs.existsSync(system)) continue
    if (fullRebuild || !currentDirs.has(system)) push(system)
  }
  for (const d of current.split(":")) push(d)

  const next =
    dirs.length > 0 ? dirs.join(":") : current || "/usr/bin:/bin:/usr/sbin:/sbin"
  process.env.PATH = next
  return { path: next, enriched: next !== current }
}

/** Call once at host boot before accepting RPC clients. */
export function applyLoginShellEnv(): void {
  enrichProcessPath()
}
