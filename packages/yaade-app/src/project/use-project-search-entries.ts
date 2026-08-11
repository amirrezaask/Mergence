import { useSyncExternalStore } from "react"
import {
  getProjectSearchRevision,
  listProjectSearches,
  subscribeProjectSearches,
} from "./project-search-store.js"

export function useProjectSearchEntries(projectPath: string) {
  return useSyncExternalStore(
    subscribeProjectSearches,
    () => {
      void getProjectSearchRevision(projectPath)
      return listProjectSearches(projectPath)
    },
    () => listProjectSearches(projectPath),
  )
}
