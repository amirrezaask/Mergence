import fs from "node:fs"
import path from "node:path"
import {
  BranchWorktreeCheckout,
  CheckoutResolutionFailed,
  ExistingWorktreeCheckout,
  MainCheckout,
  ProjectTargetUnavailable,
  type CreateToolUse,
  type ProjectTarget,
  type ResolvedToolContext,
} from "@yaade/rpc"
import { gitWorktreeAdd, gitWorktreeList, gitWorktreeRemove } from "@yaade/node-host"
import { pathToFileUri } from "@yaade/shared"
import type { HostConfig } from "../config.js"
import type { ProjectDatabase } from "../persistence.js"
import { pathAllowed } from "../sandbox.js"
import { resolveWorktreePath } from "../worktree-path.js"

export type ContextResolverDeps = {
  readonly config: HostConfig
  readonly db: ProjectDatabase
  readonly homeDir: string
}

export type ManagedWorktreeCleanupResult = {
  readonly removed: boolean
  readonly reason?: string
}

export async function cleanupManagedWorktree(
  deps: ContextResolverDeps,
  projectId: string,
  checkoutPath: string,
): Promise<ManagedWorktreeCleanupResult> {
  const project = deps.db.project(projectId)
  if (!project) throw new ProjectTargetUnavailable({ projectPath: checkoutPath, message: "project target is unavailable" })
  const canonical = canonicalPath(checkoutPath, "worktree")
  if (!pathAllowed(canonical, deps.config.allowedRoots)) {
    throw new CheckoutResolutionFailed({ message: "worktree is outside allowed roots" })
  }
  const live = deps.db.raw().prepare(
    `SELECT id FROM tool_uses
       WHERE checkout_path=? AND archived_at IS NULL
         AND status IN ('created','starting','running','waiting')
       LIMIT 1`,
  ).get(canonical) as { id: string } | undefined
  if (live) return { removed: false, reason: "checkout is used by a live ToolUse" }
  const trees = await gitWorktreeList(pathToFileUri(project.rootPath))
  const tree = trees.find(candidate => path.resolve(candidate.path) === path.resolve(canonical))
  if (!tree) return { removed: false, reason: "managed worktree is no longer registered" }
  await gitWorktreeRemove(pathToFileUri(project.rootPath), canonical, { force: false })
  return { removed: true }
}

function projectTarget(project: { id: string; rootPath: string; name: string }): ProjectTarget {
  return { projectId: project.id, projectPath: project.rootPath, projectName: project.name }
}

function canonicalPath(value: string, label: string): string {
  try {
    return fs.realpathSync(path.resolve(value))
  } catch {
    throw new CheckoutResolutionFailed({ message: `${label} is unavailable: ${value}` })
  }
}

/** Resolves browser intent; checkout paths are never trusted without git validation. */
export async function resolveToolContext(
  deps: ContextResolverDeps,
  command: CreateToolUse,
): Promise<ResolvedToolContext> {
  const project = deps.db.project(command.project.projectId)
  if (!project || project.rootPath !== command.project.projectPath) {
    throw new ProjectTargetUnavailable({
      projectPath: command.project.projectPath,
      message: "project target is unavailable",
    })
  }
  if (!pathAllowed(project.rootPath, deps.config.allowedRoots)) {
    throw new ProjectTargetUnavailable({
      projectPath: project.rootPath,
      message: "project target is outside allowed roots",
    })
  }
  const projectPath = canonicalPath(project.rootPath, "project")
  const rootUri = pathToFileUri(projectPath)

  if (command.checkout._tag === MainCheckout._tag) {
    return {
      project: projectTarget(project),
      checkoutKey: "main",
      checkoutPath: projectPath,
      checkoutLabel: "Main",
      managedWorktree: false,
    }
  }

  if (command.checkout._tag === ExistingWorktreeCheckout._tag) {
    const checkoutPath = canonicalPath(command.checkout.path, "worktree")
    if (!pathAllowed(checkoutPath, deps.config.allowedRoots)) {
      throw new CheckoutResolutionFailed({ message: "worktree is outside allowed roots" })
    }
    const trees = await gitWorktreeList(rootUri).catch(() => {
      throw new CheckoutResolutionFailed({ message: "could not list project worktrees" })
    })
    const tree = trees.find(tree => path.resolve(tree.path) === path.resolve(checkoutPath))
    if (!tree) {
      throw new CheckoutResolutionFailed({ message: "selected path is not a worktree of this project" })
    }
    return {
      project: projectTarget(project),
      checkoutKey: `worktree:${checkoutPath}`,
      checkoutPath,
      checkoutLabel: tree.branch ? `Worktree · ${tree.branch}` : "Worktree",
      ...(tree.branch ? { branch: tree.branch } : {}),
      managedWorktree: false,
    }
  }

  if (command.checkout._tag === BranchWorktreeCheckout._tag) {
    const checkout = command.checkout
    const trees = await gitWorktreeList(rootUri).catch(() => {
      throw new CheckoutResolutionFailed({ message: "could not list project worktrees" })
    })
    const existing = trees.find(tree => tree.branch === checkout.branch)
    if (existing) {
      const checkoutPath = canonicalPath(existing.path, "branch worktree")
      return {
        project: projectTarget(project),
        checkoutKey: `branch:${checkout.branch}`,
        checkoutPath,
        checkoutLabel: `Worktree · ${checkout.branch}`,
        branch: checkout.branch,
        managedWorktree: false,
      }
    }

    const checkoutPath = resolveWorktreePath({
      homeDir: deps.homeDir,
      projectPath,
      branch: checkout.branch,
    })
    if (!pathAllowed(checkoutPath, deps.config.allowedRoots)) {
      throw new CheckoutResolutionFailed({ message: "managed worktree is outside allowed roots" })
    }
    fs.mkdirSync(path.dirname(checkoutPath), { recursive: true })
    await gitWorktreeAdd(rootUri, checkoutPath, {
      branch: checkout.branch,
      ...(checkout.baseRef ? { baseRef: checkout.baseRef } : {}),
      createBranch: checkout.createBranch,
    }).catch(() => {
      throw new CheckoutResolutionFailed({ message: "could not create branch worktree" })
    })
    return {
      project: projectTarget(project),
      checkoutKey: `branch:${checkout.branch}`,
      checkoutPath: canonicalPath(checkoutPath, "managed worktree"),
      checkoutLabel: `Worktree · ${checkout.branch}`,
      branch: checkout.branch,
      managedWorktree: true,
    }
  }

  throw new CheckoutResolutionFailed({ message: "unsupported checkout target" })
}
