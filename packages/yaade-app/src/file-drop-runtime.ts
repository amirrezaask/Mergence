import type { FileSystemProvider, LaunchConfig } from "@yaade/workspace"
import {
  handleDroppedPaths,
  hasFileDropData,
  materializeDroppedFilesToTemp,
  pathsFromDataTransfer,
  pathsFromDataTransferAsync,
  resolveDroppedFilesAgainstWorkspaces,
  resolveDropZoneAtPoint,
  resolveDropZoneFromElement,
  terminalPtyIdFromElement,
  type ProcessDroppedPathsContext,
} from "./drop-files.js"

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"))
    reader.readAsText(file)
  })
}

export type FileDropOptions = {
  fs: FileSystemProvider
  knownWorkspacePaths: string[]
  normalizePath: (p: string) => string
  openWorkspace: (path: string) => void
  addWorkspaceFolder: (path: string) => void
  openFile: (uri: string, path: string) => void
  bootstrapFromLaunch: (config: LaunchConfig) => void
  openUntitledFromDrop: (name: string, content: string) => void
  setMessage: (msg: string) => void
  onDragOverChange?: (active: boolean) => void
  /** Prefer matching drops under this project root when basenames collide. */
  activeWorkspacePath?: string | null
  /** Install the listener for a focused process surface that only accepts terminal drops. */
  terminalOnly?: boolean
}

/** Install HTML5 OS file-drop listeners. Returns disposer. */
export function installFileDrop(getOpts: () => FileDropOptions): () => void {
  let dragDepth = 0
  if (typeof window !== "undefined") {
    window.__yaadeOsFileDropInstalled = true
  }
  const dropContext = (): ProcessDroppedPathsContext => {
    const ctx = getOpts()
    return {
      fs: ctx.fs,
      normalizePath: ctx.normalizePath,
      knownWorkspacePaths: ctx.knownWorkspacePaths,
      openWorkspace: ctx.openWorkspace,
      addWorkspaceFolder: ctx.addWorkspaceFolder,
      openFile: ctx.openFile,
      bootstrapFromLaunch: ctx.bootstrapFromLaunch,
      setMessage: ctx.setMessage,
    }
  }

  const setDragActive = (active: boolean) => {
    getOpts().onDragOverChange?.(active)
  }

  const eventDropZone = (e: DragEvent) => {
    const pointZone = resolveDropZoneAtPoint(e.clientX, e.clientY)
    if (pointZone !== "other") return pointZone
    return resolveDropZoneFromElement(e.target instanceof Element ? e.target : null)
  }

  const onDragEnter = (e: DragEvent) => {
    if (!e.dataTransfer || !hasFileDropData(e.dataTransfer)) return
    if (getOpts().terminalOnly && eventDropZone(e) !== "terminal") return
    dragDepth++
    setDragActive(true)
  }

  const onDragLeave = () => {
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) setDragActive(false)
  }

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer || !hasFileDropData(e.dataTransfer)) return
    if (getOpts().terminalOnly && eventDropZone(e) !== "terminal") return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
  }

  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer || !hasFileDropData(e.dataTransfer)) return

    const pointEl = document.elementFromPoint(e.clientX, e.clientY)
    const target = pointEl instanceof Element ? pointEl : e.target instanceof Element ? e.target : null
    const zoneFromPoint = resolveDropZoneAtPoint(e.clientX, e.clientY)
    const zone =
      zoneFromPoint !== "other" ? zoneFromPoint : resolveDropZoneFromElement(target)
    if (getOpts().terminalOnly && zone !== "terminal") return

    e.preventDefault()
    e.stopPropagation()
    dragDepth = 0
    setDragActive(false)

    const dataTransfer = e.dataTransfer
    // DataTransfer is only valid synchronously during the drop event. Snapshot
    // before any await or the browser clears files/uri-list.
    const files = [...dataTransfer.files]
    const syncPaths = pathsFromDataTransfer(dataTransfer)

    void (async () => {
      let paths =
        syncPaths.length > 0 ? syncPaths : await pathsFromDataTransferAsync(dataTransfer)
      // Prefer the File snapshot taken synchronously — async dt.files is often empty.
      if (paths.length === 0 && files.length > 0) {
        const ctx = getOpts()
        paths = await resolveDroppedFilesAgainstWorkspaces(files, ctx.knownWorkspacePaths, {
          activeRoot: ctx.activeWorkspacePath ?? null,
        })
      }
      // Browser Finder drops have no absolute path — materialize into OS temp so
      // terminals can paste a real path and editors can open any file type (incl. images).
      if (paths.length === 0 && files.length > 0) {
        paths = await materializeDroppedFilesToTemp(files)
      }

      if (paths.length > 0) {
        const terminalEl =
          zone === "terminal"
            ? (pointEl?.closest("[data-yaade-terminal-panel]") ??
              document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-yaade-terminal-panel]") ??
              target)
            : target
        await handleDroppedPaths(
          paths,
          zone,
          terminalEl instanceof Element ? terminalEl : target,
          dropContext(),
        )
        return
      }

      if (files.length === 0) return

      const ctx = getOpts()
      if (zone === "terminal") {
        ctx.setMessage("Terminal file drop failed. Try again, or paste the path.")
        return
      }

      if (ctx.knownWorkspacePaths.length === 0) {
        ctx.setMessage("Drop files after opening a folder")
        return
      }

      for (const file of files) {
        try {
          const content = await readFileAsText(file)
          ctx.openUntitledFromDrop(file.name, content)
        } catch {
          ctx.setMessage(`Could not read: ${file.name}`)
        }
      }
    })()
  }

  window.addEventListener("dragenter", onDragEnter, true)
  window.addEventListener("dragleave", onDragLeave, true)
  window.addEventListener("dragover", onDragOver, true)
  window.addEventListener("drop", onDrop, true)
  return () => {
    window.removeEventListener("dragenter", onDragEnter, true)
    window.removeEventListener("dragleave", onDragLeave, true)
    window.removeEventListener("dragover", onDragOver, true)
    window.removeEventListener("drop", onDrop, true)
    if (typeof window !== "undefined") {
      delete window.__yaadeOsFileDropInstalled
    }
  }
}

declare global {
  interface Window {
    /** Set while mux/legacy OS file-drop listeners are installed (E2E). */
    __yaadeOsFileDropInstalled?: boolean
  }
}

// Re-export for tests / callers that need PTY probing helpers.
export { terminalPtyIdFromElement }
