import type { JetElectronGit } from "@yaade/workspace"

/**
 * The shared mutation seam for Git review surfaces.
 *
 * GitWorkspace and CommitChangesDialog intentionally have different state and
 * presentation, but they must not issue overlapping index/worktree mutations.
 * A queued mutation also gives each adapter one place to invalidate stale
 * reads after a write completes.
 */
type GitReviewApi = Pick<
  JetElectronGit,
  "stage" | "unstage" | "discard" | "applyPatch"
>

export class GitReviewController {
  private mutationTail: Promise<void> = Promise.resolve()
  private requestGeneration = 0

  constructor(
    private readonly api: GitReviewApi,
    private readonly rootUri: string,
  ) {}

  nextRequest(): number {
    return ++this.requestGeneration
  }

  isCurrentRequest(request: number): boolean {
    return request === this.requestGeneration
  }

  invalidateRequests(): void {
    this.requestGeneration += 1
  }

  async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release!: () => void
    const current = new Promise<void>(resolve => {
      release = resolve
    })
    const tail = previous.catch(() => undefined).then(() => current)
    this.mutationTail = tail
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.mutationTail === tail) this.mutationTail = Promise.resolve()
    }
  }

  stage(paths: readonly string[]): Promise<void> {
    return this.mutate(() => this.api.stage(this.rootUri, [...paths]))
  }

  unstage(paths: readonly string[]): Promise<void> {
    return this.mutate(() => this.api.unstage(this.rootUri, [...paths]))
  }

  discard(paths: readonly string[]): Promise<void> {
    return this.mutate(() => this.api.discard(this.rootUri, [...paths]))
  }

  applyPatch(
    patch: string,
    options: { readonly reverse?: boolean; readonly cached?: boolean } = {},
  ): Promise<void> {
    return this.mutate(() => this.api.applyPatch(this.rootUri, patch, options))
  }
}
