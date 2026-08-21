import { spawn } from "node:child_process"
import path from "node:path"
import type {
  GitStatusEntry,
  GitFileStatus,
  GitNumstatEntry,
  GitCommitFile,
  GitCommitDetail,
  GitWorktree,
  GitHistoryPage,
} from "./types.js"
import { fileURLToPath } from "node:url"

function uriToPath(uriOrPath: string): string {
  return uriOrPath.startsWith("file://") ? fileURLToPath(uriOrPath) : uriOrPath
}

/** Cap git stdout/stderr so huge diffs never build unbounded strings. */
const MAX_GIT_STDOUT_BYTES = 2 * 1024 * 1024
const MAX_GIT_STDERR_BYTES = 64 * 1024

function appendBounded(current: string, chunk: Buffer, maxBytes: number): string | null {
  if (current.length >= maxBytes) return null
  try {
    const next = current + chunk.toString("utf8")
    return next.length <= maxBytes ? next : null
  } catch {
    return null
  }
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let overflowed = false

    const stopOverflow = (side: "stdout" | "stderr"): void => {
      if (overflowed) return
      overflowed = true
      proc.kill()
      reject(new Error(`git ${side} exceeded ${side === "stdout" ? MAX_GIT_STDOUT_BYTES : MAX_GIT_STDERR_BYTES} bytes`))
    }

    proc.stdout.on("data", (d: Buffer) => {
      if (overflowed) return
      const merged = appendBounded(stdout, d, MAX_GIT_STDOUT_BYTES)
      if (merged === null) {
        stopOverflow("stdout")
        return
      }
      stdout = merged
    })
    proc.stderr.on("data", (d: Buffer) => {
      if (overflowed) return
      const merged = appendBounded(stderr, d, MAX_GIT_STDERR_BYTES)
      if (merged === null) {
        stopOverflow("stderr")
        return
      }
      stderr = merged
    })
    proc.on("close", code => {
      if (overflowed) return
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr || `git exit ${code}`))
    })
    proc.on("error", err => {
      if (overflowed) return
      reject(err)
    })
  })
}

/** Run git feeding `input` on stdin (used by `git apply` for hunk staging). */
function runGitWithStdin(cwd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let overflowed = false

    const stopOverflow = (side: "stdout" | "stderr"): void => {
      if (overflowed) return
      overflowed = true
      proc.kill()
      reject(new Error(`git ${side} exceeded ${side === "stdout" ? MAX_GIT_STDOUT_BYTES : MAX_GIT_STDERR_BYTES} bytes`))
    }

    proc.stdout.on("data", (d: Buffer) => {
      if (overflowed) return
      const merged = appendBounded(stdout, d, MAX_GIT_STDOUT_BYTES)
      if (merged === null) {
        stopOverflow("stdout")
        return
      }
      stdout = merged
    })
    proc.stderr.on("data", (d: Buffer) => {
      if (overflowed) return
      const merged = appendBounded(stderr, d, MAX_GIT_STDERR_BYTES)
      if (merged === null) {
        stopOverflow("stderr")
        return
      }
      stderr = merged
    })
    proc.on("close", code => {
      if (overflowed) return
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr || `git exit ${code}`))
    })
    proc.on("error", err => {
      if (overflowed) return
      reject(err)
    })
    proc.stdin.on("error", () => {
      /* EPIPE if git rejects early; the close handler reports the real error. */
    })
    proc.stdin.end(input)
  })
}

function parseStatus(output: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = []
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    const index = line[0]
    const work = line[1]
    const rest = line.slice(3).trim()
    let filePath = rest
    let originalPath: string | undefined
    if (rest.includes(" -> ")) {
      const parts = rest.split(" -> ")
      originalPath = parts[0]
      filePath = parts[1] ?? rest
    }
    const code = `${index}${work}`
    let status: GitFileStatus = "modified"
    const conflict = code.includes("U") || code === "AA" || code === "DD"
    if (conflict) status = "conflict"
    else if (code === "??") status = "untracked"
    else if (code.includes("A")) status = "added"
    else if (code.includes("D")) status = "deleted"
    else if (code.includes("R")) status = "renamed"
    const staged = index !== " " && index !== "?"
    const unstaged = work !== " " || code === "??"
    entries.push({
      path: filePath,
      status,
      originalPath,
      staged,
      unstaged,
      indexStatus: staged ? statusForChar(index) : undefined,
      worktreeStatus: unstaged ? statusForChar(work) : undefined,
    })
  }
  return entries
}

function statusForChar(code: string): GitFileStatus {
  if (code === "?") return "untracked"
  if (code === "A") return "added"
  if (code === "D") return "deleted"
  if (code === "R") return "renamed"
  if (code === "U") return "conflict"
  return "modified"
}

export async function gitIsRepo(rootUri: string): Promise<boolean> {
  try {
    await runGit(uriToPath(rootUri), ["rev-parse", "--is-inside-work-tree"])
    return true
  } catch {
    return false
  }
}

export async function gitStatus(rootUri: string): Promise<GitStatusEntry[]> {
  const out = await runGit(uriToPath(rootUri), ["status", "--porcelain", "-u"])
  return parseStatus(out)
}

export async function gitDiff(
  rootUri: string,
  opts?: { path?: string; staged?: boolean },
): Promise<string> {
  const args = ["diff"]
  if (opts?.staged) args.push("--cached")
  if (opts?.path) args.push("--", opts.path)
  return runGit(uriToPath(rootUri), args)
}

/** `HEAD` / `INDEX`, or a validated commit-ish (`abc123`, `abc123^`, `abc123~1`). */
export type GitShowRef = "HEAD" | "INDEX" | string

function assertShowRev(rev: string): string {
  if (rev === "HEAD" || rev === "INDEX") return rev
  if (/^[0-9a-fA-F]{4,64}(?:\^|~\d+)?$/.test(rev)) return rev
  throw new Error(`invalid git rev: ${rev}`)
}

/** Read file content at HEAD, the index (`:`), or a commit-ish for diff viewers. */
export async function gitShow(
  rootUri: string,
  path: string,
  ref: GitShowRef,
): Promise<string> {
  const safe = assertShowRev(ref)
  // Prefer `rev:./path` so paths are never ambiguous with revisions.
  const normalized = path.replace(/^\.?\/+/, "")
  const spec =
    safe === "INDEX"
      ? `:${normalized}`
      : safe === "HEAD"
        ? `HEAD:./${normalized}`
        : `${safe}:./${normalized}`
  try {
    return await runGit(uriToPath(rootUri), ["show", "--textconv", spec])
  } catch {
    // Retry without --textconv / ./ for bare trees and odd paths.
    try {
      const fallback =
        safe === "INDEX" ? `:${normalized}` : safe === "HEAD" ? `HEAD:${normalized}` : `${safe}:${normalized}`
      return await runGit(uriToPath(rootUri), ["show", fallback])
    } catch {
      return ""
    }
  }
}

/** Parent vs commit contents for one path in a commit (for side-by-side diffs). */
export async function gitCommitFileContents(
  rootUri: string,
  hash: string,
  file: { path: string; status: string; originalPath?: string },
): Promise<{ original: string; modified: string }> {
  const safe = assertHash(hash)
  const parent = `${safe}^`
  const oldPath = file.originalPath ?? file.path
  if (file.status === "added") {
    return { original: "", modified: await gitShow(rootUri, file.path, safe) }
  }
  if (file.status === "deleted") {
    return { original: await gitShow(rootUri, oldPath, parent), modified: "" }
  }
  const [original, modified] = await Promise.all([
    gitShow(rootUri, oldPath, parent),
    gitShow(rootUri, file.path, safe),
  ])
  return { original, modified }
}

export async function gitBranch(rootUri: string): Promise<string | null> {
  try {
    const out = await runGit(uriToPath(rootUri), ["rev-parse", "--abbrev-ref", "HEAD"])
    const branch = out.trim()
    return branch || null
  } catch {
    return null
  }
}

export async function gitStage(rootUri: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await runGit(uriToPath(rootUri), ["add", "--", ...paths])
}

export async function gitUnstage(rootUri: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await runGit(uriToPath(rootUri), ["restore", "--staged", "--", ...paths])
}

export async function gitCommit(rootUri: string, message: string): Promise<void> {
  await runGit(uriToPath(rootUri), ["commit", "-m", message])
}

export async function gitCommitWithBody(
  rootUri: string,
  summary: string,
  body?: string,
): Promise<void> {
  const args = ["commit", "-m", summary]
  if (body?.trim()) args.push("-m", body.trim())
  await runGit(uriToPath(rootUri), args)
}

export async function gitBranches(rootUri: string): Promise<string[]> {
  const out = await runGit(uriToPath(rootUri), ["branch", "--format=%(refname:short)"])
  return out
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean)
}

export async function gitCheckout(rootUri: string, branch: string): Promise<void> {
  await runGit(uriToPath(rootUri), ["checkout", branch])
}

export async function gitDiscard(rootUri: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await runGit(uriToPath(rootUri), ["restore", "--worktree", "--", ...paths])
}

export async function gitFetch(rootUri: string): Promise<void> {
  await runGit(uriToPath(rootUri), ["fetch"])
}

export async function gitPull(rootUri: string): Promise<void> {
  await runGit(uriToPath(rootUri), ["pull"])
}

export async function gitPush(rootUri: string): Promise<void> {
  await runGit(uriToPath(rootUri), ["push"])
}

export type GitSummary = {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
}

export async function gitSummary(rootUri: string): Promise<GitSummary> {
  const cwd = uriToPath(rootUri)
  const branch = await gitBranch(rootUri)
  let upstream: string | null = null
  try {
    const out = await runGit(cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ])
    const trimmed = out.trim()
    upstream = trimmed || null
  } catch {
    upstream = null
  }
  let ahead = 0
  let behind = 0
  if (upstream) {
    try {
      const counts = await runGit(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])
      const parts = counts.trim().split(/\s+/)
      behind = Number.parseInt(parts[0] ?? "0", 10) || 0
      ahead = Number.parseInt(parts[1] ?? "0", 10) || 0
    } catch {
      /* ignore */
    }
  }
  return { branch, upstream, ahead, behind }
}

export type GitHistoryCommit = {
  hash: string
  shortHash: string
  author: string
  authoredAt: number
  subject: string
}

type HistoryCursor = {
  head: string
  offset: number
}

function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

function decodeHistoryCursor(value: string): HistoryCursor {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      "head" in decoded &&
      "offset" in decoded &&
      typeof decoded.head === "string" &&
      /^[0-9a-f]{40}$/i.test(decoded.head) &&
      typeof decoded.offset === "number" &&
      Number.isSafeInteger(decoded.offset) &&
      decoded.offset >= 0
    ) {
      return { head: decoded.head, offset: decoded.offset }
    }
  } catch {
    // Return the same safe public error for malformed and undecodable cursors.
  }
  throw new Error("invalid git history cursor")
}

function parseGitHistory(output: string): GitHistoryCommit[] {
  const commits: GitHistoryCommit[] = []
  for (const record of output.split("\u001e")) {
    const trimmed = record.trim()
    if (!trimmed) continue
    const fields = trimmed.split("\u001f")
    const hash = fields[0]
    const shortHash = fields[1]
    const author = fields[2]
    if (!hash || !shortHash || !author) continue
    const authoredAt = (Number.parseInt(fields[3] ?? "0", 10) || 0) * 1000
    const subject = fields[4] ?? ""
    commits.push({ hash, shortHash, author, authoredAt, subject })
  }
  return commits
}

/**
 * Read one stable page from the commit graph. The cursor pins subsequent pages
 * to the initial HEAD, so a newly created commit cannot shift or duplicate
 * rows already loaded by a virtualized history view.
 */
export async function gitHistoryPage(
  rootUri: string,
  cursor?: string,
  pageSize = 100,
): Promise<GitHistoryPage> {
  const cwd = uriToPath(rootUri)
  const size = Math.min(Math.max(pageSize, 1), 200)
  let snapshotHead: string
  let offset = 0
  if (cursor) {
    const decoded = decodeHistoryCursor(cursor)
    snapshotHead = decoded.head
    offset = decoded.offset
  } else {
    try {
      snapshotHead = (await runGit(cwd, ["rev-parse", "HEAD"])).trim()
    } catch {
      return { commits: [], nextCursor: null, snapshotHead: null }
    }
  }
  if (!/^[0-9a-f]{40}$/i.test(snapshotHead)) {
    throw new Error("invalid git history snapshot")
  }
  const out = await runGit(cwd, [
    "log",
    snapshotHead,
    `--skip=${offset}`,
    `-n${size}`,
    "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e",
  ])
  const commits = parseGitHistory(out)
  return {
    commits,
    nextCursor: commits.length === size
      ? encodeHistoryCursor({ head: snapshotHead, offset: offset + commits.length })
      : null,
    snapshotHead,
  }
}

export async function gitHistory(rootUri: string, limit = 50): Promise<GitHistoryCommit[]> {
  const capped = Math.min(Math.max(limit, 1), 200)
  return (await gitHistoryPage(rootUri, undefined, capped)).commits
}

/** Resolve a numstat rename path (`old => new`, `dir/{old => new}/f`) to the new path. */
function numstatPath(raw: string): string {
  if (!raw.includes("=>")) return raw
  const brace = raw.match(/^(.*)\{(.*) => (.*)\}(.*)$/)
  if (brace) {
    return `${brace[1] ?? ""}${brace[3] ?? ""}${brace[4] ?? ""}`.replace(/\/{2,}/g, "/")
  }
  const parts = raw.split(" => ")
  return parts[parts.length - 1] ?? raw
}

function sumNullable(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null
  return a + b
}

/** Per-path `+added/-deleted` line counts across the worktree and the index. */
export async function gitNumstat(rootUri: string): Promise<GitNumstatEntry[]> {
  const cwd = uriToPath(rootUri)
  const [unstaged, staged] = await Promise.all([
    runGit(cwd, ["diff", "--numstat"]).catch(() => ""),
    runGit(cwd, ["diff", "--cached", "--numstat"]).catch(() => ""),
  ])
  const map = new Map<string, GitNumstatEntry>()
  const merge = (out: string): void => {
    for (const line of out.split("\n")) {
      if (!line.trim()) continue
      const parts = line.split("\t")
      if (parts.length < 3) continue
      const added = parts[0] === "-" ? null : Number.parseInt(parts[0] ?? "0", 10) || 0
      const deleted = parts[1] === "-" ? null : Number.parseInt(parts[1] ?? "0", 10) || 0
      const path = numstatPath(parts.slice(2).join("\t"))
      const existing = map.get(path)
      if (existing) {
        existing.added = sumNullable(existing.added, added)
        existing.deleted = sumNullable(existing.deleted, deleted)
      } else {
        map.set(path, { path, added, deleted })
      }
    }
  }
  merge(unstaged)
  merge(staged)
  return [...map.values()]
}

function assertHash(hash: string): string {
  if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) throw new Error(`invalid commit hash: ${hash}`)
  return hash
}

function commitFileStatus(code: string): GitFileStatus {
  const c = code[0] ?? ""
  if (c === "A") return "added"
  if (c === "D") return "deleted"
  if (c === "R") return "renamed"
  if (c === "C") return "renamed"
  if (c === "U") return "conflict"
  return "modified"
}

/** Subject/body plus the file list touched by a single commit. */
export async function gitCommitFiles(rootUri: string, hash: string): Promise<GitCommitDetail> {
  const cwd = uriToPath(rootUri)
  const safe = assertHash(hash)
  const [message, nameStatus] = await Promise.all([
    runGit(cwd, ["show", "--no-patch", "--format=%s%x1f%b", safe]),
    runGit(cwd, ["show", "--name-status", "--format=", "-M", safe]),
  ])
  const sep = message.indexOf("\u001f")
  const subject = (sep >= 0 ? message.slice(0, sep) : message).trim()
  const body = (sep >= 0 ? message.slice(sep + 1) : "").trim()
  const files: GitCommitFile[] = []
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue
    const parts = line.split("\t")
    const code = parts[0] ?? ""
    if (!code) continue
    const status = commitFileStatus(code)
    if (code.startsWith("R") || code.startsWith("C")) {
      const originalPath = parts[1]
      const path = parts[2] ?? parts[1] ?? ""
      if (path) files.push({ path, status, originalPath })
    } else {
      const path = parts[1] ?? ""
      if (path) files.push({ path, status })
    }
  }
  return { hash: safe, subject, body, files }
}

/**
 * Apply a unified-diff patch.
 * - `cached: true` (default) → index (`git apply --cached`) for stage/unstage hunks
 * - `cached: false` → worktree for discard hunk (`git apply [--reverse]`)
 */
export async function gitApplyPatch(
  rootUri: string,
  patch: string,
  opts?: { reverse?: boolean; cached?: boolean },
): Promise<void> {
  if (!patch.trim()) return
  const cached = opts?.cached !== false
  const args = ["apply", "--whitespace=nowarn", "--recount"]
  if (cached) args.push("--cached")
  if (opts?.reverse) args.push("--reverse")
  await runGitWithStdin(uriToPath(rootUri), args, patch)
}

function parseWorktreePorcelain(out: string): GitWorktree[] {
  const trees: GitWorktree[] = []
  let current: GitWorktree | null = null
  const flush = (): void => {
    if (current) trees.push(current)
    current = null
  }
  for (const line of out.split("\n")) {
    const trimmed = line.trimEnd()
    if (!trimmed) {
      flush()
      continue
    }
    if (trimmed.startsWith("worktree ")) {
      flush()
      current = {
        path: trimmed.slice("worktree ".length),
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      }
      continue
    }
    if (!current) continue
    if (trimmed.startsWith("HEAD ")) {
      current.head = trimmed.slice("HEAD ".length) || null
    } else if (trimmed.startsWith("branch ")) {
      const ref = trimmed.slice("branch ".length)
      current.branch = ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : ref
    } else if (trimmed === "bare") {
      current.bare = true
    } else if (trimmed === "detached") {
      current.detached = true
    } else if (trimmed.startsWith("locked")) {
      current.locked = true
    } else if (trimmed.startsWith("prunable")) {
      current.prunable = true
    }
  }
  flush()
  return trees
}

export async function gitWorktreeList(rootUri: string): Promise<GitWorktree[]> {
  const out = await runGit(uriToPath(rootUri), ["worktree", "list", "--porcelain"])
  return parseWorktreePorcelain(out)
}

export async function gitWorktreeAdd(
  rootUri: string,
  worktreePath: string,
  opts: { branch: string; baseRef?: string; createBranch?: boolean },
): Promise<GitWorktree> {
  const cwd = uriToPath(rootUri)
  const args = ["worktree", "add"]
  if (opts.createBranch !== false) {
    args.push("-b", opts.branch, worktreePath)
    if (opts.baseRef) args.push(opts.baseRef)
  } else {
    args.push(worktreePath, opts.branch)
  }
  await runGit(cwd, args)
  const trees = await gitWorktreeList(rootUri)
  const match = trees.find(t => path.resolve(t.path) === path.resolve(worktreePath))
  if (match) return match
  return {
    path: worktreePath,
    head: null,
    branch: opts.branch,
    bare: false,
    detached: false,
    locked: false,
    prunable: false,
  }
}

export async function gitWorktreeRemove(
  rootUri: string,
  worktreePath: string,
  opts?: { force?: boolean },
): Promise<void> {
  const args = ["worktree", "remove"]
  if (opts?.force) args.push("--force")
  args.push(worktreePath)
  await runGit(uriToPath(rootUri), args)
}

export async function gitDefaultBranch(rootUri: string): Promise<string | null> {
  const cwd = uriToPath(rootUri)
  try {
    const out = await runGit(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"])
    const ref = out.trim()
    if (ref.startsWith("refs/remotes/origin/")) {
      return ref.slice("refs/remotes/origin/".length) || null
    }
  } catch {
    /* fall through */
  }
  for (const candidate of ["main", "master"]) {
    try {
      await runGit(cwd, ["rev-parse", "--verify", `refs/heads/${candidate}`])
      return candidate
    } catch {
      /* try next */
    }
  }
  return gitBranch(rootUri)
}
