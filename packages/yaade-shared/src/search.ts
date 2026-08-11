/** 1-based line/column range; the end position is exclusive. */
export type SearchMatchRange = {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

export type ProjectSearchResult = {
  path: string
  line: number
  column: number
  preview: string
  ranges: SearchMatchRange[]
}

export type SearchPage<T> = {
  items: T[]
  /** True when a configured result/file cap stopped collection. */
  truncated: boolean
  /** Opaque cursor for the next page when `truncated` is true. */
  nextCursor?: string
}

export type SearchPathOptions = {
  /** Ripgrep-style positive glob filters. */
  include?: string[]
  /** Ripgrep-style negative glob filters. */
  exclude?: string[]
}

export type ProjectSearchOptions = SearchPathOptions & {
  caseSensitive?: boolean
  regex?: boolean
  fuzzy?: boolean
  wholeWord?: boolean
  /** Max matches to return in this page (default 500, max 5000). */
  limit?: number
  /** Opaque cursor from a previous truncated page. */
  cursor?: string
}

export type FileSearchOptions = SearchPathOptions & {
  pageSize?: number
  currentFile?: string
}
