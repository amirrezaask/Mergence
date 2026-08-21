export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict"

export type GitStatusEntry = {
  path: string
  status: GitFileStatus
  originalPath?: string
  /** True when the index contains a change for this path. */
  staged: boolean
  /** True when the working tree contains a change for this path. */
  unstaged: boolean
  indexStatus?: GitFileStatus
  worktreeStatus?: GitFileStatus
}

export type GitRepositorySummary = {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
}

export type GitCommit = {
  hash: string
  shortHash: string
  author: string
  authoredAt: number
  subject: string
}

/** A stable slice of a repository's commit graph. */
export type GitHistoryPage = {
  commits: GitCommit[]
  /** Opaque continuation token, or null when this snapshot is exhausted. */
  nextCursor: string | null
  /** HEAD used to create the cursor; later pages read this same commit graph. */
  snapshotHead: string | null
}

export type GitNumstatEntry = {
  path: string
  /** null when the file is binary (git prints `-` for added/deleted). */
  added: number | null
  deleted: number | null
}

export type GitCommitFile = {
  path: string
  status: GitFileStatus
  originalPath?: string
}

export type GitCommitDetail = {
  hash: string
  subject: string
  body: string
  files: GitCommitFile[]
}

/** One entry from `git worktree list --porcelain`. */
export type GitWorktree = {
  path: string
  head: string | null
  branch: string | null
  bare: boolean
  detached: boolean
  locked: boolean
  prunable: boolean
}
