import fs from "node:fs/promises"
import path from "node:path"

export type LaunchConfig = {
  workspacePath: string
  filePath?: string
  source?: "default" | "explicit" | "external"
}

export const WORKSPACE_MARKERS = [
  ".git",
  "package.json",
  "tsconfig.json",
  "Cargo.toml",
  "go.mod",
  ".yaade",
] as const

async function markerExists(dir: string, marker: string): Promise<boolean> {
  try {
    const info = await fs.stat(path.join(dir, marker))
    if (marker === ".git") return info.isDirectory()
    return !info.isDirectory()
  } catch {
    return false
  }
}

export async function findWorkspaceRoot(startDir: string): Promise<string> {
  let current = path.resolve(startDir)
  for (let i = 0; i < 20; i++) {
    for (const marker of WORKSPACE_MARKERS) {
      if (await markerExists(current, marker)) return current
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return path.resolve(startDir)
}

export async function resolveLaunchTarget(
  userArgs: string[],
  cwd: string,
  opts?: { defaultCwd?: string },
): Promise<LaunchConfig> {
  const positional = userArgs.filter(a => !a.startsWith("-"))
  const processCwd = path.resolve(cwd)
  const resolvedCwd =
    positional.length === 0 && opts?.defaultCwd
      ? path.resolve(opts.defaultCwd)
      : processCwd

  let targetPath: string
  if (positional.length === 0) {
    targetPath = resolvedCwd
  } else {
    targetPath = path.resolve(processCwd, positional[0]!)
  }

  try {
    const info = await fs.stat(targetPath)
    if (info.isDirectory()) {
      return { workspacePath: targetPath }
    }
    const parentDir = path.dirname(targetPath)
    const workspacePath = await findWorkspaceRoot(parentDir)
    return { workspacePath, filePath: targetPath }
  } catch {
    return { workspacePath: resolvedCwd }
  }
}
