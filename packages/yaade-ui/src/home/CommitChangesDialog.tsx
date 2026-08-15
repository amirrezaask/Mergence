import { useEffect, useRef, useState } from "react"
import type {
  GitCommit,
  GitCommitDetail,
  GitCommitFile,
  GitStatusEntry,
  YaadeTheme,
} from "@yaade/shared"
import { fileUriToPath, pathToFileUri } from "@yaade/shared"
import { CircleDotIcon, FileDiffIcon, HistoryIcon } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js"
import { Button } from "@/components/ui/button.js"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty.js"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable.js"
import { Spinner } from "@/components/ui/spinner.js"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group.js"
import { cn } from "@/lib/utils.js"
import {
  loadCommitDiffContents,
  loadWorkingTreeDiffContents,
  loadWorkingTreeSnapshot,
} from "./commit-diff.js"
import { PierreCommitFileTree } from "./pierre-commit-file-tree.js"
import { YaadeDiffViewer } from "./YaadeDiffViewer.js"
import { PierreDiffPool } from "./pierre-diff-pool.js"
import { listApplyHunks } from "./pierre-hunk-patch.js"

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

export type CommitChangesDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  rootUri: string
  hash: string
  workingTree?: boolean
  onWorkingTreeChange?: () => void
  onCommit?: () => void
  theme: YaadeTheme
  fontSize?: number
  /** Optional row metadata when already known from a history list. */
  commit?: Pick<GitCommit, "shortHash" | "author" | "authoredAt" | "subject">
}

type DiffContents = {
  patch?: string
  /** Prefer unstaged hunks when both sides are dirty. */
  hunkStaged?: boolean
  original: string
  modified: string
}
type DiffStyle = "unified" | "split"
const BULK_ACTION = "__bulk__"

function fileStatusLabel(status: GitCommitFile["status"]): string {
  if (status === "untracked") return "Untracked"
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function fileStatusColor(status: GitCommitFile["status"]): string {
  if (status === "conflict") return "text-git-conflict"
  if (status === "deleted") return "text-git-deleted"
  if (status === "added" || status === "untracked") return "text-git-added"
  return "text-git-modified"
}

function storedDiffStyle(): DiffStyle {
  try {
    return localStorage.getItem("yaade:git-diff-style") === "split"
      ? "split"
      : "unified"
  } catch {
    return "unified"
  }
}

export function CommitChangesDialog(props: CommitChangesDialogProps) {
  const {
    open,
    onOpenChange,
    rootUri,
    hash,
    workingTree = false,
    onWorkingTreeChange,
    onCommit,
    theme,
    fontSize = 13,
    commit,
  } = props
  const api = window.yaade?.git
  const fsApi = window.yaade?.fs
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [workingTreeEntries, setWorkingTreeEntries] = useState<GitStatusEntry[]>([])
  const [workingTreePendingPath, setWorkingTreePendingPath] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [diffContents, setDiffContents] = useState<DiffContents | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffStyle, setDiffStyle] = useState<DiffStyle>(storedDiffStyle)
  const [compactLayout, setCompactLayout] = useState(false)
  const detailRequest = useRef(0)
  const diffRequest = useRef(0)

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)")
    const sync = () => setCompactLayout(query.matches)
    sync()
    query.addEventListener("change", sync)
    return () => query.removeEventListener("change", sync)
  }, [])

  const changeDiffStyle = (style: DiffStyle) => {
    setDiffStyle(style)
    try {
      localStorage.setItem("yaade:git-diff-style", style)
    } catch {
      /* keep the in-memory preference */
    }
  }

  useEffect(() => {
    if (!open || !api || !hash) {
      setDetail(null)
      setSelectedPath(null)
      setDiffContents(null)
      setDetailError(null)
      setDiffError(null)
      setWorkingTreeEntries([])
      return
    }
    const request = ++detailRequest.current
    setDetailLoading(true)
    setDetailError(null)
    setDetail(null)
    setSelectedPath(null)
    setDiffContents(null)
    setDiffError(null)
    const detailPromise = workingTree
      ? loadWorkingTreeSnapshot(api, rootUri).then(snapshot => {
          setWorkingTreeEntries(snapshot.entries)
          return snapshot.detail
        })
      : api.commitFiles(rootUri, hash)
    void detailPromise
      .then(next => {
        if (request !== detailRequest.current) return
        setDetail(next)
        setSelectedPath(next.files[0]?.path ?? null)
      })
      .catch(err => {
        if (request !== detailRequest.current) return
        setDetailError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (request === detailRequest.current) setDetailLoading(false)
      })
  }, [open, api, rootUri, hash, workingTree])

  const toggleWorkingTreeStage = async (file: GitCommitFile) => {
    if (!api || !workingTree) return
    const entry = workingTreeEntries.find(item => item.path === file.path)
    if (!entry) return
    setWorkingTreePendingPath(file.path)
    try {
      if (entry.staged) {
        await api.unstage(rootUri, [file.path])
      } else {
        await api.stage(rootUri, [file.path])
      }
      const snapshot = await loadWorkingTreeSnapshot(api, rootUri)
      setWorkingTreeEntries(snapshot.entries)
      setDetail(snapshot.detail)
      onWorkingTreeChange?.()
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : String(error))
    } finally {
      setWorkingTreePendingPath(null)
    }
  }

  const runWorkingTreeBulkAction = async (action: "stage" | "unstage") => {
    if (!api || !workingTree || workingTreePendingPath !== null) return
    const paths = workingTreeEntries
      .filter(entry => action === "stage" ? entry.unstaged : entry.staged)
      .map(entry => entry.path)
    if (paths.length === 0) return

    setWorkingTreePendingPath(BULK_ACTION)
    try {
      await (action === "stage" ? api.stage(rootUri, paths) : api.unstage(rootUri, paths))
      const snapshot = await loadWorkingTreeSnapshot(api, rootUri)
      setWorkingTreeEntries(snapshot.entries)
      setDetail(snapshot.detail)
      setSelectedPath(current => snapshot.detail.files.some(file => file.path === current) ? current : snapshot.detail.files[0]?.path ?? null)
      onWorkingTreeChange?.()
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : String(error))
    } finally {
      setWorkingTreePendingPath(null)
    }
  }

  const selectedFile =
    detail?.files.find(file => file.path === selectedPath) ?? detail?.files[0] ?? null

  useEffect(() => {
    if (!open || !api || !hash || !selectedFile) {
      setDiffContents(null)
      setDiffError(null)
      return
    }
    const file = selectedFile
    const request = ++diffRequest.current
    setDiffLoading(true)
    setDiffError(null)
    const load = async (): Promise<DiffContents> => {
      if (workingTree) {
        const entry = workingTreeEntries.find(row => row.path === file.path)
        const preferStaged = Boolean(entry?.staged && !entry.unstaged)
        if (entry && entry.status !== "untracked" && entry.status !== "conflict") {
          try {
            const patch = await api.diff(rootUri, {
              path: file.path,
              staged: preferStaged,
            })
            if (patch.trim()) {
              return {
                patch,
                hunkStaged: preferStaged,
                original: "",
                modified: "",
              }
            }
          } catch {
            /* fall through to two-file */
          }
        }
        if (!fsApi) throw new Error("Filesystem access is unavailable.")
        const sides = await loadWorkingTreeDiffContents(api, fsApi, rootUri, file)
        return { ...sides, hunkStaged: preferStaged }
      }
      return loadCommitDiffContents(api, rootUri, hash, file)
    }
    void load()
      .then(contents => {
        if (request !== diffRequest.current) return
        setDiffContents(contents)
      })
      .catch(err => {
        if (request !== diffRequest.current) return
        setDiffContents(null)
        setDiffError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (request === diffRequest.current) setDiffLoading(false)
      })
  }, [
    open,
    api,
    rootUri,
    hash,
    selectedFile?.path,
    selectedFile?.status,
    selectedFile?.originalPath,
    fsApi,
    workingTree,
    workingTreeEntries,
  ])

  const applyHunkAction = async (
    kind: "stage" | "unstage" | "discard",
    hunkIndex: number,
  ) => {
    if (!api || !workingTree || !diffContents?.patch?.trim()) return
    const hunk = listApplyHunks(diffContents.patch)[hunkIndex]
    if (!hunk) return
    setWorkingTreePendingPath(selectedFile?.path ?? BULK_ACTION)
    try {
      if (kind === "stage") {
        await api.applyPatch(rootUri, hunk.patch, { cached: true })
      } else if (kind === "unstage") {
        await api.applyPatch(rootUri, hunk.patch, { reverse: true, cached: true })
      } else {
        await api.applyPatch(rootUri, hunk.patch, { reverse: true, cached: false })
      }
      const snapshot = await loadWorkingTreeSnapshot(api, rootUri)
      setWorkingTreeEntries(snapshot.entries)
      setDetail(snapshot.detail)
      setSelectedPath(current =>
        snapshot.detail.files.some(file => file.path === current)
          ? current
          : snapshot.detail.files[0]?.path ?? null,
      )
      onWorkingTreeChange?.()
    } catch (error) {
      setDiffError(error instanceof Error ? error.message : String(error))
    } finally {
      setWorkingTreePendingPath(null)
    }
  }

  const subject = detail?.subject ?? commit?.subject ?? (workingTree ? "Uncommitted changes" : "Commit")
  const shortHash = workingTree ? "WORKTREE" : commit?.shortHash ?? hash.slice(0, 7)
  const author = commit?.author
  const authoredAt = commit?.authoredAt
  const effectiveDiffStyle = compactLayout ? "unified" : diffStyle
  // The commit modal is a dedicated review surface; keep code at a readable
  // minimum even when compact editor chrome uses a smaller global font.
  const reviewFontSize = Math.max(fontSize, 16)
  const stagedCount = workingTreeEntries.filter(entry => entry.staged).length
  const unstagedCount = workingTreeEntries.filter(entry => entry.unstaged).length

  const persistConflictResolution = async (contents: string) => {
    if (!fsApi || !selectedFile || selectedFile.status !== "conflict") return
    const rootPath = fileUriToPath(rootUri).replace(/[/\\]+$/, "")
    const fileUri = pathToFileUri(`${rootPath}/${selectedFile.path.replace(/^[/\\]+/, "")}`)
    try {
      await fsApi.writeFile(fileUri, contents)
      setDiffContents({ original: "", modified: contents })
      onWorkingTreeChange?.()
    } catch (error) {
      setDiffError(error instanceof Error ? error.message : String(error))
    }
  }

  const fileList = detail ? (
    <aside
      data-yaade-list-panel="commit-changes-files"
      className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground"
    >
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-sidebar-border px-3">
        <span className="text-sm font-medium">Changed files</span>
        <span className="font-mono text-2xs text-muted-foreground">
          {detail.files.length}
        </span>
      </div>
      {detail.body ? (
        <pre className="mx-3 my-2 max-h-24 shrink-0 overflow-auto rounded-md border border-sidebar-border bg-background/55 p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground/90">
          {detail.body}
        </pre>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden px-1 pb-2">
        <PierreCommitFileTree
          files={detail.files}
          workingTreeEntries={workingTreeEntries}
          selectedPath={selectedFile?.path ?? null}
          onSelectPath={setSelectedPath}
          workingTree={workingTree}
          pendingPath={workingTreePendingPath}
          onToggleStage={file => void toggleWorkingTreeStage(file)}
        />
      </div>
    </aside>
  ) : null

  const diffPane = (
    <div data-yaade-git-diff="" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {selectedFile ? (
        <>
          <div
            className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 bg-muted/25 px-3"
          >
            <FileDiffIcon className="size-4 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">
              {selectedFile.path}
            </span>
            <span
              className={cn(
                "shrink-0 text-xs font-medium",
                fileStatusColor(selectedFile.status),
              )}
            >
              {fileStatusLabel(selectedFile.status)}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {diffLoading ? (
              <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
                <Spinner /> Loading diff…
              </div>
            ) : diffError ? (
              <CenteredEmpty title="Failed to load diff" description={diffError} />
            ) : diffContents &&
              ((diffContents.patch?.trim().length ?? 0) > 0 ||
                diffContents.original.length > 0 ||
                diffContents.modified.length > 0) ? (
              <YaadeDiffViewer
                path={selectedFile.path}
                patch={diffContents.patch}
                original={diffContents.original}
                modified={diffContents.modified}
                mode={effectiveDiffStyle}
                theme={theme}
                fontSize={reviewFontSize}
                conflict={selectedFile.status === "conflict"}
                onConflictResolved={
                  selectedFile.status === "conflict"
                    ? contents => void persistConflictResolution(contents)
                    : undefined
                }
                hunkActions={
                  workingTree &&
                  diffContents.patch?.trim() &&
                  selectedFile.status !== "untracked" &&
                  selectedFile.status !== "conflict"
                    ? {
                        staged: Boolean(diffContents.hunkStaged),
                        disabled: workingTreePendingPath !== null,
                        onStageHunk: diffContents.hunkStaged
                          ? undefined
                          : index => void applyHunkAction("stage", index),
                        onUnstageHunk: diffContents.hunkStaged
                          ? index => void applyHunkAction("unstage", index)
                          : undefined,
                        onDiscardHunk: diffContents.hunkStaged
                          ? undefined
                          : index => void applyHunkAction("discard", index),
                      }
                    : undefined
                }
              />
            ) : (
              <CenteredEmpty
                title="No textual diff"
                description="This file may be binary or empty in this commit."
              />
            )}
          </div>
        </>
      ) : (
        <CenteredEmpty
          title="Select a file"
          description="Choose a file from this commit to inspect its diff."
        />
      )}
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="wide"
        data-yaade-commit-changes-dialog=""
        className="flex h-[94dvh] max-h-[94dvh] w-[96vw] max-w-[96vw] flex-col gap-0 overflow-hidden bg-background p-0 sm:max-w-[96vw]"
      >
        <DialogHeader className="shrink-0 gap-3 border-b border-border bg-card px-4 py-3 pr-12 text-left sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <DialogTitle className="truncate text-lg leading-tight">{subject}</DialogTitle>
            <DialogDescription className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <span className="font-mono font-medium text-foreground/80">{shortHash}</span>
              {author ? <span>· {author}</span> : null}
              {authoredAt != null ? (
                <span>· {dateFormatter.format(new Date(authoredAt))}</span>
              ) : null}
            </DialogDescription>
          </div>
          <ToggleGroup
            type="single"
            value={effectiveDiffStyle}
            variant="outline"
            size="sm"
            className="shrink-0 bg-background"
            aria-label="Diff layout"
            onValueChange={value => {
              if (value === "unified" || value === "split") changeDiffStyle(value)
            }}
          >
            <ToggleGroupItem value="unified" aria-label="Unified diff">
              Unified
            </ToggleGroupItem>
            <ToggleGroupItem
              value="split"
              aria-label="Split diff"
              disabled={compactLayout}
              title={compactLayout ? "Split view needs a wider window" : undefined}
            >
              Split
            </ToggleGroupItem>
          </ToggleGroup>
        </DialogHeader>

        <PierreDiffPool>
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {detailLoading && !detail ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
                <Spinner /> Loading {workingTree ? "changes" : "commit"}…
              </div>
            ) : detailError ? (
              <div className="flex flex-1 items-center justify-center p-6 text-sm text-destructive">
                {detailError}
              </div>
            ) : !detail ? (
              <CenteredEmpty
                title={workingTree ? "Changes unavailable" : "Commit unavailable"}
                description={
                  workingTree
                    ? "Could not load the current working-tree changes."
                    : "Could not load this commit’s changes."
                }
              />
            ) : (
              <ResizablePanelGroup
                key={compactLayout ? "compact" : "wide"}
                orientation={compactLayout ? "vertical" : "horizontal"}
                className="min-h-0 flex-1 bg-transparent"
              >
                <ResizablePanel
                  defaultSize={compactLayout ? "34%" : "24%"}
                  minSize={compactLayout ? "128px" : "180px"}
                  maxSize={compactLayout ? "45%" : "38%"}
                >
                  {fileList}
                </ResizablePanel>
                <ResizableHandle />
                <ResizablePanel
                  defaultSize={compactLayout ? "66%" : "76%"}
                  minSize={compactLayout ? "220px" : "320px"}
                >
                  {diffPane}
                </ResizablePanel>
              </ResizablePanelGroup>
            )}
          </div>
        </PierreDiffPool>
        {workingTree ? (
          <DialogFooter
            className="shrink-0 border-t border-border/60 bg-card px-4 py-2 sm:flex-row sm:items-center sm:justify-between"
            data-yaade-working-tree-actions=""
          >
            <span className="font-mono text-xs text-muted-foreground">
              {stagedCount} staged · {unstagedCount} unstaged
            </span>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={workingTreePendingPath !== null || unstagedCount === 0}
                aria-label={`Stage all ${unstagedCount} changed ${unstagedCount === 1 ? "file" : "files"}`}
                data-yaade-commit-changes-stage-all=""
                onClick={() => void runWorkingTreeBulkAction("stage")}
              >
                Stage all
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={workingTreePendingPath !== null || stagedCount === 0}
                aria-label={`Unstage all ${stagedCount} staged ${stagedCount === 1 ? "file" : "files"}`}
                data-yaade-commit-changes-unstage-all=""
                onClick={() => void runWorkingTreeBulkAction("unstage")}
              >
                Unstage all
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={workingTreePendingPath !== null || stagedCount === 0 || !onCommit}
                aria-label={stagedCount === 0 ? "No staged files to commit" : `Commit ${stagedCount} staged ${stagedCount === 1 ? "file" : "files"}`}
                data-yaade-commit-changes-commit=""
                onClick={onCommit}
              >
                <CircleDotIcon data-icon="inline-start" />
                Commit
              </Button>
            </div>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function CenteredEmpty({ title, description }: { title: string; description: string }) {
  return (
    <Empty className="h-full rounded-none border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HistoryIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle className="text-sm">{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
