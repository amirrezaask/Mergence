import { focusFirstListItem } from "../lib/list-registry.js"

export const EXPLORER_LIST_ID = "yaade:explorer"

/** Focus the explorer panel wherever it currently lives in the panel tree. */
export function focusExplorerPanel(): void {
  focusFirstListItem(EXPLORER_LIST_ID)
}
