import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import type {
  CheckoutTarget,
  ProjectSearchResult,
  ProjectTarget,
  SearchToolOptions,
  ToolUse,
} from "@yaade/rpc"
import { pathToFileUri, type ProjectSearchOptions, type YaadeTheme } from "@yaade/shared"
import { ProjectSearchPanel } from "@yaade/ui"

type SearchLocation = {
  readonly path: string
  readonly line: number
  readonly column: number
}

export type SearchToolViewProps = {
  readonly use: ToolUse
  readonly theme: YaadeTheme
  readonly fontSize: number
  readonly results: readonly ProjectSearchResult[]
  readonly toolbar: ReactNode
  readonly projects: readonly ProjectTarget[]
  readonly onContextChange: (
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>
  readonly onSearchChange: (
    query: string,
    options: ProjectSearchOptions,
  ) => Promise<void>
  readonly onLoadMore: () => Promise<void>
  readonly onOpenLocation: (location: SearchLocation) => Promise<void>
  readonly visible?: boolean
  readonly focused?: boolean
}

function absoluteResultPath(root: string, resultPath: string): string {
  if (resultPath.startsWith("/")) return resultPath
  return `${root.replace(/\/+$/, "")}/${resultPath.replace(/^\/+/, "")}`
}

function editableOptions(options: SearchToolOptions): ProjectSearchOptions {
  const next: ProjectSearchOptions = {}
  if (options.include) next.include = [...options.include]
  if (options.exclude) next.exclude = [...options.exclude]
  if (options.caseSensitive != null) next.caseSensitive = options.caseSensitive
  if (options.regex != null) next.regex = options.regex
  if (options.fuzzy != null) next.fuzzy = options.fuzzy
  if (options.wholeWord != null) next.wholeWord = options.wholeWord
  if (options.limit != null) next.limit = options.limit
  if (options.cursor != null) next.cursor = options.cursor
  return next
}

export function SearchToolView(props: SearchToolViewProps) {
  const input = props.use.input.kind === "search" ? props.use.input : null
  const [query, setQuery] = useState(input?.query ?? "")
  const [options, setOptions] = useState<ProjectSearchOptions>(() =>
    input ? editableOptions(input.options) : {},
  )
  const checkoutPath = props.use.context.checkoutPath
  const searchTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (props.use.input.kind !== "search") return
    setQuery(props.use.input.query)
    setOptions(editableOptions(props.use.input.options))
  }, [props.use.id, props.use.inputRevision])

  useEffect(
    () => () => {
      if (searchTimer.current != null) window.clearTimeout(searchTimer.current)
    },
    [],
  )

  const scheduleSearch = (
    nextQuery: string,
    nextOptions: ProjectSearchOptions,
  ) => {
    if (searchTimer.current != null) window.clearTimeout(searchTimer.current)
    searchTimer.current = window.setTimeout(() => {
      void props.onSearchChange(nextQuery, nextOptions)
    }, 150)
  }

  const readFile = useMemo(
    () => async (relativePath: string) => {
      const path = absoluteResultPath(checkoutPath, relativePath)
      const read = window.yaade?.fs?.readFile
      if (!read) throw new Error("File read is unavailable")
      return read(pathToFileUri(path))
    },
    [checkoutPath],
  )
  const panelResults = useMemo(
    () =>
      props.results.map(result => ({
        ...result,
        ranges: result.ranges.map(range => ({ ...range })),
      })),
    [props.results],
  )

  if (props.use.output.kind !== "search") return null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {props.toolbar}
      <div className="min-h-0 flex-1">
        <ProjectSearchPanel
          query={query}
          options={options}
          results={panelResults}
          truncated={props.use.output.truncated}
          loading={props.use.output.running}
          error={props.use.error ?? null}
          projectPath={checkoutPath}
          readFile={readFile}
          onQueryChange={next => {
            setQuery(next)
            scheduleSearch(next, options)
          }}
          onOptionsChange={next => {
            setOptions(next)
            scheduleSearch(query, next)
          }}
          onSelectResult={result => {
            const location: SearchLocation = {
              path: absoluteResultPath(checkoutPath, result.path),
              line: Math.max(1, result.line),
              column: Math.max(1, result.column),
            }
            void props.onOpenLocation(location)
          }}
          onLoadMore={props.onLoadMore}
        />
      </div>
    </div>
  )
}

export default SearchToolView
