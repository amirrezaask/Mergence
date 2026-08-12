import type { ProjectSearchOptions, ProjectSearchResult } from "@yaade/shared"
import { pathToFileUri } from "@yaade/shared"

export type ProjectSearchEntry = {
  id: string
  /** Absolute checkout root used for search, snippets, and result opens. */
  checkoutPath: string
  checkoutKey: string
  query: string
  options: ProjectSearchOptions
  results: ProjectSearchResult[]
  truncated: boolean
  nextCursor: string | null
  loading: boolean
  loadingMore: boolean
  error: string | null
  createdAt: number
  updatedAt: number
}

type ProjectBucket = {
  entries: Map<string, ProjectSearchEntry>
  order: string[]
  controllers: Map<string, AbortController>
  timers: Map<string, ReturnType<typeof setTimeout>>
  generations: Map<string, number>
  /** Stable snapshot for useSyncExternalStore getSnapshot. */
  listSnapshot: ProjectSearchEntry[]
  /** Bumps whenever any entry content changes (for per-entry getSnapshot). */
  revision: number
}

const buckets = new Map<string, ProjectBucket>()
const listeners = new Set<() => void>()

const SEARCH_DEBOUNCE_MS = 120
const SEARCH_PAGE_LIMIT = 500
const EMPTY_LIST: ProjectSearchEntry[] = []

function notify(): void {
  for (const listener of listeners) listener()
}

function refreshListSnapshot(bucket: ProjectBucket): void {
  bucket.revision += 1
  bucket.listSnapshot = bucket.order.map(id => {
    const entry = bucket.entries.get(id)!
    return {
      ...entry,
      options: { ...entry.options },
      results: entry.results.slice(),
    }
  })
}

function bucketFor(projectPath: string): ProjectBucket {
  let bucket = buckets.get(projectPath)
  if (!bucket) {
    bucket = {
      entries: new Map(),
      order: [],
      controllers: new Map(),
      timers: new Map(),
      generations: new Map(),
      listSnapshot: EMPTY_LIST,
      revision: 0,
    }
    buckets.set(projectPath, bucket)
  }
  return bucket
}

function allocSearchId(): string {
  return `srch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function subscribeProjectSearches(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => {
    listeners.delete(onStoreChange)
  }
}

export function listProjectSearches(projectPath: string): readonly ProjectSearchEntry[] {
  const bucket = buckets.get(projectPath)
  if (!bucket) return EMPTY_LIST
  return bucket.listSnapshot
}

export type PersistedProjectSearchEntry = Pick<
  ProjectSearchEntry,
  "id" | "query" | "options" | "checkoutPath" | "checkoutKey"
>

export function restoreProjectSearches(
  projectPath: string,
  entries: readonly PersistedProjectSearchEntry[],
): void {
  if (listProjectSearches(projectPath).length > 0) return
  for (const entry of entries.slice().reverse()) {
    createProjectSearch(projectPath, entry)
  }
}

export function getProjectSearch(
  projectPath: string,
  searchId: string,
): ProjectSearchEntry | null {
  const bucket = buckets.get(projectPath)
  if (!bucket) return null
  return bucket.listSnapshot.find(entry => entry.id === searchId) ?? null
}

export function getProjectSearchRevision(projectPath: string): number {
  return buckets.get(projectPath)?.revision ?? 0
}

export function createProjectSearch(
  projectPath: string,
  input: {
    id?: string
    checkoutPath?: string
    checkoutKey?: string
    query?: string
    options?: ProjectSearchOptions
  } = {},
): ProjectSearchEntry {
  const bucket = bucketFor(projectPath)
  const now = Date.now()
  const entry: ProjectSearchEntry = {
    id: input.id ?? allocSearchId(),
    checkoutPath: input.checkoutPath ?? projectPath,
    checkoutKey: input.checkoutKey ?? "main",
    query: input.query ?? "",
    options: { ...input.options },
    results: [],
    truncated: false,
    nextCursor: null,
    loading: false,
    loadingMore: false,
    error: null,
    createdAt: now,
    updatedAt: now,
  }
  bucket.entries.set(entry.id, entry)
  bucket.order = [entry.id, ...bucket.order]
  refreshListSnapshot(bucket)
  notify()
  if (entry.query.trim()) {
    const generation = 1
    bucket.generations.set(entry.id, generation)
    void runSearch(projectPath, entry.id, generation, "replace")
  }
  return entry
}

function abortEntry(bucket: ProjectBucket, searchId: string): void {
  const timer = bucket.timers.get(searchId)
  if (timer) {
    clearTimeout(timer)
    bucket.timers.delete(searchId)
  }
  const controller = bucket.controllers.get(searchId)
  if (controller) {
    controller.abort()
    bucket.controllers.delete(searchId)
  }
}

export function removeProjectSearch(projectPath: string, searchId: string): void {
  const bucket = buckets.get(projectPath)
  if (!bucket) return
  abortEntry(bucket, searchId)
  bucket.entries.delete(searchId)
  bucket.order = bucket.order.filter(id => id !== searchId)
  bucket.generations.delete(searchId)
  refreshListSnapshot(bucket)
  notify()
}

async function runSearch(
  projectPath: string,
  searchId: string,
  generation: number,
  mode: "replace" | "append",
): Promise<void> {
  const bucket = buckets.get(projectPath)
  const entry = bucket?.entries.get(searchId)
  if (!bucket || !entry) return

  const query = entry.query.trim()
  if (!query) {
    entry.results = []
    entry.truncated = false
    entry.nextCursor = null
    entry.loading = false
    entry.loadingMore = false
    entry.error = null
    entry.updatedAt = Date.now()
    refreshListSnapshot(bucket)
    notify()
    return
  }

  const search = window.yaade?.search
  if (!search?.project) {
    entry.loading = false
    entry.loadingMore = false
    entry.error = "Search is unavailable"
    entry.updatedAt = Date.now()
    refreshListSnapshot(bucket)
    notify()
    return
  }

  if (mode === "replace") abortEntry(bucket, searchId)
  const controller = new AbortController()
  bucket.controllers.set(searchId, controller)
  if (mode === "replace") {
    entry.loading = true
    entry.loadingMore = false
    entry.error = null
  } else {
    entry.loadingMore = true
    entry.error = null
  }
  entry.updatedAt = Date.now()
  refreshListSnapshot(bucket)
  notify()

  try {
    const pageOrItems = await search.project(
      pathToFileUri(entry.checkoutPath),
      query,
      {
        ...entry.options,
        limit: SEARCH_PAGE_LIMIT,
        ...(mode === "append"
          ? { cursor: entry.nextCursor ?? String(entry.results.length) }
          : {}),
      },
      controller.signal,
    )
    if ((bucket.generations.get(searchId) ?? 0) !== generation) return
    if (controller.signal.aborted) return
    const page = Array.isArray(pageOrItems)
      ? { items: pageOrItems, truncated: false, nextCursor: undefined }
      : pageOrItems
    const current = bucket.entries.get(searchId)
    if (!current) return
    current.results =
      mode === "append"
        ? appendUniqueResults(current.results, page.items)
        : page.items
    current.truncated = page.truncated
    current.nextCursor = page.nextCursor ?? null
    current.loading = false
    current.loadingMore = false
    current.error = null
    current.updatedAt = Date.now()
    refreshListSnapshot(bucket)
    notify()
  } catch (error) {
    if (controller.signal.aborted) return
    if ((bucket.generations.get(searchId) ?? 0) !== generation) return
    const current = bucket.entries.get(searchId)
    if (!current) return
    current.loading = false
    current.loadingMore = false
    current.error = error instanceof Error ? error.message : String(error)
    current.updatedAt = Date.now()
    refreshListSnapshot(bucket)
    notify()
  } finally {
    if (bucket.controllers.get(searchId) === controller) {
      bucket.controllers.delete(searchId)
    }
  }
}

export function updateProjectSearch(
  projectPath: string,
  searchId: string,
  patch: {
    query?: string
    options?: ProjectSearchOptions
    checkoutPath?: string
    checkoutKey?: string
  },
): ProjectSearchEntry | null {
  const bucket = buckets.get(projectPath)
  const entry = bucket?.entries.get(searchId)
  if (!bucket || !entry) return null

  if (patch.query !== undefined) entry.query = patch.query
  if (patch.checkoutPath !== undefined) entry.checkoutPath = patch.checkoutPath
  if (patch.checkoutKey !== undefined) entry.checkoutKey = patch.checkoutKey
  if (patch.options !== undefined) {
    entry.options = { ...entry.options, ...patch.options }
  }
  entry.updatedAt = Date.now()

  const generation = (bucket.generations.get(searchId) ?? 0) + 1
  bucket.generations.set(searchId, generation)

  // Stop stale host work as soon as intent changes. Waiting for the next
  // debounce to fire leaves a broad previous query consuming the single-root
  // search slot and makes the replacement appear stuck.
  abortEntry(bucket, searchId)

  if (!entry.query.trim()) {
    entry.results = []
    entry.truncated = false
    entry.nextCursor = null
    entry.loading = false
    entry.loadingMore = false
    entry.error = null
    refreshListSnapshot(bucket)
    notify()
    return entry
  }

  entry.loading = true
  entry.loadingMore = false
  entry.error = null
  entry.nextCursor = null
  refreshListSnapshot(bucket)
  notify()

  const timer = setTimeout(() => {
    bucket.timers.delete(searchId)
    void runSearch(projectPath, searchId, generation, "replace")
  }, SEARCH_DEBOUNCE_MS)
  bucket.timers.set(searchId, timer)
  return entry
}

/** Fetch the next host page and append when the current page was truncated. */
export function loadMoreProjectSearch(
  projectPath: string,
  searchId: string,
): void {
  const bucket = buckets.get(projectPath)
  const entry = bucket?.entries.get(searchId)
  if (!bucket || !entry) return
  if (!entry.truncated || entry.loading || entry.loadingMore) return

  const generation = bucket.generations.get(searchId) ?? 0
  void runSearch(projectPath, searchId, generation, "append")
}

function appendUniqueResults(
  existing: readonly ProjectSearchResult[],
  incoming: readonly ProjectSearchResult[],
): ProjectSearchResult[] {
  const seen = new Set(
    existing.map(item => `${item.path}\0${item.line}\0${item.column}`),
  )
  const merged = existing.slice()
  for (const item of incoming) {
    const key = `${item.path}\0${item.line}\0${item.column}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(item)
  }
  return merged
}

/** Test helper — clears all project search state. */
export function resetProjectSearchesForTests(): void {
  for (const bucket of buckets.values()) {
    for (const id of bucket.order) abortEntry(bucket, id)
  }
  buckets.clear()
  notify()
}
