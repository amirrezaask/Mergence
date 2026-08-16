import { basename, fileUriToPath, pathToFileUri } from "@yaade/shared"
import type { FileSystemProvider, LaunchConfig } from "@yaade/workspace"
import { isPathUnderRoot, normalizeAbsPath } from "@yaade/workspace"
import { formatDroppedPaths } from "@yaade/ui/terminal-file-drop"

const WORKSPACE_MARKERS = [
  ".git",
  "package.json",
  "tsconfig.json",
  "Cargo.toml",
  "go.mod",
  ".yaade",
] as const

function dirname(absPath: string): string {
  const normalized = absPath.replace(/\\/g, "/")
  const idx = normalized.lastIndexOf("/")
  if (idx <= 0) return normalized.startsWith("/") ? "/" : "."
  return normalized.slice(0, idx) || "/"
}

async function markerExists(
  dir: string,
  marker: string,
  fs: FileSystemProvider,
): Promise<boolean> {
  const uri = pathToFileUri(`${dir.replace(/\\/g, "/")}/${marker}`)
  try {
    if (fs.exists) return await fs.exists(uri)
    const info = await fs.stat(uri)
    if (marker === ".git") return info.isDirectory
    return !info.isDirectory
  } catch {
    return false
  }
}

export async function findWorkspaceRoot(startDir: string, fs: FileSystemProvider): Promise<string> {
  let current = startDir.replace(/\\/g, "/")
  for (let i = 0; i < 20; i++) {
    for (const marker of WORKSPACE_MARKERS) {
      if (await markerExists(current, marker, fs)) return current
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return startDir.replace(/\\/g, "/")
}

export async function resolveDroppedPath(
  absPath: string,
  fs: FileSystemProvider,
): Promise<LaunchConfig> {
  const uri = pathToFileUri(absPath)
  const stat = await fs.stat(uri)
  if (stat.isDirectory) {
    return { workspacePath: absPath }
  }
  const parentDir = dirname(absPath)
  const workspacePath = await findWorkspaceRoot(parentDir, fs)
  return { workspacePath, filePath: absPath }
}

/** Collect absolute paths from File.path and text/uri-list (Finder / file managers). */
export function pathsFromDataTransfer(dt: DataTransfer): string[] {
  const paths: string[] = []
  for (const file of Array.from(dt.files)) {
    const p = (file as File & { path?: string }).path
    if (typeof p === "string" && p.length > 0) paths.push(p)
  }
  if (paths.length > 0) return paths

  let uriList = ""
  try {
    uriList = dt.getData("text/uri-list") || dt.getData("text/plain") || ""
  } catch {
    uriList = ""
  }
  return parseUriListText(uriList)
}

/**
 * Browser file drags are not consistent about exposing the `Files` type.
 * Chromium may expose a local file as `text/uri-list` or an absolute
 * `text/plain` path instead, so use the same synchronous path parser for the
 * dragover/drop gate.
 */
export function hasFileDropData(dt: DataTransfer): boolean {
  if (Array.from(dt.types).includes("Files")) return true
  if (
    Array.from(dt.types).includes("text/uri-list") ||
    Array.from(dt.types).includes("text/plain")
  ) {
    return pathsFromDataTransfer(dt).length > 0
  }
  return false
}

function parseUriListText(uriList: string): string[] {
  const paths: string[] = []
  if (!uriList) return paths
  for (const line of uriList.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    if (trimmed.startsWith("file:")) {
      paths.push(fileUriToPath(trimmed))
      continue
    }
    if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
      paths.push(trimmed)
    }
  }
  return paths
}

/** Async path harvest — string items may only resolve via getAsString. */
export async function pathsFromDataTransferAsync(dt: DataTransfer): Promise<string[]> {
  const sync = pathsFromDataTransfer(dt)
  if (sync.length > 0) return sync

  const chunks: string[] = []
  const items = Array.from(dt.items ?? [])
  await Promise.all(
    items.map(
      item =>
        new Promise<void>(resolve => {
          if (item.kind !== "string") {
            resolve()
            return
          }
          try {
            item.getAsString(value => {
              if (value) chunks.push(value)
              resolve()
            })
          } catch {
            resolve()
          }
        }),
    ),
  )
  const fromItems = chunks.flatMap(parseUriListText)
  if (fromItems.length > 0) return [...new Set(fromItems)]
  return []
}

/**
 * Browsers on http(s) strip absolute paths from Finder drops.
 * Match dropped File names against open workspace indexes when possible.
 */
export async function resolveDroppedFilesAgainstWorkspaces(
  files: File[],
  workspaceRoots: string[],
  opts?: {
    listFiles?: (rootUri: string) => Promise<string[]>
    fileSearch?: (rootUri: string, query: string) => Promise<string[]>
    statSize?: (absPath: string) => Promise<number | null>
    activeRoot?: string | null
  },
): Promise<string[]> {
  if (files.length === 0 || workspaceRoots.length === 0) return []
  const listFiles =
    opts?.listFiles ??
    (typeof window !== "undefined" ? window.yaade?.search?.listFiles?.bind(window.yaade.search) : undefined)
  const fileSearch =
    opts?.fileSearch ??
    (typeof window !== "undefined"
      ? window.yaade?.search?.fileSearch?.bind(window.yaade.search)
      : undefined)
  if (!listFiles && !fileSearch) return []

  const statSize =
    opts?.statSize ??
    (async (absPath: string) => {
      try {
        const st = await window.yaade?.fs?.stat?.(pathToFileUri(absPath))
        return typeof st?.size === "number" ? st.size : null
      } catch {
        return null
      }
    })

  const rootFiles = new Map<string, string[]>()
  for (const root of workspaceRoots) {
    const rootUri = pathToFileUri(root)
    let rels: string[] = []
    try {
      if (listFiles) {
        const listed = await listFiles(rootUri)
        rels = Array.isArray(listed) ? listed : listed.items
      }
    } catch {
      rels = []
    }
    rootFiles.set(root, rels)
  }

  const resolved: string[] = []
  for (const file of files) {
    const name = file.name
    if (!name) continue
    let candidates: string[] = []
    for (const root of workspaceRoots) {
      const rels = rootFiles.get(root) ?? []
      const rootNorm = root.replace(/\/+$/, "")
      for (const rel of rels) {
        const base = rel.split(/[/\\]/).pop()
        if (base !== name) continue
        candidates.push(`${rootNorm}/${rel.replace(/^[/\\]+/, "")}`)
      }
    }

    // Index miss / scan not ready — try fuzzy file search by basename.
    if (candidates.length === 0 && fileSearch) {
      for (const root of workspaceRoots) {
        const rootNorm = root.replace(/\/+$/, "")
        try {
          const searched = await fileSearch(pathToFileUri(root), name)
          const hits = Array.isArray(searched) ? searched : searched.items
          for (const hit of hits) {
            const base = hit.split(/[/\\]/).pop()
            if (base !== name) continue
            const abs = hit.startsWith("/") || /^[A-Za-z]:[\\/]/.test(hit)
              ? hit
              : `${rootNorm}/${hit.replace(/^[/\\]+/, "")}`
            candidates.push(abs)
          }
        } catch {
          /* ignore */
        }
      }
      candidates = [...new Set(candidates)]
    }

    if (candidates.length === 0) continue
    if (candidates.length === 1) {
      resolved.push(candidates[0]!)
      continue
    }

    const sized: string[] = []
    for (const abs of candidates) {
      const size = await statSize(abs)
      if (size !== null && size === file.size) sized.push(abs)
    }
    const pool = sized.length > 0 ? sized : candidates
    const active = opts?.activeRoot?.replace(/\/+$/, "")
    const preferred = active
      ? pool.find(p => p === active || p.startsWith(`${active}/`))
      : undefined
    resolved.push(preferred ?? pool.sort((a, b) => a.length - b.length)[0]!)
  }
  return resolved
}

/** Write pathless browser Files to OS temp via host; return absolute paths for PTY paste. */
export async function materializeDroppedFilesToTemp(files: File[]): Promise<string[]> {
  const writeTemp = window.yaade?.fs?.writeTempDrop
  if (!writeTemp || files.length === 0) return []
  const paths: string[] = []
  for (const file of files) {
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = String(reader.result ?? "")
          const comma = dataUrl.indexOf(",")
          resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl)
        }
        reader.onerror = () => reject(reader.error ?? new Error("read failed"))
        reader.readAsDataURL(file)
      })
      const path = await writeTemp(file.name || "drop.bin", base64)
      if (path) paths.push(path)
    } catch {
      /* skip failed file */
    }
  }
  return paths
}

export type DropZone = "terminal" | "editor" | "other"

export function resolveDropZoneFromElement(el: Element | null): DropZone {
  if (!el) return "other"
  if (el.closest("[data-yaade-terminal-panel]")) return "terminal"
  if (
    el.closest(
      "[data-yaade-code-editor], [data-yaade-editor-pane]",
    )
  ) {
    return "editor"
  }
  return "other"
}

export function resolveDropZoneAtPoint(x: number, y: number): DropZone {
  return resolveDropZoneFromElement(document.elementFromPoint(x, y))
}

export function terminalPtyIdFromElement(el: Element | null): string | null {
  const panel = el?.closest("[data-yaade-terminal-panel]")
  const id = panel?.getAttribute("data-yaade-terminal-pty-id")
  return id && id.length > 0 ? id : null
}

export type ProcessDroppedPathsContext = {
  fs: FileSystemProvider
  normalizePath: (p: string) => string
  knownWorkspacePaths: string[]
  openWorkspace: (path: string) => void
  addWorkspaceFolder: (path: string) => void
  openFile: (uri: string, path: string) => void
  bootstrapFromLaunch: (config: LaunchConfig) => void
  setMessage: (msg: string) => void
}

function workspacePathIsOpen(normPath: string, known: string[]): boolean {
  return known.some(
    k => normPath === k || isPathUnderRoot(normPath, k) || isPathUnderRoot(k, normPath),
  )
}

export async function processDroppedPaths(
  paths: string[],
  ctx: ProcessDroppedPathsContext,
): Promise<void> {
  if (paths.length === 0) return

  const normalized = [...new Set(paths.map(p => ctx.normalizePath(p)))]
  const resolved: LaunchConfig[] = []

  for (const p of normalized) {
    try {
      resolved.push(await resolveDroppedPath(p, ctx.fs))
    } catch {
      ctx.setMessage(`Could not open: ${basename(p)}`)
    }
  }
  if (resolved.length === 0) return

  let workspacePath = resolved[0]!.workspacePath
  const filesToOpen: string[] = []

  for (const cfg of resolved) {
    if (cfg.filePath) filesToOpen.push(cfg.filePath)
    if (!cfg.filePath) workspacePath = cfg.workspacePath
  }

  const known = ctx.knownWorkspacePaths.map(p => ctx.normalizePath(p))
  const next = ctx.normalizePath(workspacePath)

  if (filesToOpen.length === 0) {
    if (known.some(k => normalizeAbsPath(k) === next)) return
    if (known.length > 0) {
      ctx.addWorkspaceFolder(next)
    } else {
      ctx.openWorkspace(next)
    }
    return
  }

  if (workspacePathIsOpen(next, known)) {
    for (const fp of filesToOpen) {
      ctx.openFile(pathToFileUri(fp), fp)
    }
    return
  }

  if (known.length > 0) {
    ctx.addWorkspaceFolder(next)
    for (const fp of filesToOpen) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => ctx.openFile(pathToFileUri(fp), fp))
      })
    }
    return
  }

  ctx.bootstrapFromLaunch({ workspacePath: next, filePath: filesToOpen[0] })
  for (let i = 1; i < filesToOpen.length; i++) {
    const fp = filesToOpen[i]!
    requestAnimationFrame(() => {
      requestAnimationFrame(() => ctx.openFile(pathToFileUri(fp), fp))
    })
  }
}

export async function handleDroppedPaths(
  paths: string[],
  zone: DropZone,
  targetEl: Element | null,
  ctx: ProcessDroppedPathsContext,
): Promise<void> {
  if (paths.length === 0) return

  if (zone === "terminal") {
    const ptyId = terminalPtyIdFromElement(targetEl)
    const terminal = typeof window !== "undefined" ? window.yaade?.terminal : undefined
    if (ptyId && terminal) {
      const text = formatDroppedPaths(paths)
      if (text) await terminal.write(ptyId, text)
      targetEl
        ?.closest("[data-yaade-terminal-panel]")
        ?.querySelector<HTMLTextAreaElement>("[data-yaade-terminal-input]")
        ?.focus()
      return
    }
    ctx.setMessage("Terminal not ready for file drop")
    return
  }

  await processDroppedPaths(paths, ctx)
}
