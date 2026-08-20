import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

/** Sanitize a git branch name into a filesystem-safe path segment. */
export function sanitizeBranchSegment(branch: string): string {
  const trimmed = branch.trim()
  if (!trimmed) throw new Error("branch name is required")
  if (trimmed.includes("..") || path.isAbsolute(trimmed)) {
    throw new Error("invalid branch name")
  }
  const sanitized = trimmed
    .replace(/[\\/]+/g, "-")
    .replace(/[^A-Za-z0-9._+-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
  if (!sanitized) throw new Error("invalid branch name")
  return sanitized.slice(0, 80)
}

/** Project folder name used under ~/.yaade/worktrees/<project>/. */
export function projectWorktreeSlug(projectPath: string): string {
  const base = path.basename(path.resolve(projectPath)).trim() || "project"
  const sanitized = base
    .replace(/[^A-Za-z0-9._+-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
  return (sanitized || "project").slice(0, 64)
}

/**
 * Derive a worktree path under `~/.yaade/worktrees/<project>/<branch>/`.
 * On collision with an existing path, suffixes a short hash of the branch.
 */
export function resolveWorktreePath(opts: {
  homeDir: string
  projectPath: string
  branch: string
}): string {
  const project = projectWorktreeSlug(opts.projectPath)
  const branch = sanitizeBranchSegment(opts.branch)
  const baseDir = path.join(opts.homeDir, ".yaade", "worktrees", project)
  const candidate = path.join(baseDir, branch)
  if (!fs.existsSync(candidate)) return candidate
  const hash = createHash("sha1").update(opts.branch).digest("hex").slice(0, 8)
  return path.join(baseDir, `${branch}-${hash}`)
}
