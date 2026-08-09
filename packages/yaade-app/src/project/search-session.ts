import type { ProjectSearchResult } from "@yaade/shared"
import type { ProjectSessionPayload } from "@yaade/rpc"
import { pathToFileUri } from "@yaade/shared"
import { terminalTabId } from "@yaade/workspace"
import { emptyMuxTree } from "../mux/layout.js"
import { placeTerminalPane } from "../mux/place-pane.js"
import { allocTerminalSessionKey } from "../tab-routing.js"

/** Vim default errorformat-friendly lines (`%f:%l:%c:%m`). */
export function formatSearchHitsAsQuickfix(
  hits: ProjectSearchResult[],
): string {
  const lines: string[] = []
  for (const hit of hits) {
    const path = hit.path.replace(/\n/g, "")
    const preview = hit.preview.replace(/[\r\n]+/g, " ").trim()
    const line = Number.isFinite(hit.line) && hit.line > 0 ? hit.line : 1
    const column = Number.isFinite(hit.column) && hit.column > 0 ? hit.column : 1
    lines.push(`${path}:${line}:${column}:${preview}`)
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

/** Seed a single-pane Neovim session that loads `errorfilePath` as the qflist. */
export function buildNeovimQflistSessionPayload(
  cwdPath: string,
  errorfilePath: string,
): ProjectSessionPayload {
  const ptyTabId = terminalTabId(allocTerminalSessionKey())
  const cwdRootUri = pathToFileUri(cwdPath)
  const launchArgs = ["-q", errorfilePath, "+copen"]
  const base = {
    id: "search",
    title: "Neovim",
    tree: emptyMuxTree(),
    focusedPaneId: null,
    zoomedPaneId: null,
  }
  const live = placeTerminalPane(base, {
    ptyTabId,
    label: "Neovim",
    rootUri: cwdRootUri,
    launchCommand: "nvim",
    launchArgs,
  })
  return {
    version: 2,
    layout: {
      tree: live.tree.toJSON(),
      focusedPaneId: live.focusedPaneId?.id ?? null,
      zoomedPaneId: null,
    },
    sessions: [
      {
        ptyTabId,
        cwdRootUri,
        launchCommand: "nvim",
        launchArgs,
        label: "Neovim",
      },
    ],
  }
}

export async function writeQuickfixTempFile(content: string): Promise<string> {
  const fsApi = window.yaade?.fs
  if (!fsApi?.writeTempDrop) {
    throw new Error("File write is unavailable")
  }
  const bytes = new TextEncoder().encode(content)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return fsApi.writeTempDrop("yaade-search.qf", btoa(binary))
}
