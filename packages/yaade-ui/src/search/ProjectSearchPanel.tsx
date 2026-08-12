import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import type { ProjectSearchOptions, ProjectSearchResult } from "@yaade/shared"
import { ChevronDown, ChevronRight, Copy, FileCode2, Search } from "lucide-react"
import { Button } from "../components/ui/button.js"
import { Input } from "../components/ui/input.js"
import { Spinner } from "../components/ui/spinner.js"
import { cn } from "../lib/utils.js"
import { SearchCodeChunk } from "./SearchCodeChunk.js"
import {
  SEARCH_CONTEXT_LINES,
  SEARCH_FILES_PAGE_SIZE,
  SEARCH_INITIAL_CHUNKS_PER_FILE,
  buildSearchFileGroup,
  groupSearchResultsByPath,
  type SearchChunkLine,
  type SearchPathBucket,
} from "./search-chunks.js"

export type ProjectSearchPanelProps = {
  query: string
  options: ProjectSearchOptions
  results: readonly ProjectSearchResult[]
  truncated: boolean
  loading: boolean
  loadingMore?: boolean
  error: string | null
  /** Absolute project root — used to load snippet context. */
  projectPath: string
  /** Read UTF-8 file text for a project-relative path. */
  readFile: (relativePath: string) => Promise<string>
  onQueryChange: (query: string) => void
  onOptionsChange: (options: ProjectSearchOptions) => void
  onSelectResult: (result: ProjectSearchResult, disposition?: "preview" | "pinned") => void
  /** Fetch the next host result page when the list is truncated. */
  onLoadMore?: () => void
  className?: string
}

function parseGlobs(value: string | undefined): string[] | undefined {
  const globs = (value ?? "").split(",").map(item => item.trim()).filter(Boolean)
  return globs.length > 0 ? globs : undefined
}

function formatGlobs(globs: string[] | undefined): string {
  return globs?.join(", ") ?? ""
}

/** Cache file bodies; only fetch paths that have been requested (viewport / page). */
function useLazyFileTexts(
  projectPath: string,
  readFile: (relativePath: string) => Promise<string>,
): {
  texts: ReadonlyMap<string, string>
  ensureFile: (relativePath: string) => void
} {
  const [texts, setTexts] = useState<Map<string, string>>(() => new Map())
  const cacheRef = useRef(new Map<string, string>())
  const inflightRef = useRef(new Set<string>())
  const projectRef = useRef(projectPath)
  const readFileRef = useRef(readFile)
  readFileRef.current = readFile

  useEffect(() => {
    projectRef.current = projectPath
    cacheRef.current = new Map()
    inflightRef.current = new Set()
    setTexts(new Map())
  }, [projectPath])

  const ensureFile = useCallback((relativePath: string) => {
    if (cacheRef.current.has(relativePath) || inflightRef.current.has(relativePath)) return
    inflightRef.current.add(relativePath)
    const requestedFor = projectRef.current
    void readFileRef
      .current(relativePath)
      .then(text => {
        if (projectRef.current !== requestedFor) return
        cacheRef.current.set(relativePath, text)
        inflightRef.current.delete(relativePath)
        setTexts(new Map(cacheRef.current))
      })
      .catch(() => {
        if (projectRef.current !== requestedFor) return
        cacheRef.current.set(relativePath, "")
        inflightRef.current.delete(relativePath)
        setTexts(new Map(cacheRef.current))
      })
  }, [])

  return { texts, ensureFile }
}

function useNearViewport(
  rootRef: RefObject<Element | null>,
  onNear: () => void,
  enabled: boolean,
): (node: HTMLElement | null) => void {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const onNearRef = useRef(onNear)
  onNearRef.current = onNear

  useEffect(() => {
    if (!enabled || !node) return
    const root = rootRef.current
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) onNearRef.current()
      },
      {
        root: root instanceof Element ? root : null,
        rootMargin: "240px 0px",
        threshold: 0,
      },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [enabled, node, rootRef])

  return setNode
}

function FileResultCard({
  bucket,
  fileText,
  scrollRootRef,
  onRequestFile,
  onSelectResult,
  onSelectLine,
  selectedResult,
}: {
  bucket: SearchPathBucket
  fileText: string | undefined
  scrollRootRef: RefObject<Element | null>
  onRequestFile: (path: string) => void
  onSelectResult: (result: ProjectSearchResult, disposition?: "preview" | "pinned") => void
  onSelectLine: (
    path: string,
    line: SearchChunkLine,
    primary: ProjectSearchResult,
    disposition?: "preview" | "pinned",
  ) => void
  selectedResult: { path: string; line: number } | null
}) {
  const [expanded, setExpanded] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const [active, setActive] = useState(false)
  const requestedRef = useRef(false)

  const setCardRef = useNearViewport(
    scrollRootRef,
    () => {
      setActive(true)
      if (!requestedRef.current) {
        requestedRef.current = true
        onRequestFile(bucket.path)
      }
    },
    true,
  )

  const group = useMemo(
    () =>
      buildSearchFileGroup(
        bucket.path,
        bucket.matches,
        fileText,
        SEARCH_CONTEXT_LINES,
      ),
    [bucket.matches, bucket.path, fileText],
  )

  const visibleChunks = showAll
    ? group.chunks
    : group.chunks.slice(0, SEARCH_INITIAL_CHUNKS_PER_FILE)
  const hiddenCount = group.chunks.length - visibleChunks.length

  return (
    <section
      ref={setCardRef}
      className="border-b border-border/60 px-3 py-1.5"
      data-yaade-project-search-file={group.path}
      data-yaade-project-search-file-loaded={fileText != null ? "1" : "0"}
    >
      <header className="mb-1.5 flex min-w-0 items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => setExpanded(value => !value)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-mono text-xs text-foreground">{group.path}</span>
          <span className="shrink-0 text-3xs text-muted-foreground tabular-nums">
            {group.matchCount}
          </span>
        </button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="size-6"
          aria-label={`Copy ${group.path}`}
          onClick={() => void navigator.clipboard?.writeText(group.path)}
        >
          <Copy className="size-3" />
        </Button>
      </header>

      {expanded ? (
        <div className="flex flex-col gap-2">
          {visibleChunks.map((chunk, index) => (
            <div key={`${group.path}:${chunk.startLine}:${index}`} className="flex flex-col gap-2">
              {index > 0 ? (
                <div
                  className="mx-2 h-2 border-l border-dashed border-border/70"
                  aria-hidden
                />
              ) : null}
              <SearchCodeChunk
                path={group.path}
                chunk={chunk}
                highlight={active && fileText != null}
                onSelectLine={(line, disposition) =>
                  onSelectLine(group.path, line, chunk.primary, disposition)
                }
                selectedLine={
                  selectedResult?.path === group.path ? selectedResult.line : null
                }
              />
            </div>
          ))}
          {hiddenCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 justify-start px-2 text-xs text-muted-foreground"
              onClick={() => setShowAll(true)}
            >
              <ChevronDown className="size-3.5" aria-hidden />
              Show {hiddenCount} more match{hiddenCount === 1 ? "" : "es"}
            </Button>
          ) : null}
          {group.chunks[0] ? (
            <button
              type="button"
              className="sr-only"
              onClick={() => onSelectResult(group.chunks[0]!.primary)}
            >
              Open {group.path}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

export function ProjectSearchPanel({
  query,
  options,
  results,
  truncated,
  loading,
  loadingMore = false,
  error,
  projectPath,
  readFile,
  onQueryChange,
  onOptionsChange,
  onSelectResult,
  onLoadMore,
  className,
}: ProjectSearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const buckets = useMemo(() => groupSearchResultsByPath(results), [results])
  const [visibleCount, setVisibleCount] = useState(SEARCH_FILES_PAGE_SIZE)
  const [selectedResult, setSelectedResult] = useState<{
    path: string
    line: number
  } | null>(null)
  const resultsKey = useMemo(
    () => `${projectPath}\0${query}\0${JSON.stringify(options)}`,
    [options, projectPath, query],
  )

  useEffect(() => {
    setVisibleCount(SEARCH_FILES_PAGE_SIZE)
  }, [resultsKey])

  // Grow the mounted file window when host pages append more file groups.
  useEffect(() => {
    setVisibleCount(count => {
      if (count >= buckets.length) return buckets.length > 0 ? buckets.length : count
      return count
    })
  }, [buckets.length])

  const { texts, ensureFile } = useLazyFileTexts(projectPath, readFile)
  const visibleBuckets = buckets.slice(0, visibleCount)
  const hasMoreFiles = visibleCount < buckets.length
  const canFetchHostPage = Boolean(truncated && onLoadMore)
  const showMoreControl = hasMoreFiles || canFetchHostPage || loadingMore
  const remainingFiles = Math.max(0, buckets.length - visibleCount)

  const include = formatGlobs(options.include)
  const exclude = formatGlobs(options.exclude)
  const caseSensitive = options.caseSensitive ?? false
  const regex = options.regex ?? false
  const wholeWord = options.wholeWord ?? false

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const focusSelection = () => {
      const selected = scrollRef.current?.querySelector<HTMLElement>(
        '[data-yaade-list-item][data-selected]',
      )
      selected?.scrollIntoView({ block: "center" })
      selected?.focus({ preventScroll: true })
    }
    window.addEventListener("yaade:focus-search-result", focusSelection)
    return () => window.removeEventListener("yaade:focus-search-result", focusSelection)
  }, [])

  const patchOptions = (patch: ProjectSearchOptions) => {
    onOptionsChange({ ...options, ...patch })
  }

  const handleSelectLine = (
    path: string,
    line: SearchChunkLine,
    primary: ProjectSearchResult,
    disposition: "preview" | "pinned" = "preview",
  ) => {
    setSelectedResult({ path, line: line.line })
    onSelectResult({
      ...primary,
      path,
      line: line.line,
      column: line.ranges[0]?.startColumn ?? 1,
      preview: line.text,
      ranges: line.ranges.length > 0 ? line.ranges : primary.ranges,
    }, disposition)
  }

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col bg-background", className)}
      data-yaade-project-search-panel=""
    >
      <div className="sticky top-0 z-10 flex shrink-0 flex-col gap-2 border-b border-border bg-background px-3 py-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            ref={inputRef}
            type="search"
            value={query}
            onChange={event => onQueryChange(event.target.value)}
            placeholder="Search project…"
            aria-label="Search project"
            className="h-9 pl-9 font-mono text-sm"
            data-yaade-project-search-input=""
          />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {(
            [
              ["Case", caseSensitive, () => patchOptions({ caseSensitive: !caseSensitive })],
              ["Regex", regex, () => patchOptions({ regex: !regex, fuzzy: false })],
              ["Word", wholeWord, () => patchOptions({ wholeWord: !wholeWord })],
            ] as const
          ).map(([label, active, toggle]) => (
            <Button
              key={label}
              type="button"
              size="sm"
              variant={active ? "secondary" : "ghost"}
              className="h-7 px-2 text-xs"
              aria-pressed={active}
              onClick={toggle}
            >
              {label}
            </Button>
          ))}
          {loading || loadingMore ? <Spinner className="ml-1 size-3.5" /> : null}
          {results.length > 0 ? (
            <span className="ml-auto text-xs text-muted-foreground" role="status">
              {results.length}
              {truncated ? "+" : ""} match{results.length === 1 ? "" : "es"} in{" "}
              {buckets.length}
              {truncated ? "+" : ""} file{buckets.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Input
            aria-label="Files to include"
            value={include}
            onChange={event =>
              patchOptions({ include: parseGlobs(event.target.value) })
            }
            placeholder="Include: src/**"
            className="h-7 font-mono text-xs"
          />
          <Input
            aria-label="Files to exclude"
            value={exclude}
            onChange={event =>
              patchOptions({ exclude: parseGlobs(event.target.value) })
            }
            placeholder="Exclude: **/*.test.ts"
            className="h-7 font-mono text-xs"
          />
        </div>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto"
        data-yaade-list-panel="project-search"
        role="listbox"
        aria-label="Search results"
      >
        {error ? (
          <div className="px-3 py-3 text-sm text-destructive" role="alert">
            {error}
          </div>
        ) : null}
        {!error && !loading && query.trim() && results.length === 0 ? (
          <div className="px-3 py-6 text-sm text-muted-foreground">No matches.</div>
        ) : null}
        {!query.trim() && !loading ? (
          <div className="px-3 py-6 text-sm text-muted-foreground">
            Type a query to search the project.
          </div>
        ) : null}
        {visibleBuckets.map(bucket => (
          <FileResultCard
            key={bucket.path}
            bucket={bucket}
            fileText={texts.has(bucket.path) ? texts.get(bucket.path) : undefined}
            scrollRootRef={scrollRef}
            onRequestFile={ensureFile}
            onSelectResult={onSelectResult}
            onSelectLine={handleSelectLine}
            selectedResult={selectedResult}
          />
        ))}
        {showMoreControl ? (
          <div
            className="flex items-center justify-center gap-2 px-3 py-4 text-xs text-muted-foreground"
            data-yaade-project-search-sentinel=""
          >
            {hasMoreFiles ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setVisibleCount(count =>
                    Math.min(buckets.length, count + SEARCH_FILES_PAGE_SIZE),
                  )
                }
              >
                Show {Math.min(SEARCH_FILES_PAGE_SIZE, remainingFiles)} more file{
                  Math.min(SEARCH_FILES_PAGE_SIZE, remainingFiles) === 1 ? "" : "s"
                }
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={loading || loadingMore}
                onClick={onLoadMore}
              >
                {loadingMore ? <Spinner className="size-3.5" /> : null}
                {loadingMore ? "Loading more matches…" : "Load more matches"}
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
