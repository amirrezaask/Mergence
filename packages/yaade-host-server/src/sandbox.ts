import fs from "node:fs"
import path from "node:path"

/** Canonicalize nearest existing ancestor, then check against allowed roots. */
export function pathAllowed(target: string, allowedRoots: string[]): boolean {
  let current = path.resolve(target)
  while (true) {
    try {
      current = fs.realpathSync(current)
      break
    } catch {
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  for (const root of allowedRoots) {
    let realRoot = path.resolve(root)
    try {
      realRoot = fs.realpathSync(realRoot)
    } catch {
      /* keep resolved */
    }
    if (current === realRoot || current.startsWith(realRoot + path.sep)) return true
  }
  return false
}

export function pathStaysWithin(root: string, relativePath: string): string | null {
  if (!relativePath || relativePath.length > 32_768) return null
  if (path.isAbsolute(relativePath)) return null
  const parts = relativePath.split(/[/\\]/)
  if (parts.some(part => part === "..")) return null
  const resolved = path.resolve(root, relativePath)
  const realRoot = (() => {
    try {
      return fs.realpathSync(root)
    } catch {
      return path.resolve(root)
    }
  })()
  if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) return null
  return resolved
}
