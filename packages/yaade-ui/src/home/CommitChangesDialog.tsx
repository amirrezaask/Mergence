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
  loadCommitDiffContents,
  loadWorkingTreeDiffContents,
  loadWorkingTreeSnapshot,
} from "./commit-diff.js"
import { PierreCommitFileTree } from "./pierre-commit-file-tree.js"
import { YaadeDiffViewer } from "./YaadeDiffViewer.js"
import { PierreDiffPool } from "./pierre-diff-pool.js"

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

type DiffContents = { original: string; modified: string }
type DiffStyle = "unified" | "split"
const BULK_ACTION = "__bulk__"

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
    const diffPromise = workingTree
      ? fsApi
        ? loadWorkingTreeDiffContents(api, fsApi, rootUri, file)
        : Promise.reject(new Error("Filesystem access is unavailable."))
      : loadCommitDiffContents(api, rootUri, hash, file)
    void diffPromise
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
  ])

  const subject = detail?.subject ?? commit?.subject ?? (workingTree ? "Uncommitted changes" : "Commit")
  const shortHash = workingTree ? "WORKTREE" : commit?.shortHash ?? hash.slice(0, 7)
  const author = commit?.author
  const authoredAt = commit?.authoredAt
  const effectiveDiffStyle = compactLayout ? "unified" : diffStyle
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
      className="flex h-full min-h-0 flex-col bg-transparent"
    >
      <div className="shrink-0 px-3 py-2 font-mono text-3xs tracking-wide text-muted-foreground uppercase">
        {detail.files.length} {detail.files.length === 1 ? "file" : "files"}
      </div>
      {detail.body ? (
        <pre className="mx-3 mb-2 max-h-24 shrink-0 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-3xs whitespace-pre-wrap text-foreground/90">
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
            className="flex h-7 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3"
          >
            <FileDiffIcon className="size-3.5 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-mono text-2xs">
              {selectedFile.path}
            </span>
            <span className="shrink-0 font-mono text-3xs text-muted-foreground">
              {selectedFile.status}
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
              (diffContents.original.length > 0 || diffContents.modified.length > 0) ? (
              <YaadeDiffViewer
                path={selectedFile.path}
                original={diffContents.original}
                modified={diffContents.modified}
                mode={effectiveDiffStyle}
                theme={theme}
                fontSize={fontSize}
                conflict={selectedFile.status === "conflict"}
                onConflictResolved={
                  selectedFile.status === "conflict"
                    ? contents => void persistConflictResolution(contents)
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
        className="flex h-[94dvh] max-h-[94dvh] w-[96vw] max-w-[96vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[96vw]"
      >
        <DialogHeader className="shrink-0 gap-2 border-b border-border px-4 py-3 pr-12 text-left sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <DialogTitle className="truncate text-base">{subject}</DialogTitle>
            <DialogDescription className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-2xs text-muted-foreground">
              <span>{shortHash}</span>
              {author ? <span>· {author}</span> : null}
              {authoredAt != null ? (
                <span>· {dateFormatter.format(new Date(authoredAt))}</span>
              ) : null}
            </DialogDescription>
          </div>
          <div
            className="flex w-fit shrink-0 items-center rounded-md border border-border bg-muted/30 p-0.5"
            role="group"
            aria-label="Diff layout"
          >
            <Button
              type="button"
              size="xs"
              variant={effectiveDiffStyle === "unified" ? "secondary" : "ghost"}
              aria-pressed={effectiveDiffStyle === "unified"}
              onClick={() => changeDiffStyle("unified")}
            >
              Unified
            </Button>
            <Button
              type="button"
              size="xs"
              variant={effectiveDiffStyle === "split" ? "secondary" : "ghost"}
              aria-pressed={effectiveDiffStyle === "split"}
              disabled={compactLayout}
              title={compactLayout ? "Split view needs a wider window" : undefined}
              onClick={() => changeDiffStyle("split")}
            >
              Split
            </Button>
          </div>
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
            className="shrink-0 border-t border-border/60 bg-background/80 px-4 py-2 sm:flex-row sm:items-center sm:justify-between"
            data-yaade-working-tree-actions=""
          >
            <span className="font-mono text-2xs text-muted-foreground">
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
