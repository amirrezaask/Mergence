import { spawn } from "node:child_process"
import path from "node:path"
import { rgPath as bundledRgPath } from "@vscode/ripgrep"
import type {
  FileSearchOptions,
  ProjectSearchOptions,
  ProjectSearchResult,
  SearchMatchRange,
  SearchPage,
} from "@yaade/shared"
import {
  disposeFffIndex,
  ensureFffIndex,
  fffFileSearch,
  fffGrep,
  fffListFiles,
  fffTrackAccess,
  isFffScanReady,
  isGitWorkspace,
  isSearchScanReady,
} from "./fff-service.js"
import {
  LatestRootTaskQueue,
  SearchAbortedError,
} from "./latest-root-task-queue.js"
import { uriToPath } from "./paths.js"

const IGNORE_GLOBS = [
  "!.git/**",
  "!node_modules/**",
  "!dist/**",
  "!dist-electron/**",
  "!.turbo/**",
]

/** Cap ripgrep stdout so V8 never builds a multi-hundred-MB string (RangeError). */
const MAX_RG_STDOUT_BYTES = 8 * 1024 * 1024
const MAX_RG_STDERR_BYTES = 64 * 1024
const MAX_SEARCH_GLOBS = 64
const MAX_SEARCH_GLOB_LENGTH = 512
/** Default cap for project file lists returned to the UI / fuzzy open. */
export const DEFAULT_LIST_PROJECT_FILES = 20_000

type RgResult = {
  stderr: string
  code: number | null
  stoppedEarly: boolean
}

type ProjectFileCacheEntry = {
  limit: number
  page?: SearchPage<string>
  loading?: Promise<SearchPage<string>>
}

const rgTasks = new LatestRootTaskQueue()
const projectFileCache = new Map<string, ProjectFileCacheEntry>()
const rgAvailability = new Map<string, Promise<boolean>>()

function rootKey(rootUri: string): string {
  return path.normalize(uriToPath(rootUri))
}

function rgCommand(): string {
  // Prefer explicit override (tests / custom builds), else VS Code's bundled binary.
  return process.env.YAADE_RG_PATH?.trim() || bundledRgPath || "rg"
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new SearchAbortedError()
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

function appendBounded(current: string, chunk: Buffer, maxBytes: number): string | null {
  if (current.length >= maxBytes) return null
  try {
    const next = current + chunk.toString("utf8")
    return next.length <= maxBytes ? next : null
  } catch {
    return null
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

function spawnRgLines(
  args: string[],
  cwd: string,
  onLine: (line: string) => boolean,
  signal: AbortSignal,
  opts?: { maxStdoutBytes?: number },
): Promise<RgResult> {
  const maxStdoutBytes = opts?.maxStdoutBytes ?? MAX_RG_STDOUT_BYTES
  return new Promise((resolve, reject) => {
    throwIfAborted(signal)
    const proc = spawn(rgCommand(), args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let lineBuffer = ""
    let stderr = ""
    let stdoutBytes = 0
    let stoppedEarly = false
    let settled = false
    let forceKillTimer: NodeJS.Timeout | undefined

    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort)
      if (forceKillTimer) clearTimeout(forceKillTimer)
    }
    const rejectOnce = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const stop = (): void => {
      if (stoppedEarly) return
      stoppedEarly = true
      proc.kill("SIGTERM")
    }
    const onAbort = (): void => {
      proc.kill("SIGTERM")
      forceKillTimer = setTimeout(() => proc.kill("SIGKILL"), 250)
      forceKillTimer.unref()
    }

    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()

    proc.stdout.on("data", (chunk: Buffer) => {
      if (settled || signal.aborted) return
      try {
        stdoutBytes += chunk.length
        if (stdoutBytes > maxStdoutBytes) {
          stop()
          return
        }
        const merged = appendBounded(lineBuffer, chunk, maxStdoutBytes)
        if (merged === null) {
          stop()
          return
        }
        lineBuffer = merged

        let newlineAt = lineBuffer.indexOf("\n")
        while (newlineAt >= 0) {
          const line = lineBuffer.slice(0, newlineAt)
          lineBuffer = lineBuffer.slice(newlineAt + 1)
          if (!onLine(line)) {
            stop()
            return
          }
          newlineAt = lineBuffer.indexOf("\n")
        }

        if (lineBuffer.length > 1024 * 1024) stop()
      } catch {
        stop()
      }
    })

    proc.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length >= MAX_RG_STDERR_BYTES) return
      const merged = appendBounded(stderr, chunk, MAX_RG_STDERR_BYTES)
      if (merged !== null) stderr = merged
    })

    proc.once("close", code => {
      if (settled) return
      if (signal.aborted) {
        rejectOnce(abortError(signal))
        return
      }
      settled = true
      cleanup()
      resolve({ stderr, code, stoppedEarly })
    })
    proc.once("error", error => {
      if (signal.aborted) {
        rejectOnce(abortError(signal))
      } else if (errorCode(error) === "ENOENT") {
        rejectOnce(new Error("ripgrep (rg) is unavailable — install @vscode/ripgrep or set YAADE_RG_PATH"))
      } else {
        rejectOnce(error)
      }
    })
  })
}

function pushIgnoreGlobs(args: string[]): void {
  for (const glob of IGNORE_GLOBS) args.push("--glob", glob)
}

function validatedGlobs(patterns: string[] | undefined, name: string): string[] {
  if (!patterns) return []
  if (patterns.length > MAX_SEARCH_GLOBS) {
    throw new Error(`${name} accepts at most ${MAX_SEARCH_GLOBS} patterns`)
  }
  return patterns.map(pattern => {
    const trimmed = pattern.trim()
    if (
      !trimmed ||
      trimmed.length > MAX_SEARCH_GLOB_LENGTH ||
      trimmed.includes("\0") ||
      trimmed.includes("\n") ||
      trimmed.includes("\r")
    ) {
      throw new Error(`invalid ${name} glob`)
    }
    return trimmed.replaceAll("\\", "/")
  })
}

function pushSearchGlobs(args: string[], opts?: Pick<ProjectSearchOptions, "include" | "exclude">): void {
  for (const glob of validatedGlobs(opts?.include, "include")) args.push("--glob", glob)
  for (const glob of validatedGlobs(opts?.exclude, "exclude")) args.push("--glob", `!${glob}`)
}

async function runRg<T>(
  rootUri: string,
  signal: AbortSignal | undefined,
  task: (rootPath: string, taskSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const key = rootKey(rootUri)
  return rgTasks.run(key, taskSignal => task(key, taskSignal), signal)
}

async function rgListProjectFiles(
  rootUri: string,
  maxFiles = DEFAULT_LIST_PROJECT_FILES,
  signal?: AbortSignal,
): Promise<SearchPage<string>> {
  return runRg(rootUri, signal, async (cwd, taskSignal) => {
    const args = ["--files"]
    pushIgnoreGlobs(args)
    args.push(".")

    const paths: string[] = []
    const { stderr, code, stoppedEarly } = await spawnRgLines(args, cwd, line => {
      if (!line) return true
      paths.push(line.replace(/^\.\//, ""))
      return paths.length <= maxFiles
    }, taskSignal)

    if (!stoppedEarly && code !== 0 && code !== 1) {
      throw new Error(stderr.trim() || `rg exit ${code}`)
    }

    const truncated = stoppedEarly || paths.length > maxFiles
    paths.sort()
    return { items: paths.slice(0, maxFiles), truncated }
  })
}

async function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal))
    signal.addEventListener("abort", abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

async function cachedRgProjectFiles(
  rootUri: string,
  maxFiles: number,
  signal?: AbortSignal,
): Promise<SearchPage<string>> {
  const key = rootKey(rootUri)
  let entry = projectFileCache.get(key)
  if (entry?.page && entry.limit >= maxFiles) return slicePage(entry.page, maxFiles)
  if (entry?.loading && entry.limit >= maxFiles) {
    return slicePage(await awaitWithSignal(entry.loading, signal), maxFiles)
  }

  entry = { limit: maxFiles }
  const loading = rgListProjectFiles(rootUri, maxFiles, signal)
  entry.loading = loading
  projectFileCache.set(key, entry)
  try {
    const page = await loading
    entry.page = page
    entry.loading = undefined
    return page
  } catch (error) {
    if (projectFileCache.get(key) === entry) projectFileCache.delete(key)
    throw error
  }
}

function slicePage<T>(page: SearchPage<T>, limit: number): SearchPage<T> {
  return {
    items: page.items.slice(0, limit),
    truncated: page.truncated || page.items.length > limit,
  }
}

function scoreFileTerm(term: string, filePath: string, base: string): number | null {
  const lower = filePath.toLowerCase()
  const idx = lower.indexOf(term)
  if (idx >= 0) {
    let score = idx
    if (base.startsWith(term)) score -= 100
    if (base === term) score -= 200
    const baseIdx = base.indexOf(term)
    if (baseIdx >= 0) score -= 50
    return score
  }

  const baseFuzzy = subsequenceScore(term, base)
  if (baseFuzzy !== null) return 100 + baseFuzzy
  const pathFuzzy = subsequenceScore(term, lower)
  return pathFuzzy === null ? null : 200 + pathFuzzy
}

function subsequenceScore(term: string, candidate: string): number | null {
  let previous = -1
  let score = 0
  for (const char of term) {
    const index = candidate.indexOf(char, previous + 1)
    if (index < 0) return null
    score += previous < 0 ? index : index - previous - 1
    previous = index
  }
  return score
}

function globRegex(glob: string): RegExp {
  let source = glob.includes("/") ? "^" : "(?:^|/)"
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!
    if (char === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        source += "(?:.*/)?"
        i += 2
      } else {
        source += ".*"
        i += 1
      }
    } else if (char === "*") {
      source += "[^/]*"
    } else if (char === "?") {
      source += "[^/]"
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    }
  }
  return new RegExp(`${source}$`)
}

function filterPaths(files: string[], opts?: FileSearchOptions): string[] {
  const includes = validatedGlobs(opts?.include, "include").map(globRegex)
  const excludes = validatedGlobs(opts?.exclude, "exclude").map(globRegex)
  if (includes.length === 0 && excludes.length === 0) return files
  return files.filter(filePath => {
    const normalized = filePath.replaceAll("\\", "/")
    if (includes.length > 0 && !includes.some(pattern => pattern.test(normalized))) return false
    return !excludes.some(pattern => pattern.test(normalized))
  })
}

function fuzzyMatchFilesFallback(
  query: string,
  files: string[],
  limit = 100,
): SearchPage<string> {
  const trimmed = query.trim()
  if (!trimmed) {
    return { items: files.slice(0, limit), truncated: files.length > limit }
  }

  const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean)
  const scored: { path: string; score: number }[] = []

  for (const filePath of files) {
    const lower = filePath.toLowerCase()
    const base = (filePath.split("/").pop() ?? filePath).toLowerCase()
    let total = 0
    let matched = true
    for (const term of terms) {
      const score = scoreFileTerm(term, lower, base)
      if (score === null) {
        matched = false
        break
      }
      total += score
    }
    if (matched) scored.push({ path: filePath, score: total })
  }

  scored.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
  return {
    items: scored.slice(0, limit).map(result => result.path),
    truncated: scored.length > limit,
  }
}

export async function listProjectFiles(
  rootUri: string,
  maxFiles = DEFAULT_LIST_PROJECT_FILES,
  signal?: AbortSignal,
): Promise<SearchPage<string>> {
  throwIfAborted(signal)
  if (await isGitWorkspace(rootUri)) {
    try {
      const fffFiles = await fffListFiles(rootUri, maxFiles, signal)
      throwIfAborted(signal)
      if (fffFiles) return fffFiles
    } catch (error) {
      if (signal?.aborted) throw error
      /* fall through to rg */
    }
  }
  return cachedRgProjectFiles(rootUri, maxFiles, signal)
}

export async function fileSearch(
  rootUri: string,
  query: string,
  opts?: FileSearchOptions,
  signal?: AbortSignal,
): Promise<SearchPage<string>> {
  throwIfAborted(signal)
  const pageSize = Math.max(1, Math.min(1000, opts?.pageSize ?? 100))
  const hasPathFilters = Boolean(opts?.include?.length || opts?.exclude?.length)
  if (!hasPathFilters && await isGitWorkspace(rootUri)) {
    try {
      const fffResults = await fffFileSearch(
        rootUri,
        query,
        { ...opts, pageSize },
        signal,
      )
      throwIfAborted(signal)
      if (fffResults) return fffResults
    } catch (error) {
      if (signal?.aborted) throw error
      /* fall through */
    }
  }

  const files = await cachedRgProjectFiles(rootUri, DEFAULT_LIST_PROJECT_FILES, signal)
  throwIfAborted(signal)
  const results = fuzzyMatchFilesFallback(query, filterPaths(files.items, opts), pageSize)
  return { items: results.items, truncated: files.truncated || results.truncated }
}

/** Default / max matches returned per projectSearch page. */
export const DEFAULT_PROJECT_SEARCH_LIMIT = 500
export const MAX_PROJECT_SEARCH_LIMIT = 5000
/** Safety cap on matches collected from a single file while streaming rg. */
const MAX_RG_MATCHES_PER_FILE = 10_000

function clampProjectSearchLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_PROJECT_SEARCH_LIMIT
  return Math.max(1, Math.min(MAX_PROJECT_SEARCH_LIMIT, Math.floor(limit)))
}

function parseRgCursorOffset(cursor: string | undefined): number {
  if (cursor == null || cursor === "") return 0
  const value = Number(cursor)
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.floor(value)
}

export async function projectSearch(
  rootUri: string,
  query: string,
  opts?: ProjectSearchOptions,
  signal?: AbortSignal,
): Promise<SearchPage<ProjectSearchResult>> {
  throwIfAborted(signal)
  if (!query.trim()) return { items: [], truncated: false }

  const limit = clampProjectSearchLimit(opts?.limit)
  const requiresRg = Boolean(
    opts?.wholeWord || opts?.include?.length || opts?.exclude?.length || opts?.caseSensitive,
  )
  if (!requiresRg && await isGitWorkspace(rootUri)) {
    try {
      const fffResults = await fffGrep(rootUri, query, { ...opts, limit }, signal)
      throwIfAborted(signal)
      if (fffResults) return fffResults
    } catch (error) {
      if (signal?.aborted) throw error
      /* fall through to rg */
    }
  }

  const skip = parseRgCursorOffset(opts?.cursor)
  return runRg(rootUri, signal, async (cwd, taskSignal) => {
    // --max-count is per-file in ripgrep; keep it high so total pagination owns the budget.
    const args = ["--json", "--max-count", String(MAX_RG_MATCHES_PER_FILE)]
    if (!opts?.caseSensitive) args.push("-i")
    if (!opts?.regex) args.push("--fixed-strings")
    if (opts?.wholeWord) args.push("--word-regexp")
    pushIgnoreGlobs(args)
    pushSearchGlobs(args, opts)
    args.push(query, ".")

    const results: ProjectSearchResult[] = []
    let seen = 0
    let moreAvailable = false
    const { stderr, code, stoppedEarly } = await spawnRgLines(args, cwd, line => {
      const match = parseRgJsonLine(line)
      if (!match) return true
      if (seen < skip) {
        seen += 1
        return true
      }
      if (results.length >= limit) {
        moreAvailable = true
        return false
      }
      results.push(match)
      seen += 1
      return true
    }, taskSignal)

    if (!stoppedEarly && code !== 0 && code !== 1) {
      throw new Error(stderr.trim() || `rg exit ${code}`)
    }
    const truncated = moreAvailable || (stoppedEarly && results.length >= limit)
    return {
      items: results,
      truncated,
      nextCursor: truncated ? String(skip + results.length) : undefined,
    }
  })
}

export async function trackFileAccess(
  rootUri: string,
  query: string,
  selectedPath: string,
): Promise<void> {
  if (!(await isGitWorkspace(rootUri))) return
  try {
    await fffTrackAccess(rootUri, query, selectedPath)
  } catch {
    /* optional frecency tracking */
  }
}

export function invalidateProjectFileCache(rootUri: string): void {
  projectFileCache.delete(rootKey(rootUri))
}

export async function refreshProjectFileCache(
  rootUri: string,
): Promise<SearchPage<string> | null> {
  invalidateProjectFileCache(rootUri)
  if (rgTasks.isBusy(rootKey(rootUri))) return null
  return cachedRgProjectFiles(rootUri, DEFAULT_LIST_PROJECT_FILES)
}

export function disposeSearchRoot(rootUri: string): void {
  const key = rootKey(rootUri)
  projectFileCache.delete(key)
  rgTasks.abortRoot(key)
  disposeFffIndex(rootUri)
}

export async function isSearchSupported(rootUri: string): Promise<boolean> {
  const command = rgCommand()
  let probe = rgAvailability.get(command)
  if (!probe) {
    probe = new Promise<boolean>(resolve => {
      const proc = spawn(command, ["--version"], {
        cwd: rootKey(rootUri),
        stdio: "ignore",
      })
      proc.once("error", () => resolve(false))
      proc.once("close", code => resolve(code === 0))
    })
    rgAvailability.set(command, probe)
  }
  return probe
}

export { ensureFffIndex, isFffScanReady, isGitWorkspace, isSearchScanReady }

function byteColumn(text: string, byteOffset: number): number {
  const bytes = Buffer.from(text, "utf8")
  return bytes.subarray(0, Math.max(0, Math.min(byteOffset, bytes.length))).toString("utf8").length + 1
}

function matchRange(
  line: number,
  preview: string,
  start: number,
  end: number,
): SearchMatchRange {
  return {
    startLine: line,
    startColumn: byteColumn(preview, start),
    endLine: line,
    endColumn: byteColumn(preview, end),
  }
}

function parseRgJsonLine(line: string): ProjectSearchResult | null {
  if (!line.trim()) return null
  try {
    const obj = JSON.parse(line) as {
      type?: string
      data?: {
        path?: { text?: string }
        line_number?: number
        submatches?: { start?: number; end?: number; match?: { text?: string } }[]
        lines?: { text?: string }
      }
    }
    if (obj.type !== "match" || !obj.data) return null
    const resultPath = (obj.data.path?.text ?? "").replace(/^\.\//, "")
    const lineNum = obj.data.line_number ?? 1
    const preview = (obj.data.lines?.text ?? "").replace(/\r?\n$/, "")
    const ranges = (obj.data.submatches ?? []).map(submatch => {
      const start = submatch.start ?? 0
      const end = submatch.end ?? start + Buffer.byteLength(submatch.match?.text ?? "", "utf8")
      return matchRange(lineNum, preview, start, end)
    })
    const column = ranges[0]?.startColumn ?? 1
    return { path: resultPath, line: lineNum, column, preview, ranges }
  } catch {
    return null
  }
}
