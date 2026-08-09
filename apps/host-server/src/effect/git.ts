import { Context, Effect, Layer } from "effect"
import {
  gitBranch,
  gitBranches,
  gitCheckout,
  gitCommitWithBody,
  gitDefaultBranch,
  gitDiff,
  gitDiscard,
  gitFetch,
  gitHistory,
  gitHistoryPage,
  gitIsRepo,
  gitPull,
  gitPush,
  gitShow,
  gitCommitFileContents,
  gitStage,
  gitStatus,
  gitSummary,
  gitUnstage,
  gitNumstat,
  gitCommitFiles,
  gitApplyPatch,
  gitWorktreeAdd,
  gitWorktreeList,
  gitWorktreeRemove,
  type GitHistoryCommit,
  type GitShowRef,
  type GitSummary,
} from "@yaade/node-host"
import { GitCommandFailedError } from "@yaade/rpc"
import type { GitStatusEntry, GitNumstatEntry, GitCommitDetail, GitHistoryPage, GitWorktree } from "@yaade/shared"

function toGitError(err: unknown): GitCommandFailedError {
  return new GitCommandFailedError({
    message: err instanceof Error ? err.message : String(err),
    cause: err,
  })
}

function tryGit<A>(tryFn: () => Promise<A>): Effect.Effect<A, GitCommandFailedError> {
  return Effect.tryPromise({ try: tryFn, catch: toGitError })
}

export type GitService = {
  readonly isRepo: (rootUri: string) => Effect.Effect<boolean>
  readonly status: (rootUri: string) => Effect.Effect<GitStatusEntry[], GitCommandFailedError>
  readonly diff: (
    rootUri: string,
    opts?: { path?: string; staged?: boolean },
  ) => Effect.Effect<string, GitCommandFailedError>
  readonly show: (
    rootUri: string,
    path: string,
    ref: GitShowRef,
  ) => Effect.Effect<string, GitCommandFailedError>
  readonly commitFileContents: (
    rootUri: string,
    hash: string,
    file: { path: string; status: string; originalPath?: string },
  ) => Effect.Effect<{ original: string; modified: string }, GitCommandFailedError>
  readonly branch: (rootUri: string) => Effect.Effect<string | null>
  readonly summary: (rootUri: string) => Effect.Effect<GitSummary, GitCommandFailedError>
  readonly branches: (rootUri: string) => Effect.Effect<string[], GitCommandFailedError>
  readonly stage: (rootUri: string, paths: string[]) => Effect.Effect<void, GitCommandFailedError>
  readonly unstage: (rootUri: string, paths: string[]) => Effect.Effect<void, GitCommandFailedError>
  readonly discard: (rootUri: string, paths: string[]) => Effect.Effect<void, GitCommandFailedError>
  readonly commit: (
    rootUri: string,
    summary: string,
    body?: string,
  ) => Effect.Effect<void, GitCommandFailedError>
  readonly checkout: (rootUri: string, branch: string) => Effect.Effect<void, GitCommandFailedError>
  readonly fetch: (rootUri: string) => Effect.Effect<void, GitCommandFailedError>
  readonly pull: (rootUri: string) => Effect.Effect<void, GitCommandFailedError>
  readonly push: (rootUri: string) => Effect.Effect<void, GitCommandFailedError>
  readonly history: (
    rootUri: string,
    limit?: number,
  ) => Effect.Effect<GitHistoryCommit[], GitCommandFailedError>
  readonly historyPage: (
    rootUri: string,
    cursor?: string,
    pageSize?: number,
  ) => Effect.Effect<GitHistoryPage, GitCommandFailedError>
  readonly numstat: (rootUri: string) => Effect.Effect<GitNumstatEntry[], GitCommandFailedError>
  readonly commitFiles: (
    rootUri: string,
    hash: string,
  ) => Effect.Effect<GitCommitDetail, GitCommandFailedError>
  readonly applyPatch: (
    rootUri: string,
    patch: string,
    opts?: { reverse?: boolean },
  ) => Effect.Effect<void, GitCommandFailedError>
  readonly worktreeList: (rootUri: string) => Effect.Effect<GitWorktree[], GitCommandFailedError>
  readonly worktreeAdd: (
    rootUri: string,
    worktreePath: string,
    opts: { branch: string; baseRef?: string; createBranch?: boolean },
  ) => Effect.Effect<GitWorktree, GitCommandFailedError>
  readonly worktreeRemove: (
    rootUri: string,
    worktreePath: string,
    opts?: { force?: boolean },
  ) => Effect.Effect<void, GitCommandFailedError>
  readonly defaultBranch: (rootUri: string) => Effect.Effect<string | null>
}

export function makeGitService(): GitService {
  return {
    isRepo: rootUri => Effect.promise(() => gitIsRepo(rootUri)),
    status: rootUri => tryGit(() => gitStatus(rootUri)),
    diff: (rootUri, opts) => tryGit(() => gitDiff(rootUri, opts)),
    show: (rootUri, path, ref) => tryGit(() => gitShow(rootUri, path, ref)),
    commitFileContents: (rootUri, hash, file) =>
      tryGit(() => gitCommitFileContents(rootUri, hash, file)),
    branch: rootUri => Effect.promise(() => gitBranch(rootUri)),
    summary: rootUri => tryGit(() => gitSummary(rootUri)),
    branches: rootUri => tryGit(() => gitBranches(rootUri)),
    stage: (rootUri, paths) => tryGit(() => gitStage(rootUri, paths)),
    unstage: (rootUri, paths) => tryGit(() => gitUnstage(rootUri, paths)),
    discard: (rootUri, paths) => tryGit(() => gitDiscard(rootUri, paths)),
    commit: (rootUri, summary, body) => tryGit(() => gitCommitWithBody(rootUri, summary, body)),
    checkout: (rootUri, branch) => tryGit(() => gitCheckout(rootUri, branch)),
    fetch: rootUri => tryGit(() => gitFetch(rootUri)),
    pull: rootUri => tryGit(() => gitPull(rootUri)),
    push: rootUri => tryGit(() => gitPush(rootUri)),
    history: (rootUri, limit) => tryGit(() => gitHistory(rootUri, limit)),
    historyPage: (rootUri, cursor, pageSize) => tryGit(() => gitHistoryPage(rootUri, cursor, pageSize)),
    numstat: rootUri => tryGit(() => gitNumstat(rootUri)),
    commitFiles: (rootUri, hash) => tryGit(() => gitCommitFiles(rootUri, hash)),
    applyPatch: (rootUri, patch, opts) => tryGit(() => gitApplyPatch(rootUri, patch, opts)),
    worktreeList: rootUri => tryGit(() => gitWorktreeList(rootUri)),
    worktreeAdd: (rootUri, worktreePath, opts) =>
      tryGit(() => gitWorktreeAdd(rootUri, worktreePath, opts)),
    worktreeRemove: (rootUri, worktreePath, opts) =>
      tryGit(() => gitWorktreeRemove(rootUri, worktreePath, opts)),
    defaultBranch: rootUri => Effect.promise(() => gitDefaultBranch(rootUri)),
  }
}

export class GitServiceTag extends Context.Tag("yaade/GitService")<
  GitServiceTag,
  GitService
>() {}

export const GitServiceLive: Layer.Layer<GitServiceTag> = Layer.succeed(
  GitServiceTag,
  makeGitService(),
)
