import type { ProjectSearchResult, SearchMatchRange } from "@yaade/shared"

/** Sourcegraph stream API default (`cl=1`). */
export const SEARCH_CONTEXT_LINES = 1

/** Collapse long file groups like Sourcegraph's "Show N more matches". */
export const SEARCH_INITIAL_CHUNKS_PER_FILE = 3

/** How many file cards to mount before the infinite-scroll sentinel. */
export const SEARCH_FILES_PAGE_SIZE = 8

export type SearchChunkLine = {
  line: number
  text: string
  /** True when this line contains at least one search match. */
  match: boolean
  ranges: SearchMatchRange[]
}

export type SearchResultChunk = {
  startLine: number
  endLine: number
  lines: SearchChunkLine[]
  /** First match in this chunk — used for click-to-open. */
  primary: ProjectSearchResult
}

export type SearchFileGroup = {
  path: string
  matchCount: number
  chunks: SearchResultChunk[]
}

export type SearchPathBucket = {
  path: string
  matches: ProjectSearchResult[]
}

/** Preserve first-seen path order from the host result stream. */
export function groupSearchResultsByPath(
  results: readonly ProjectSearchResult[],
): SearchPathBucket[] {
  const byPath = new Map<string, ProjectSearchResult[]>()
  const order: string[] = []
  for (const result of results) {
    const list = byPath.get(result.path)
    if (list) {
      list.push(result)
      continue
    }
    byPath.set(result.path, [result])
    order.push(result.path)
  }
  return order.map(path => ({
    path,
    matches: byPath.get(path)!,
  }))
}

/**
 * Build Sourcegraph-style chunks for one file.
 * Pass `fileText: undefined` to render match previews only (no context lines).
 */
export function buildSearchFileGroup(
  path: string,
  matches: readonly ProjectSearchResult[],
  fileText: string | undefined,
  contextLines: number = SEARCH_CONTEXT_LINES,
): SearchFileGroup {
  const sorted = [...matches].sort((a, b) => a.line - b.line || a.column - b.column)
  const lines = fileText != null ? splitFileLines(fileText) : null
  // Without file text, show hit lines only — context appears after lazy load.
  const effectiveContext = lines ? contextLines : 0
  const windows = sorted.map(match => {
    const start = Math.max(1, match.line - effectiveContext)
    const end = lines
      ? Math.min(lines.length, match.line + effectiveContext)
      : match.line + effectiveContext
    return { start, end, match }
  })

  const merged: SearchResultChunk[] = []
  for (const window of windows) {
    const last = merged[merged.length - 1]
    if (last && window.start <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, window.end)
      continue
    }
    merged.push({
      startLine: window.start,
      endLine: window.end,
      lines: [],
      primary: window.match,
    })
  }

  for (const chunk of merged) {
    chunk.lines = buildChunkLines(chunk, sorted, lines)
  }

  return {
    path,
    matchCount: sorted.length,
    chunks: merged,
  }
}

/**
 * Build Sourcegraph-style per-file chunks: N lines of context around each hit,
 * merging overlapping/adjacent windows, leaving visual gaps when matches are far apart.
 */
export function buildSearchFileGroups(
  results: readonly ProjectSearchResult[],
  fileTexts: ReadonlyMap<string, string>,
  contextLines: number = SEARCH_CONTEXT_LINES,
): SearchFileGroup[] {
  return groupSearchResultsByPath(results).map(({ path, matches }) =>
    buildSearchFileGroup(path, matches, fileTexts.get(path), contextLines),
  )
}

function splitFileLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  if (normalized.endsWith("\n")) {
    return normalized.slice(0, -1).split("\n")
  }
  return normalized.split("\n")
}

function buildChunkLines(
  chunk: SearchResultChunk,
  matches: readonly ProjectSearchResult[],
  fileLines: string[] | null,
): SearchChunkLine[] {
  const out: SearchChunkLine[] = []
  for (let line = chunk.startLine; line <= chunk.endLine; line += 1) {
    const hitMatches = matches.filter(match => match.line === line)
    const text =
      fileLines?.[line - 1] ??
      hitMatches[0]?.preview ??
      ""
    out.push({
      line,
      text,
      match: hitMatches.length > 0,
      ranges: dedupeRanges(hitMatches.flatMap(match => match.ranges)),
    })
  }
  return out
}

function dedupeRanges(ranges: readonly SearchMatchRange[]): SearchMatchRange[] {
  const seen = new Set<string>()
  const out: SearchMatchRange[] = []
  for (const range of ranges) {
    const key = `${range.startLine}:${range.startColumn}:${range.endLine}:${range.endColumn}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(range)
  }
  return out
}
