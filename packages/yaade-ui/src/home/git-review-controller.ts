import type {
  GitCommit,
  GitHistoryPage,
  GitNumstatEntry,
  GitRepositorySummary,
  GitStatusEntry,
} from "@yaade/shared"

export type GitReviewMutationApi = {
  readonly stage: (rootUri: string, paths: string[]) => Promise<void>
  readonly unstage: (rootUri: string, paths: string[]) => Promise<void>
  readonly discard: (rootUri: string, paths: string[]) => Promise<void>
  readonly applyPatch: (
    rootUri: string,
    patch: string,
    options?: { readonly reverse?: boolean; readonly cached?: boolean },
  ) => Promise<void>
}

type GitReviewReadApi = {
  readonly isRepo: (rootUri: string) => Promise<boolean>
  readonly status: (rootUri: string) => Promise<GitStatusEntry[]>
  readonly summary: (rootUri: string) => Promise<GitRepositorySummary>
  readonly branches: (rootUri: string) => Promise<string[]>
  readonly numstat: (rootUri: string) => Promise<GitNumstatEntry[]>
  readonly historyPage: (
    rootUri: string,
    cursor?: string,
    pageSize?: number,
  ) => Promise<GitHistoryPage>
}

export type GitReviewApi = GitReviewMutationApi & Partial<GitReviewReadApi>

export type GitReviewSelection = {
  readonly path: string
  readonly staged: boolean
}

export type GitReviewState = {
  readonly rootUri: string
  readonly loading: boolean
  readonly isRepo: boolean | null
  readonly entries: readonly GitStatusEntry[]
  readonly summary: GitRepositorySummary
  readonly branches: readonly string[]
  readonly numstat: ReadonlyMap<string, GitNumstatEntry>
  readonly history: readonly GitCommit[]
  readonly historyCursor: string | null
  readonly historyLoading: boolean
  readonly error: string | null
  readonly selected: GitReviewSelection | null
}

const EMPTY_SUMMARY: GitRepositorySummary = {
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
}
const EMPTY_NUMSTAT: GitNumstatEntry[] = []

function initialState(rootUri: string): GitReviewState {
  return {
    rootUri,
    loading: false,
    isRepo: null,
    entries: [],
    summary: EMPTY_SUMMARY,
    branches: [],
    numstat: new Map(),
    history: [],
    historyCursor: null,
    historyLoading: false,
    error: null,
    selected: null,
  }
}

function appendHistory(
  current: readonly GitCommit[],
  next: readonly GitCommit[],
): GitCommit[] {
  const seen = new Set(current.map(commit => commit.hash))
  return [...current, ...next.filter(commit => !seen.has(commit.hash))]
}

/**
 * Deep per-repository review session.
 *
 * React surfaces are adapters: they subscribe to this state, issue intent
 * methods, and do not each implement their own request invalidation or Git
 * mutation queue. A controller can be shared by GitWorkspace and its commit
 * dialog, while tests exercise the same interface with an in-memory adapter.
 */
export class GitReviewController {
  private mutationTail: Promise<void> = Promise.resolve()
  private requestGeneration = 0
  private historyRequestGeneration = 0
  private state: GitReviewState
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly api: GitReviewApi,
    private readonly rootUri: string,
  ) {
    this.state = initialState(rootUri)
  }

  getSnapshot = (): GitReviewState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  nextRequest(): number {
    return ++this.requestGeneration
  }

  isCurrentRequest(request: number): boolean {
    return request === this.requestGeneration
  }

  invalidateRequests(): void {
    this.requestGeneration += 1
    this.historyRequestGeneration += 1
  }

  select(selection: GitReviewSelection | null): void {
    this.update({ selected: selection })
  }

  async refresh(): Promise<void> {
    const reader = this.readApi()
    const request = this.nextRequest()
    this.update({ loading: true, error: null })
    try {
      const isRepo = await reader.isRepo(this.rootUri)
      if (!this.isCurrentRequest(request)) return
      if (!isRepo) {
        this.update({
          isRepo: false,
          entries: [],
          branches: [],
          history: [],
          historyCursor: null,
          numstat: new Map(),
          loading: false,
        })
        return
      }
      const [entries, summary, branches, numstat, historyPage] =
        await Promise.all([
          reader.status(this.rootUri),
          reader.summary(this.rootUri),
          reader.branches(this.rootUri),
          reader.numstat(this.rootUri).catch(() => EMPTY_NUMSTAT),
          reader.historyPage(this.rootUri, undefined, 100),
        ])
      if (!this.isCurrentRequest(request)) return
      this.update({
        isRepo: true,
        entries,
        summary,
        branches,
        numstat: new Map(numstat.map(entry => [entry.path, entry])),
        history: historyPage.commits,
        historyCursor: historyPage.nextCursor,
        loading: false,
      })
    } catch (error) {
      if (!this.isCurrentRequest(request)) return
      this.update({ loading: false, error: errorMessage(error) })
      throw error
    }
  }

  async loadHistoryPage(cursor: string | null, reset = false): Promise<void> {
    const reader = this.readApi()
    const request = ++this.historyRequestGeneration
    this.update({ historyLoading: true, ...(reset ? { error: null } : {}) })
    try {
      const page = await reader.historyPage(
        this.rootUri,
        cursor ?? undefined,
        100,
      )
      if (request !== this.historyRequestGeneration) return
      this.update({
        history: reset ? page.commits : appendHistory(this.state.history, page.commits),
        historyCursor: page.nextCursor,
        historyLoading: false,
      })
    } catch (error) {
      if (request !== this.historyRequestGeneration) return
      this.update({ historyLoading: false, error: errorMessage(error) })
      throw error
    }
  }

  async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release: (() => void) | undefined
    const current = new Promise<void>(resolve => {
      release = resolve
    })
    const tail = previous.catch(() => undefined).then(() => current)
    this.mutationTail = tail
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release?.()
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

  private readApi(): GitReviewReadApi {
    if (
      !this.api.isRepo ||
      !this.api.status ||
      !this.api.summary ||
      !this.api.branches ||
      !this.api.numstat ||
      !this.api.historyPage
    ) {
      throw new Error("Git review reads are unavailable")
    }
    return {
      isRepo: this.api.isRepo,
      status: this.api.status,
      summary: this.api.summary,
      branches: this.api.branches,
      numstat: this.api.numstat,
      historyPage: this.api.historyPage,
    }
  }

  private update(patch: Partial<GitReviewState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
