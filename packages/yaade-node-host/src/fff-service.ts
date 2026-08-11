import { createHash } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"
import type {
  FileSearchOptions,
  ProjectSearchOptions,
  ProjectSearchResult,
  SearchPage,
} from "@yaade/shared"
import { gitIsRepo } from "./git.js"
import { FffWorkerClient, type FffWorkerGrepMatch } from "./fff-worker-client.js"
import { LatestRootTaskQueue } from "./latest-root-task-queue.js"
import { uriToPath } from "./paths.js"

type FileFinderModule = typeof import("@ff-labs/fff-node")

let fffModule: FileFinderModule | null = null
let fffLoadFailed = false
let fffLoadPromise: Promise<FileFinderModule | null> | null = null

async function loadFffModule(): Promise<FileFinderModule | null> {
  if (fffLoadFailed) return null
  if (fffModule) return fffModule
  if (!fffLoadPromise) {
    fffLoadPromise = (async () => {
      try {
        fffModule = await import("@ff-labs/fff-node")
        return fffModule
      } catch {
        fffLoadFailed = true
        return null
      }
    })()
  }
  return fffLoadPromise
}

export function isFffAvailable(): boolean {
  return fffModule !== null && !fffLoadFailed
}

export async function probeFffAvailable(): Promise<boolean> {
  const mod = await loadFffModule()
  return mod !== null
}

type FinderEntry = {
  worker: FffWorkerClient
  rootPath: string
  ready: Promise<void>
  scanReady: boolean
}

const finders = new Map<string, FinderEntry>()
const fffTasks = new LatestRootTaskQueue()
const gitRepoCache = new Map<string, boolean>()
/** Roots where FFF init failed; quick-open falls back to ripgrep immediately. */
const fffUnavailableRoots = new Set<string>()

function rootKey(rootUri: string): string {
  return path.normalize(uriToPath(rootUri))
}

async function resolveGitRepo(rootUri: string): Promise<boolean> {
  const key = rootKey(rootUri)
  const cached = gitRepoCache.get(key)
  if (cached !== undefined) return cached
  const isRepo = await gitIsRepo(rootUri)
  gitRepoCache.set(key, isRepo)
  return isRepo
}

/** Search, quick-open, and FFF indexing are git-workspace features only. */
export async function isGitWorkspace(rootUri: string): Promise<boolean> {
  return resolveGitRepo(rootUri)
}

function frecencyDbDir(rootPath: string): string {
  const hash = createHash("sha256").update(rootPath).digest("hex").slice(0, 16)
  return path.join(homedir(), ".yaade", "fff", hash)
}

export async function ensureFffIndex(rootUri: string, timeoutMs = 30_000): Promise<FffWorkerClient | null> {
  if (!(await resolveGitRepo(rootUri))) return null

  const mod = await loadFffModule()
  if (!mod) return null

  const rootPath = rootKey(rootUri)
  let entry = finders.get(rootPath)

  if (!entry) {
    const dbDir = frecencyDbDir(rootPath)
    const worker = new FffWorkerClient({
      moduleUrl: import.meta.resolve("@ff-labs/fff-node"),
      rootPath,
      frecencyDbPath: path.join(dbDir, "frecency"),
      historyDbPath: path.join(dbDir, "history"),
      timeoutMs,
    })
    const ready = worker.request<boolean>("ready", null).then(() => {
      const e = finders.get(rootPath)
      if (e) e.scanReady = true
    })
    entry = { worker, rootPath, ready, scanReady: false }
    finders.set(rootPath, entry)
  }

  try {
    await entry.ready
    return entry.worker
  } catch {
    if (finders.get(rootPath) === entry) finders.delete(rootPath)
    void entry.worker.terminate()
    fffUnavailableRoots.add(rootPath)
    return null
  }
}

export function isFffScanReady(rootUri: string): boolean {
  const key = rootKey(rootUri)
  if (gitRepoCache.get(key) === false) return true
  if (fffLoadFailed || fffUnavailableRoots.has(key)) return true
  const entry = finders.get(key)
  return entry?.scanReady ?? false
}

export async function isSearchScanReady(rootUri: string): Promise<boolean> {
  if (!(await resolveGitRepo(rootUri))) return true
  return isFffScanReady(rootUri)
}

export function disposeFffIndex(rootUri: string): void {
  const rootPath = rootKey(rootUri)
  const entry = finders.get(rootPath)
  if (!entry) return
  fffTasks.abortRoot(rootPath)
  void entry.worker.destroy()
  finders.delete(rootPath)
  fffUnavailableRoots.delete(rootPath)
}

export async function fffFileSearch(
  rootUri: string,
  query: string,
  opts?: FileSearchOptions,
  signal?: AbortSignal,
): Promise<SearchPage<string> | null> {
  const key = rootKey(rootUri)
  return fffTasks.run(key, async taskSignal => {
    const worker = await ensureFffIndex(rootUri)
    if (!worker) return null
    try {
      const result = await worker.request<{ items: string[]; totalMatched: number }>(
        "fileSearch",
        {
          query,
          options: {
            pageSize: opts?.pageSize ?? 100,
            currentFile: opts?.currentFile,
          },
        },
        taskSignal,
      )
      return {
        items: result.items,
        truncated: result.totalMatched > result.items.length,
      }
    } catch (error) {
      if (taskSignal.aborted) disposeFffIndex(rootUri)
      throw error
    }
  }, signal)
}

export async function fffListFiles(
  rootUri: string,
  maxFiles = 20_000,
  signal?: AbortSignal,
): Promise<SearchPage<string> | null> {
  const key = rootKey(rootUri)
  return fffTasks.run(key, async taskSignal => {
    const worker = await ensureFffIndex(rootUri)
    if (!worker) return null
    const paths: string[] = []
    let pageIndex = 0
    const pageSize = 5000
    let truncated = false
    try {
      while (paths.length <= maxFiles) {
        const result = await worker.request<{ items: string[]; totalMatched: number }>(
          "glob",
          { options: { pageIndex, pageSize } },
          taskSignal,
        )
        truncated = result.totalMatched > maxFiles
        for (const relativePath of result.items) {
          paths.push(relativePath)
          if (paths.length > maxFiles) break
        }
        if (paths.length > maxFiles || result.items.length < pageSize) break
        pageIndex += 1
      }
      return { items: paths.slice(0, maxFiles).sort(), truncated }
    } catch (error) {
      if (taskSignal.aborted) {
        disposeFffIndex(rootUri)
        throw error
      }
      if (paths.length > 0) {
        return { items: paths.slice(0, maxFiles).sort(), truncated: true }
      }
      throw error
    }
  }, signal)
}

export async function fffGrep(
  rootUri: string,
  query: string,
  opts?: ProjectSearchOptions,
  signal?: AbortSignal,
): Promise<SearchPage<ProjectSearchResult> | null> {
  const key = rootKey(rootUri)
  return fffTasks.run(key, async taskSignal => {
    const worker = await ensureFffIndex(rootUri)
    if (!worker) return null
    const mode = opts?.fuzzy ? "fuzzy" : opts?.regex ? "regex" : "plain"
    const limit = clampSearchLimit(opts?.limit)
    const cursorOffset = parseCursorOffset(opts?.cursor)
    try {
      const result = await worker.request<{
        items: FffWorkerGrepMatch[]
        hasMore: boolean
        nextCursorOffset: number | null
      }>(
        "grep",
        {
          query,
          options: {
            mode,
            smartCase: !opts?.caseSensitive && !opts?.fuzzy,
            pageSize: limit,
            maxMatchesPerFile: Math.max(limit, 200),
            ...(cursorOffset != null ? { cursorOffset } : {}),
          },
        },
        taskSignal,
      )
      const items = result.items.map(match => {
        const preview = match.lineContent.replace(/\r?\n$/, "")
        const ranges = match.matchRanges.map(([start, end]) => ({
          startLine: match.lineNumber,
          startColumn: byteColumn(preview, start),
          endLine: match.lineNumber,
          endColumn: byteColumn(preview, end),
        }))
        return {
          path: match.relativePath,
          line: match.lineNumber,
          column: ranges[0]?.startColumn ?? byteColumn(preview, match.col),
          preview,
          ranges,
        }
      })
      const truncated = Boolean(result.hasMore || result.nextCursorOffset != null)
      return {
        items,
        truncated,
        nextCursor:
          result.nextCursorOffset != null ? String(result.nextCursorOffset) : undefined,
      }
    } catch (error) {
      if (taskSignal.aborted) disposeFffIndex(rootUri)
      throw error
    }
  }, signal)
}

function clampSearchLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return 500
  return Math.max(1, Math.min(5000, Math.floor(limit)))
}

function parseCursorOffset(cursor: string | undefined): number | null {
  if (cursor == null || cursor === "") return null
  const value = Number(cursor)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.floor(value)
}

export async function fffTrackAccess(
  rootUri: string,
  query: string,
  selectedPath: string,
): Promise<void> {
  const finder = await ensureFffIndex(rootUri)
  if (!finder) return
  await finder.request("track", { query, selectedPath })
}

function byteColumn(text: string, byteOffset: number): number {
  const bytes = Buffer.from(text, "utf8")
  return bytes.subarray(0, Math.max(0, Math.min(byteOffset, bytes.length))).toString("utf8").length + 1
}
