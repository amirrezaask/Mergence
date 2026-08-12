import { useCallback, useSyncExternalStore } from "react"
import type { ProjectSearchOptions, ProjectSearchResult } from "@yaade/shared"
import { pathToFileUri } from "@yaade/shared"
import { ProjectSearchPanel } from "@yaade/ui"
import {
  getProjectSearch,
  getProjectSearchRevision,
  loadMoreProjectSearch,
  subscribeProjectSearches,
  updateProjectSearch,
} from "./project-search-store.js"

export function ProjectSearchSurface({
  projectPath,
  searchId,
  onSelectResult,
}: {
  projectPath: string
  searchId: string
  onSelectResult: (result: ProjectSearchResult, disposition?: "preview" | "pinned") => void
}) {
  const entry = useSyncExternalStore(
    subscribeProjectSearches,
    () => {
      void getProjectSearchRevision(projectPath)
      return getProjectSearch(projectPath, searchId)
    },
    () => getProjectSearch(projectPath, searchId),
  )

  const onQueryChange = useCallback(
    (query: string) => {
      updateProjectSearch(projectPath, searchId, { query })
    },
    [projectPath, searchId],
  )

  const onOptionsChange = useCallback(
    (options: ProjectSearchOptions) => {
      updateProjectSearch(projectPath, searchId, { options })
    },
    [projectPath, searchId],
  )

  const onLoadMore = useCallback(() => {
    loadMoreProjectSearch(projectPath, searchId)
  }, [projectPath, searchId])

  const readFile = useCallback(
    async (relativePath: string) => {
      const fs = window.yaade?.fs
      if (!fs?.readFile) throw new Error("File read is unavailable")
      const root = (entry?.checkoutPath ?? projectPath).replace(/\/+$/, "")
      const rel = relativePath.replace(/^\/+/, "")
      return fs.readFile(pathToFileUri(`${root}/${rel}`))
    },
    [entry?.checkoutPath],
  )

  if (!entry) {
    return (
      <div className="grid h-full place-items-center px-4 text-sm text-muted-foreground">
        This search was closed.
      </div>
    )
  }

  return (
    <ProjectSearchPanel
      query={entry.query}
      options={entry.options}
      results={entry.results}
      truncated={entry.truncated}
      loading={entry.loading}
      loadingMore={entry.loadingMore}
      error={entry.error}
      projectPath={entry.checkoutPath}
      readFile={readFile}
      onQueryChange={onQueryChange}
      onOptionsChange={onOptionsChange}
      onSelectResult={onSelectResult}
      onLoadMore={onLoadMore}
    />
  )
}

export default ProjectSearchSurface
