import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type {
  GitCommit,
  GitNumstatEntry,
  GitRepositorySummary,
  GitStatusEntry,
  YaadeTheme,
} from "@yaade/shared"
import { fileUriToPath, pathToFileUri } from "@yaade/shared"
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleDotIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  GitBranchIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ScissorsIcon,
  SearchIcon,
  UploadIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button.js"
import { Checkbox } from "@/components/ui/checkbox.js"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog.js"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty.js"
import { Input } from "@/components/ui/input.js"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable.js"
import { Label } from "@/components/ui/label.js"
import { Spinner } from "@/components/ui/spinner.js"
import { Textarea } from "@/components/ui/textarea.js"
import { cn } from "@/lib/utils.js"
import { requestConfirm } from "@/components/ConfirmDialogHost.js"
import { showYaadeToast } from "@/toast.js"
import { SessionHeaderChromePortal } from "./session-header-chrome.js"
import { SidebarShell } from "../shell/SidebarShell.js"
import { PierreDiffPool } from "./pierre-diff-pool.js"

const CommitChangesDialog = lazy(() =>
  import("./CommitChangesDialog.js").then(module => ({
    default: module.CommitChangesDialog,
  })),
)
const YaadeDiffViewer = lazy(() =>
  import("./YaadeDiffViewer.js").then(module => ({
    default: module.YaadeDiffViewer,
  })),
)

type GitView = "changes" | "staged" | "history"
type DiffStyle = "unified" | "split"
type SelectedChange = { path: string; staged: boolean }
type NavigationRow =
  | { kind: "section"; id: string; label: string; count: number }
  | { kind: "file"; id: string; entry: GitStatusEntry; staged: boolean }

/** Synthetic history-row id for uncommitted working-tree changes. */
export const GIT_WORKING_TREE_ID = "working-tree"

type GitWorkspaceProps = {
  rootUri: string | null
  theme: YaadeTheme
  onOpenFile: (path: string) => void
  onBranchChange?: (branch: string | null) => void
  /** When set, select this path in Changes (agent openDiff / deep-link). */
  focusPath?: string | null
  /** Diff font size in px (default 13). */
  fontSize?: number
  /** Initial view tab (default "changes"). */
  initialView?: GitView
  /**
   * Project-page History: hide Changes/Staged/History pills and prepend a
   * “Uncommitted” status row. Commit clicks open CommitChangesDialog.
   */
  unifiedHistory?: boolean
  /** Whether this workspace is active and should poll Git state. */
  active?: boolean
}

type DiffContents = {
  original: string
  modified: string
}

const EMPTY_SUMMARY: GitRepositorySummary = {
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

export function GitWorkspace(props: GitWorkspaceProps) {
  const {
    rootUri,
    theme,
    onOpenFile,
    onBranchChange,
    focusPath,
    fontSize = 13,
    initialView = "changes",
    unifiedHistory = false,
    active = true,
  } = props
  const api = window.yaade?.git
  const fsApi = window.yaade?.fs
  const [isRepo, setIsRepo] = useState<boolean | null>(null)
  const [entries, setEntries] = useState<GitStatusEntry[]>([])
  const [summary, setSummary] = useState<GitRepositorySummary>(EMPTY_SUMMARY)
  const [branches, setBranches] = useState<string[]>([])
  const [history, setHistory] = useState<GitCommit[]>([])
  const [historyCursor, setHistoryCursor] = useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [view, setView] = useState<GitView>(
    unifiedHistory ? "history" : initialView,
  )
  const [selected, setSelected] = useState<SelectedChange | null>(null)
  const [filter, setFilter] = useState("")
  const [diffContents, setDiffContents] = useState<DiffContents | null>(null)
  const [diffStyle, setDiffStyle] = useState<DiffStyle>(() =>
    localStorage.getItem("yaade:git-diff-style") === "split" ? "split" : "unified",
  )
  const [loading, setLoading] = useState(true)
  const [diffLoading, setDiffLoading] = useState(false)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [numstat, setNumstat] = useState<Record<string, GitNumstatEntry>>({})
  const [selectedCommit, setSelectedCommit] = useState<string | null>(
    unifiedHistory ? GIT_WORKING_TREE_ID : null,
  )
  const [dialogCommit, setDialogCommit] = useState<GitCommit | null>(null)
  const [workingTreeDialogOpen, setWorkingTreeDialogOpen] = useState(false)
  const [commitDialogOpen, setCommitDialogOpen] = useState(false)
  const [mobileDetail, setMobileDetail] = useState(false)
  const [hunks, setHunks] = useState<DiffHunk[] | null>(null)
  const [hunksLoading, setHunksLoading] = useState(false)
  const [containerWidth, setContainerWidth] = useState(0)
  const rootRef = useRef<HTMLElement>(null)
  const diffRequest = useRef(0)
  const historyRequest = useRef(0)
  const refreshInFlight = useRef(false)
  const pollFingerprint = useRef<string | null>(null)
  const narrow = containerWidth > 0 && containerWidth < 560

  const loadHistoryPage = useCallback(async (cursor: string | null, reset = false) => {
    if (!rootUri || !api) return
    const request = ++historyRequest.current
    setHistoryLoading(true)
    if (reset) {
      setHistory([])
      setHistoryCursor(null)
      setHistoryError(null)
    }
    try {
      const page = await api.historyPage(rootUri, cursor ?? undefined, 100)
      if (request !== historyRequest.current) return
      if (reset && page.commits[0] && pollFingerprint.current) {
        const parts = pollFingerprint.current.split("\0")
        if (parts.length >= 6) {
          parts[4] = page.commits[0].hash
          pollFingerprint.current = parts.join("\0")
        }
      }
      setHistory(current => reset ? page.commits : appendHistoryCommits(current, page.commits))
      setHistoryCursor(page.nextCursor)
      setHistoryError(null)
    } catch (error) {
      if (request === historyRequest.current) setHistoryError(errorMessage(error))
    } finally {
      if (request === historyRequest.current) setHistoryLoading(false)
    }
  }, [api, rootUri])

  useEffect(() => {
    // Invalidate a late page from the previously selected worktree before its
    // refresh can paint into this one.
    historyRequest.current += 1
    setHistory([])
    setHistoryCursor(null)
    setHistoryError(null)
  }, [rootUri])

  const refresh = useCallback(async () => {
    if (!rootUri || !api) {
      setIsRepo(false)
      setHistory([])
      setHistoryCursor(null)
      setLoading(false)
      return
    }
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    setLoading(true)
    try {
      const repository = await api.isRepo(rootUri)
      setIsRepo(repository)
      if (!repository) return
      const [nextEntries, nextSummary, nextBranches, nextNumstat] = await Promise.all([
        api.status(rootUri),
        api.summary(rootUri),
        api.branches(rootUri),
        api.numstat(rootUri).catch(() => [] as GitNumstatEntry[]),
      ])
      setEntries(nextEntries)
      setSummary(nextSummary)
      setBranches(nextBranches)
      setNumstat(Object.fromEntries(nextNumstat.map(stat => [stat.path, stat])))
      pollFingerprint.current = [
        nextSummary.branch ?? "",
        nextSummary.upstream ?? "",
        String(nextSummary.ahead),
        String(nextSummary.behind),
        "", // tip filled after history page; force tip reload below
        nextEntries
          .map(
            entry =>
              `${entry.path}:${entry.status}:${entry.indexStatus ?? ""}:${entry.worktreeStatus ?? ""}:${entry.staged ? 1 : 0}:${entry.unstaged ? 1 : 0}`,
          )
          .join("|"),
      ].join("\0")
      void loadHistoryPage(null, true)
      onBranchChange?.(nextSummary.branch)
      setSelected(current => {
        if (current) {
          const sameFile = nextEntries.find(entry => entry.path === current.path)
          if (sameFile) {
            if (current.staged && sameFile.staged) return current
            if (!current.staged && sameFile.unstaged) return current
            if (sameFile.unstaged) return { path: sameFile.path, staged: false }
            if (sameFile.staged) return { path: sameFile.path, staged: true }
          }
        }
        const first = nextEntries.find(entry => entry.unstaged) ?? nextEntries.find(entry => entry.staged)
        return first ? { path: first.path, staged: !first.unstaged && first.staged } : null
      })
    } catch (error) {
      showYaadeToast("Could not refresh Git", {
        variant: "destructive",
        description: errorMessage(error),
      })
    } finally {
      refreshInFlight.current = false
      setLoading(false)
    }
  }, [api, loadHistoryPage, onBranchChange, rootUri])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** Cheap history poll: full refresh only when tip/summary/status fingerprint changes. */
  const pollHistory = useCallback(async () => {
    if (!rootUri || !api || refreshInFlight.current) return
    try {
      const [nextSummary, nextEntries, tipPage] = await Promise.all([
        api.summary(rootUri),
        api.status(rootUri),
        api.historyPage(rootUri, undefined, 1),
      ])
      const tip = tipPage.commits[0]?.hash ?? ""
      const statusSig = nextEntries
        .map(
          entry =>
            `${entry.path}:${entry.status}:${entry.indexStatus ?? ""}:${entry.worktreeStatus ?? ""}:${entry.staged ? 1 : 0}:${entry.unstaged ? 1 : 0}`,
        )
        .join("|")
      const nextKey = [
        nextSummary.branch ?? "",
        nextSummary.upstream ?? "",
        String(nextSummary.ahead),
        String(nextSummary.behind),
        tip,
        statusSig,
      ].join("\0")
      if (pollFingerprint.current === nextKey) return
      const prevTip = pollFingerprint.current?.split("\0")[4] ?? null
      pollFingerprint.current = nextKey
      setSummary(nextSummary)
      setEntries(nextEntries)
      onBranchChange?.(nextSummary.branch)
      if (prevTip !== tip) {
        void loadHistoryPage(null, true)
      }
    } catch {
      /* ignore transient poll errors */
    }
  }, [api, loadHistoryPage, onBranchChange, rootUri])

  useEffect(() => {
    if (!active || view !== "history") return
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") void pollHistory()
    }
    const interval = window.setInterval(refreshIfVisible, 2_000)
    document.addEventListener("visibilitychange", refreshIfVisible)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", refreshIfVisible)
    }
  }, [active, pollHistory, view])

  const selectedDiffKey = useMemo(() => {
    if (!selected) return null
    const entry = entries.find(item => item.path === selected.path)
    if (!entry) return `${selected.path}:${selected.staged ? 1 : 0}`
    return [
      selected.path,
      selected.staged ? 1 : 0,
      entry.status,
      entry.indexStatus ?? "",
      entry.worktreeStatus ?? "",
      entry.staged ? 1 : 0,
      entry.unstaged ? 1 : 0,
    ].join("\0")
  }, [entries, selected])

  useEffect(() => {
    if (!rootUri || !api || !fsApi || !selected || !selectedDiffKey) {
      setDiffContents(null)
      setHunks(null)
      return
    }
    const entry = entries.find(item => item.path === selected.path)
    const request = ++diffRequest.current
    setDiffLoading(true)
    setDiffContents(null)
    void loadGitDiffContents(rootUri, selected, entry, api, fsApi)
      .then(contents => {
        if (request === diffRequest.current) setDiffContents(contents)
      })
      .catch(error => {
        if (request !== diffRequest.current) return
        setDiffContents(null)
        showYaadeToast("Could not load diff", {
          variant: "destructive",
          description: errorMessage(error),
        })
      })
      .finally(() => {
        if (request === diffRequest.current) setDiffLoading(false)
      })
    // entries looked up inside; selectedDiffKey is the stable invalidation signal
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, fsApi, rootUri, selected, selectedDiffKey])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const observer = new ResizeObserver(observed => {
      const width = observed[0]?.contentRect.width ?? el.clientWidth
      setContainerWidth(width)
    })
    observer.observe(el)
    setContainerWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])

  const filteredEntries = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase()
    if (!needle) return entries
    return entries.filter(entry => entry.path.toLocaleLowerCase().includes(needle))
  }, [entries, filter])

  const navigationRows = useMemo(
    () => buildNavigationRows(filteredEntries, view),
    [filteredEntries, view],
  )
  const stagedCount = entries.filter(entry => entry.staged).length
  const unstagedPaths = entries.filter(entry => entry.unstaged).map(entry => entry.path)
  const stagedPaths = entries.filter(entry => entry.staged).map(entry => entry.path)
  const selectedEntry = selected ? entries.find(entry => entry.path === selected.path) : undefined

  useEffect(() => {
    if (view === "history") return
    const files = navigationRows.filter((row): row is Extract<NavigationRow, { kind: "file" }> => row.kind === "file")
    if (selected && files.some(row => row.entry.path === selected.path && row.staged === selected.staged)) return
    const first = files[0]
    setSelected(first ? { path: first.entry.path, staged: first.staged } : null)
  }, [navigationRows, selected, view])

  useEffect(() => {
    if (!focusPath) return
    const needle = focusPath.replace(/\\/g, "/").replace(/^\/+/, "")
    const match = entries.find(entry => {
      const path = entry.path.replace(/\\/g, "/")
      return path === needle || path.endsWith(`/${needle}`) || needle.endsWith(`/${path}`)
    })
    if (!match) return
    setView(match.staged && !match.unstaged ? "staged" : "changes")
    setSelected({ path: match.path, staged: Boolean(match.staged && !match.unstaged) })
  }, [focusPath, entries])

  // Hunk list is per-file; drop it whenever the selection changes so the
  // dropdown re-fetches against the correct path/side on next open.
  useEffect(() => {
    setHunks(null)
  }, [selected])

  useEffect(() => {
    setMobileDetail(false)
  }, [view])

  useEffect(() => {
    if (view !== "history") return
    setSelectedCommit(unifiedHistory ? GIT_WORKING_TREE_ID : null)
  }, [view, unifiedHistory])

  const runAction = useCallback(
    async (label: string, task: () => Promise<void>, success?: string): Promise<boolean> => {
      setPendingAction(label)
      try {
        await task()
        if (success) showYaadeToast(success, { variant: "success" })
        await refresh()
        return true
      } catch (error) {
        showYaadeToast(`${label} failed`, {
          variant: "destructive",
          description: errorMessage(error),
        })
        return false
      } finally {
        setPendingAction(null)
      }
    },
    [refresh],
  )

  const setAndPersistDiffStyle = (next: DiffStyle) => {
    setDiffStyle(next)
    localStorage.setItem("yaade:git-diff-style", next)
  }

  const stageSelection = (change: SelectedChange) => {
    if (!rootUri || !api) return
    const task = change.staged
      ? () => api.unstage(rootUri, [change.path])
      : () => api.stage(rootUri, [change.path])
    void runAction(change.staged ? "Unstage" : "Stage", task)
  }

  const stageAll = () => {
    if (!rootUri || !api || unstagedPaths.length === 0) return
    void runAction("Stage all", () => api.stage(rootUri, unstagedPaths))
  }

  const unstageAll = () => {
    if (!rootUri || !api || stagedPaths.length === 0) return
    void runAction("Unstage all", () => api.unstage(rootUri, stagedPaths))
  }

  const loadHunks = useCallback(async () => {
    if (!rootUri || !api || !selected) {
      setHunks(null)
      return
    }
    setHunksLoading(true)
    try {
      const patch = await api.diff(rootUri, { path: selected.path, staged: selected.staged })
      setHunks(parseDiffHunks(patch))
    } catch (error) {
      setHunks([])
      showYaadeToast("Could not load hunks", {
        variant: "destructive",
        description: errorMessage(error),
      })
    } finally {
      setHunksLoading(false)
    }
  }, [api, rootUri, selected])

  const applyHunk = (hunk: DiffHunk) => {
    if (!rootUri || !api || !selected) return
    const reverse = selected.staged
    void runAction(reverse ? "Unstage hunk" : "Stage hunk", () =>
      api.applyPatch(rootUri, hunk.patch, { reverse }),
    )
  }

  const discardSelection = async (entry: GitStatusEntry) => {
    if (!rootUri || !api || entry.status === "untracked") return
    const accepted = await requestConfirm({
      title: "Discard changes?",
      description: `Restore ${entry.path} to its last committed state. This cannot be undone.`,
      confirmLabel: "Discard changes",
      variant: "destructive",
    })
    if (!accepted) return
    await runAction("Discard", () => api.discard(rootUri, [entry.path]), "Changes discarded")
  }

  const commit = async (summaryText: string, bodyText: string): Promise<boolean> => {
    const message = summaryText.trim()
    if (!rootUri || !api || !message || stagedCount === 0) return false
    const committed = await runAction(
      "Commit",
      () => api.commit(rootUri, message, bodyText.trim() || undefined),
      `Committed ${stagedCount} ${stagedCount === 1 ? "file" : "files"}`,
    )
    return committed
  }

  if (loading && isRepo === null) {
    return <CenteredStatus label="Loading repository…" />
  }

  if (!rootUri || !api || isRepo === false) {
    return (
      <Empty className="h-full rounded-none border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon"><GitBranchIcon aria-hidden /></EmptyMedia>
          <EmptyTitle className="text-base">No Git repository</EmptyTitle>
          <EmptyDescription>
            Open a session inside a Git repository to review changes, stage files, and commit.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const onCheckout = (branch: string) => {
    if (!rootUri || !api || branch === summary.branch) return
    void runAction("Switch branch", () => api.checkout(rootUri, branch), `Switched to ${branch}`)
  }

  const navigatorPane = (
    <FileNavigator
      rows={navigationRows}
      filter={filter}
      selected={selected}
      pending={pendingAction !== null}
      stageAllCount={view === "changes" ? unstagedPaths.length : 0}
      unstageAllCount={stagedCount}
      numstat={numstat}
      onFilterChange={setFilter}
      onSelect={next => {
        setSelected(next)
        if (narrow) setMobileDetail(true)
      }}
      onToggleStage={stageSelection}
      onStageAll={stageAll}
      onUnstageAll={unstageAll}
      onOpenFile={onOpenFile}
      onDiscard={entry => void discardSelection(entry)}
    />
  )

  const diffViewer = (
    <DiffViewer
      selected={selected}
      selectedEntry={selectedEntry}
      diffContents={diffContents}
      loading={diffLoading}
      diffStyle={diffStyle}
      theme={theme}
      fontSize={fontSize}
      pending={pendingAction !== null}
      hunks={hunks}
      hunksLoading={hunksLoading}
      onLoadHunks={() => void loadHunks()}
      onApplyHunk={applyHunk}
      onBack={narrow ? () => setMobileDetail(false) : undefined}
      onDiffStyleChange={setAndPersistDiffStyle}
      onOpenFile={onOpenFile}
      onToggleStage={stageSelection}
      onDiscard={entry => void discardSelection(entry)}
    />
  )

  const dirtyCount = entries.length
  const historyList = (
    <HistoryList
      commits={history}
      selectedHash={dialogCommit?.hash ?? selectedCommit}
      includeWorkingTree={unifiedHistory}
      dirtyCount={dirtyCount}
      hasNextPage={historyCursor !== null}
      loading={historyLoading}
      error={historyError}
      onLoadMore={() => {
        if (historyCursor) void loadHistoryPage(historyCursor)
      }}
      onRetry={() => void loadHistoryPage(historyCursor, history.length === 0)}
      onSelect={hash => {
        if (hash === GIT_WORKING_TREE_ID) {
          setSelectedCommit(GIT_WORKING_TREE_ID)
          setWorkingTreeDialogOpen(true)
          return
        }
        const commit = history.find(row => row.hash === hash)
        if (commit) setDialogCommit(commit)
      }}
    />
  )

  const body =
    view === "history" ? (
      historyList
    ) : narrow ? (
      mobileDetail ? diffViewer : navigatorPane
    ) : (
      <ResizablePanelGroup
        orientation="horizontal"
        data-yaade-git-content=""
        className="min-h-0 flex-1 bg-transparent"
      >
        <ResizablePanel defaultSize="31%" minSize="160px" maxSize="48%">
          {navigatorPane}
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="69%" minSize="200px">
          {diffViewer}
        </ResizablePanel>
      </ResizablePanelGroup>
    )

  return (
    <section
      ref={rootRef}
      data-yaade-git-workspace=""
      data-yaade-git-root={rootUri ? fileUriToPath(rootUri) : undefined}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-transparent"
      aria-label="Git workspace"
    >
      <PierreDiffPool>
      <SessionHeaderChromePortal active>
        <GitPaneHeaderControls
          view={view}
          stagedCount={stagedCount}
          onViewChange={setView}
          summary={summary}
          branches={branches}
          pending={pendingAction !== null}
          onCheckout={onCheckout}
          hideViewTabs={unifiedHistory}
        />
      </SessionHeaderChromePortal>

      <GitToolbar
        repositoryKey={rootUri}
        summary={summary}
        stagedCount={stagedCount}
        pendingAction={pendingAction}
        commitDialogOpen={commitDialogOpen}
        onCommitDialogOpenChange={setCommitDialogOpen}
        onCommit={commit}
        onRemoteAction={action => {
          if (!rootUri || !api) return
          const task = action === "fetch" ? api.fetch : action === "pull" ? api.pull : api.push
          void runAction(capitalize(action), () => task.call(api, rootUri), `${capitalize(action)} complete`)
        }}
        onRefresh={() => void refresh()}
      />

      {body}

      {dialogCommit ? (
        <Suspense fallback={null}>
          <CommitChangesDialog
            open
            onOpenChange={open => {
              if (!open) setDialogCommit(null)
            }}
            rootUri={rootUri}
            hash={dialogCommit.hash}
            theme={theme}
            fontSize={fontSize}
            commit={dialogCommit}
          />
        </Suspense>
      ) : null}
      {workingTreeDialogOpen ? (
        <Suspense fallback={null}>
          <CommitChangesDialog
            open
            onOpenChange={open => {
              if (!open) setWorkingTreeDialogOpen(false)
            }}
            rootUri={rootUri}
            hash={GIT_WORKING_TREE_ID}
            workingTree
            onWorkingTreeChange={() => void refresh()}
            onCommit={() => {
              setWorkingTreeDialogOpen(false)
              setCommitDialogOpen(true)
            }}
            theme={theme}
            fontSize={fontSize}
          />
        </Suspense>
      ) : null}
      </PierreDiffPool>
    </section>
  )
}

function GitPaneHeaderControls(props: {
  view: GitView
  stagedCount: number
  onViewChange: (view: GitView) => void
  summary: GitRepositorySummary
  branches: string[]
  pending: boolean
  onCheckout: (branch: string) => void
  hideViewTabs?: boolean
}) {
  const {
    view,
    stagedCount,
    onViewChange,
    summary,
    branches,
    pending,
    onCheckout,
    hideViewTabs,
  } = props
  const branchOptions =
    summary.branch && !branches.includes(summary.branch)
      ? [summary.branch, ...branches]
      : branches
  return (
    <div
      data-yaade-session-header-tabs="git"
      className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden"
    >
      {hideViewTabs ? null : (
        <GitViewTabs view={view} stagedCount={stagedCount} onChange={onViewChange} />
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2 overflow-hidden">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="max-w-48 gap-1"
            aria-label={
              summary.branch
                ? `Switch branch, current branch ${summary.branch}`
                : "Switch branch"
            }
            data-yaade-git-branch-trigger=""
            disabled={pending}
          >
            <GitBranchIcon className="size-3" />
            <span className="truncate">{summary.branch ?? "Branch"}</span>
            <ChevronDownIcon className="size-2.5 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>Switch branch</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={summary.branch ?? ""}
            onValueChange={onCheckout}
          >
            {branchOptions.map(branch => (
              <DropdownMenuRadioItem key={branch} value={branch}>
                {branch}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <div
        aria-label={`${summary.ahead} commits ahead, ${summary.behind} commits behind`}
        className="hidden items-center gap-2 text-2xs tabular-nums text-muted-foreground sm:flex"
      >
        <span title={`${summary.ahead} commits ahead`}>
          <ArrowUpIcon className="inline size-3" aria-hidden /> {summary.ahead}
        </span>
        <span title={`${summary.behind} commits behind`}>
          <ArrowDownIcon className="inline size-3" aria-hidden /> {summary.behind}
        </span>
      </div>
      </div>
    </div>
  )
}

function GitToolbar(props: {
  repositoryKey: string
  summary: GitRepositorySummary
  stagedCount: number
  pendingAction: string | null
  commitDialogOpen: boolean
  onCommitDialogOpenChange: (open: boolean) => void
  hideCommit?: boolean
  onCommit: (summary: string, body: string) => Promise<boolean>
  onRemoteAction: (action: "fetch" | "pull" | "push") => void
  onRefresh: () => void
}) {
  const {
    repositoryKey,
    summary,
    stagedCount,
    pendingAction,
    commitDialogOpen,
    onCommitDialogOpenChange,
    hideCommit = false,
    onCommit,
    onRemoteAction,
    onRefresh,
  } = props
  const busy = pendingAction !== null
  return (
    <header
      data-yaade-git-toolbar=""
      className="flex h-7 shrink-0 items-center justify-end gap-2 border-b border-border bg-card px-2"
    >
      <div className="flex shrink-0 items-center gap-1">
        {hideCommit ? null : (
          <GitCommitDialog
            key={repositoryKey}
            open={commitDialogOpen}
            onOpenChange={onCommitDialogOpenChange}
            branch={summary.branch}
            stagedCount={stagedCount}
            busy={busy}
            committing={pendingAction === "Commit"}
            onCommit={onCommit}
          />
        )}
        {pendingAction ? (
          <span role="status" className="hidden items-center gap-1.5 text-2xs text-muted-foreground sm:flex">
            <Spinner />
            {pendingAction}…
          </span>
        ) : null}
        <Button type="button" variant="ghost" size="icon-sm" disabled={busy} aria-label="Refresh Git" onClick={onRefresh}>
          <RefreshCwIcon className={cn(busy && "animate-spin")} />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" disabled={busy} aria-label="Repository actions">
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => onRemoteAction("fetch")}>
                <ArrowDownIcon />
                Fetch from remote
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onRemoteAction("pull")}>
                <ArrowDownIcon />
                Pull from remote
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onRemoteAction("push")}>
                <UploadIcon />
                Push to remote
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}

function GitCommitDialog(props: {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  branch: string | null
  stagedCount: number
  busy: boolean
  committing: boolean
  onCommit: (summary: string, body: string) => Promise<boolean>
}) {
  const { open: controlledOpen, onOpenChange, branch, stagedCount, busy, committing, onCommit } = props
  const [internalOpen, setInternalOpen] = useState(false)
  const [summary, setSummary] = useState("")
  const [body, setBody] = useState("")
  const summaryRef = useRef<HTMLInputElement>(null)
  const open = controlledOpen ?? internalOpen
  const stagedLabel = `${stagedCount} staged ${stagedCount === 1 ? "file" : "files"}`

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && committing) return
    if (controlledOpen === undefined) setInternalOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }

  const handleSubmit = async () => {
    if (!summary.trim() || stagedCount === 0 || busy) return
    const committed = await onCommit(summary, body)
    if (!committed) return
    setSummary("")
    setBody("")
    handleOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          size="xs"
          disabled={busy || stagedCount === 0}
          aria-label={
            stagedCount === 0
              ? "No staged files to commit"
              : `Commit ${stagedCount} staged ${stagedCount === 1 ? "file" : "files"}`
          }
          data-yaade-git-commit-trigger=""
        >
          <CircleDotIcon data-icon="inline-start" />
          Commit
        </Button>
      </DialogTrigger>
      <DialogContent
        size="prompt"
        motion="standard"
        data-yaade-git-commit-dialog=""
        onOpenAutoFocus={event => {
          event.preventDefault()
          summaryRef.current?.focus()
        }}
        onEscapeKeyDown={event => {
          if (committing) event.preventDefault()
        }}
        onPointerDownOutside={event => {
          if (committing) event.preventDefault()
        }}
      >
        <form
          data-yaade-git-commit-form=""
          aria-busy={committing}
          className="flex flex-col gap-4"
          onSubmit={event => {
            event.preventDefault()
            void handleSubmit()
          }}
        >
          <DialogHeader>
            <DialogTitle>Commit changes</DialogTitle>
            <DialogDescription>
              Commit {stagedLabel} to {branch ?? "the current branch"}.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="git-commit-summary">Summary</Label>
              <Input
                ref={summaryRef}
                id="git-commit-summary"
                name="git-commit-summary"
                autoComplete="off"
                required
                value={summary}
                onChange={event => setSummary(event.target.value)}
                placeholder="Describe the changes"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="git-commit-body">Description</Label>
              <Textarea
                id="git-commit-body"
                name="git-commit-body"
                value={body}
                onChange={event => setBody(event.target.value)}
                placeholder="Add context (optional)"
                rows={4}
                className="min-h-24 resize-y font-mono text-2xs leading-4"
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={committing}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={!summary.trim() || stagedCount === 0 || busy}
              data-yaade-git-commit=""
            >
              {committing ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <CircleDotIcon data-icon="inline-start" />
              )}
              {committing ? "Committing…" : `Commit ${stagedCount} ${stagedCount === 1 ? "file" : "files"}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function GitViewTabs(props: {
  view: GitView
  stagedCount: number
  onChange: (view: GitView) => void
}) {
  const { view, stagedCount, onChange } = props
  return (
    <div
      role="tablist"
      aria-label="Git views"
      onKeyDown={handleTabKeyDown}
      className="flex min-w-0 items-center gap-0.5"
    >
      <GitViewTab active={view === "changes"} label="Changes" onSelect={() => onChange("changes")} />
      <GitViewTab active={view === "staged"} label={`Staged ${stagedCount || ""}`} onSelect={() => onChange("staged")} />
      <GitViewTab active={view === "history"} label="History" onSelect={() => onChange("history")} />
    </div>
  )
}

function GitViewTab(props: { active: boolean; label: string; onSelect: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      role="tab"
      aria-selected={props.active}
      tabIndex={props.active ? 0 : -1}
      data-yaade-session-tab-pill=""
      data-active={props.active ? "" : undefined}
      className={cn(
        "h-5 rounded-sm border px-1.5 text-3xs leading-none",
        props.active
          ? "border-border/80 bg-card/75 text-foreground shadow-sm"
          : "border-transparent bg-muted/30 text-foreground/70 hover:border-border/60 hover:bg-muted/55 hover:text-foreground",
      )}
      onClick={props.onSelect}
    >
      {props.label.trim()}
    </Button>
  )
}

function FileNavigator(props: {
  rows: NavigationRow[]
  filter: string
  selected: SelectedChange | null
  pending: boolean
  stageAllCount: number
  unstageAllCount: number
  numstat: Record<string, GitNumstatEntry>
  onFilterChange: (value: string) => void
  onSelect: (selected: SelectedChange) => void
  onToggleStage: (selected: SelectedChange) => void
  onStageAll: () => void
  onUnstageAll: () => void
  onOpenFile: (path: string) => void
  onDiscard: (entry: GitStatusEntry) => void
}) {
  const { rows, filter, selected, pending, stageAllCount, unstageAllCount, numstat, onFilterChange, onSelect, onToggleStage, onStageAll, onUnstageAll, onOpenFile, onDiscard } = props
  const scrollRef = useRef<HTMLElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: index => rows[index]?.kind === "section" ? 29 : 36,
    overscan: 10,
  })
  const fileRows = rows.filter((row): row is Extract<NavigationRow, { kind: "file" }> => row.kind === "file")

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return
    if (!["ArrowUp", "ArrowDown", "Home", "End", "Enter", " "].includes(event.key)) return
    if (fileRows.length === 0) return
    const current = fileRows.findIndex(row => row.entry.path === selected?.path && row.staged === selected.staged)
    if (event.key === "Enter") {
      const row = fileRows[Math.max(0, current)]
      if (row) onOpenFile(row.entry.path)
      return
    }
    if (event.key === " ") {
      const row = fileRows[Math.max(0, current)]
      if (!row) return
      event.preventDefault()
      onToggleStage({ path: row.entry.path, staged: row.staged })
      return
    }
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? fileRows.length - 1
        : Math.max(0, Math.min(fileRows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)))
    const next = fileRows[nextIndex]
    if (!next) return
    event.preventDefault()
    onSelect({ path: next.entry.path, staged: next.staged })
    const rowIndex = rows.indexOf(next)
    if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: "auto" })
  }

  return (
    <SidebarShell
      aria-label="Changed files"
      className="rounded-none border-0"
      header={
        <>
        <div className="relative min-w-0 flex-1">
          <label htmlFor="git-filter-files" className="sr-only">Filter changed files</label>
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            id="git-filter-files"
            name="git-filter-files"
            aria-label="Filter changed files"
            autoComplete="off"
            value={filter}
            onChange={event => onFilterChange(event.target.value)}
            placeholder="Filter files…"
            className="h-8 bg-background pl-7 text-xs"
          />
        </div>
        {unstageAllCount > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={pending}
            aria-label={`Unstage all ${unstageAllCount} staged ${unstageAllCount === 1 ? "file" : "files"}`}
            data-yaade-git-unstage-all
            onClick={onUnstageAll}
          >
            Unstage all
          </Button>
        ) : null}
        {stageAllCount > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={pending}
            aria-label={`Stage all ${stageAllCount} changed ${stageAllCount === 1 ? "file" : "files"}`}
            data-yaade-git-stage-all
            onClick={onStageAll}
          >
            Stage all
          </Button>
        ) : null}
        </>
      }
      contentRef={scrollRef}
      contentProps={{
        "data-yaade-list-panel": "git-files",
        tabIndex: 0,
        "aria-label": "Changed files list",
        onKeyDown: handleKeyDown,
      }}
      contentClassName="outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
    >
        {rows.length === 0 ? (
          <Empty className="h-full rounded-none border-0 p-3">
            <EmptyHeader>
              <EmptyMedia variant="icon"><CheckIcon aria-hidden /></EmptyMedia>
              <EmptyTitle className="text-sm">No matching changes</EmptyTitle>
              <EmptyDescription>{filter ? "Try a different file filter." : "Your working tree is clean."}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map(item => {
              const row = rows[item.index]
              if (!row) return null
              return (
                <div
                  key={row.id}
                  className="absolute top-0 left-0 w-full"
                  style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                >
                  {row.kind === "section" ? (
                    <div className="flex h-full items-center justify-between border-b border-border/30 px-3 font-mono text-3xs tracking-wide text-muted-foreground uppercase">
                      <span>{row.label}</span><span className="tabular-nums">{row.count}</span>
                    </div>
                  ) : (
                    <GitFileRow
                      entry={row.entry}
                      staged={row.staged}
                      stats={numstat[row.entry.path]}
                      active={selected?.path === row.entry.path && selected.staged === row.staged}
                      pending={pending}
                      onSelect={() => onSelect({ path: row.entry.path, staged: row.staged })}
                      onToggleStage={() => onToggleStage({ path: row.entry.path, staged: row.staged })}
                      onOpenFile={() => onOpenFile(row.entry.path)}
                      onDiscard={() => onDiscard(row.entry)}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
    </SidebarShell>
  )
}

function GitFileRow(props: {
  entry: GitStatusEntry
  staged: boolean
  stats?: GitNumstatEntry
  active: boolean
  pending: boolean
  onSelect: () => void
  onToggleStage: () => void
  onOpenFile: () => void
  onDiscard: () => void
}) {
  const { entry, staged, stats, active, pending, onSelect, onToggleStage, onOpenFile, onDiscard } = props
  return (
    <div
      data-yaade-list-item=""
      data-yaade-git-file={entry.path}
      data-active={active ? "" : undefined}
      className={cn(
        "group relative flex h-full shrink-0 items-center gap-2 border-b border-border/20 px-2 text-2xs outline-none transition-colors",
        active ? "bg-primary/10 text-foreground before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-primary" : "text-muted-foreground hover:bg-accent/35 hover:text-foreground",
      )}
    >
      <Checkbox
        checked={staged}
        disabled={pending}
        aria-label={`${staged ? "Unstage" : "Stage"} ${entry.path}`}
        onCheckedChange={onToggleStage}
        className="size-3.5"
      />
      <Button type="button" variant="ghost" className="h-auto min-w-0 flex-1 justify-start truncate p-0 text-left font-normal focus-visible:underline" onClick={onSelect} onDoubleClick={onOpenFile}>
        <span className="truncate">{entry.path}</span>
      </Button>
      <NumstatBadge stats={stats} />
      <span className={cn("shrink-0 font-mono text-3xs font-medium", statusColor(entry.status))} title={entry.status}>
        {statusLetter(entry.status)}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Actions for ${entry.path}`} className="opacity-70 hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100">
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={onOpenFile}><ExternalLinkIcon /> Open file</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => {
              void navigator.clipboard.writeText(entry.path)
              showYaadeToast("Path copied")
            }}><CopyIcon /> Copy path</DropdownMenuItem>
            {entry.status !== "untracked" && !staged ? (
              <DropdownMenuItem variant="destructive" onSelect={onDiscard}><RotateCcwIcon /> Discard changes</DropdownMenuItem>
            ) : null}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function NumstatBadge({ stats }: { stats?: GitNumstatEntry }) {
  if (!stats) return null
  if (stats.added === null || stats.deleted === null) {
    return <span className="shrink-0 font-mono text-3xs text-muted-foreground tabular-nums">bin</span>
  }
  if (stats.added === 0 && stats.deleted === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-3xs tabular-nums" aria-hidden>
      {stats.added > 0 ? (
        <span className="text-git-added">+{stats.added}</span>
      ) : null}
      {stats.deleted > 0 ? (
        <span className="text-git-deleted">−{stats.deleted}</span>
      ) : null}
    </span>
  )
}

function DiffViewer(props: {
  selected: SelectedChange | null
  selectedEntry?: GitStatusEntry
  diffContents: DiffContents | null
  loading: boolean
  diffStyle: DiffStyle
  theme: YaadeTheme
  fontSize: number
  pending: boolean
  hunks: DiffHunk[] | null
  hunksLoading: boolean
  onLoadHunks: () => void
  onApplyHunk: (hunk: DiffHunk) => void
  onBack?: () => void
  onDiffStyleChange: (style: DiffStyle) => void
  onOpenFile: (path: string) => void
  onToggleStage: (selected: SelectedChange) => void
  onDiscard: (entry: GitStatusEntry) => void
}) {
  const {
    selected,
    selectedEntry,
    diffContents,
    loading,
    diffStyle,
    theme,
    fontSize,
    pending,
    hunks,
    hunksLoading,
    onLoadHunks,
    onApplyHunk,
    onBack,
    onDiffStyleChange,
    onOpenFile,
    onToggleStage,
    onDiscard,
  } = props
  if (!selected) {
    return <CenteredEmpty title="Select a changed file" description="Choose a file to inspect its diff." />
  }
  const hasDiff =
    diffContents != null &&
    (diffContents.original.length > 0 || diffContents.modified.length > 0)
  const canStageHunks = selectedEntry != null && selectedEntry.status !== "untracked" && hasDiff
  return (
    <div data-yaade-git-diff="" className="flex h-full min-h-0 flex-col overflow-hidden bg-transparent">
      <div
        data-yaade-git-diff-toolbar=""
        className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-card px-3"
      >
        {onBack ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Back to file list"
            onClick={onBack}
          >
            <ArrowLeftIcon />
          </Button>
        ) : (
          <FileDiffIcon className="text-muted-foreground" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-2xs">{selected.path}</span>
        {canStageHunks ? (
          <HunkMenu
            staged={selected.staged}
            hunks={hunks}
            loading={hunksLoading}
            pending={pending}
            onOpen={onLoadHunks}
            onApply={onApplyHunk}
          />
        ) : null}
        <Button type="button" variant="secondary" size="xs" disabled={pending} onClick={() => onToggleStage(selected)}>
          {selected.staged ? "Unstage file" : "Stage file"}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={pending}
              aria-label={`Diff actions for ${selected.path}`}
            >
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => onOpenFile(selected.path)}>
                <ExternalLinkIcon />
                Open file
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Diff layout</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={diffStyle}
              onValueChange={value => onDiffStyleChange(value as DiffStyle)}
            >
              <DropdownMenuRadioItem value="unified">Unified</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="split">Split</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            {!selected.staged && selectedEntry && selectedEntry.status !== "untracked" ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem variant="destructive" onSelect={() => onDiscard(selectedEntry)}>
                    <RotateCcwIcon />
                    Discard changes
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <CenteredStatus label="Loading diff…" />
        ) : hasDiff && diffContents ? (
          <Suspense fallback={<CenteredStatus label="Preparing diff…" />}>
            <YaadeDiffViewer
              path={selected.path}
              original={diffContents.original}
              modified={diffContents.modified}
              mode={diffStyle}
              theme={theme}
              fontSize={fontSize}
            />
          </Suspense>
        ) : (
          <CenteredEmpty
            title={selectedEntry?.status === "untracked" ? "Untracked file" : "No textual diff"}
            description={
              selectedEntry?.status === "untracked"
                ? "New file contents appear after the working tree is readable."
                : "This file may be binary or unchanged in this Git area."
            }
          />
        )}
      </div>
    </div>
  )
}

type DiffHunk = { header: string; patch: string; added: number; deleted: number }

/** Split a single-file unified diff into per-hunk patches ready for `git apply`. */
function parseDiffHunks(patch: string): DiffHunk[] {
  const lines = patch.split("\n")
  const headerEnd = lines.findIndex(line => line.startsWith("@@"))
  if (headerEnd < 0) return []
  const fileHeader = lines.slice(0, headerEnd).join("\n")
  const hunks: DiffHunk[] = []
  let start = -1
  const flush = (end: number) => {
    if (start < 0) return
    const hunkLines = lines.slice(start, end)
    const header = (hunkLines[0] ?? "").trim()
    let added = 0
    let deleted = 0
    for (const line of hunkLines) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++
      else if (line.startsWith("-") && !line.startsWith("---")) deleted++
    }
    let body = `${fileHeader}\n${hunkLines.join("\n")}`
    if (!body.endsWith("\n")) body += "\n"
    hunks.push({ header, patch: body, added, deleted })
  }
  for (let i = headerEnd; i < lines.length; i++) {
    if (lines[i]!.startsWith("@@")) {
      flush(i)
      start = i
    }
  }
  flush(lines.length)
  return hunks
}

function HunkMenu(props: {
  staged: boolean
  hunks: DiffHunk[] | null
  loading: boolean
  pending: boolean
  onOpen: () => void
  onApply: (hunk: DiffHunk) => void
}) {
  const { staged, hunks, loading, pending, onOpen, onApply } = props
  const verb = staged ? "Unstage" : "Stage"
  return (
    <DropdownMenu
      onOpenChange={open => {
        if (open) onOpen()
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="xs" disabled={pending} aria-label={`${verb} hunks`}>
          <ScissorsIcon data-icon="inline-start" />
          Hunks
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-auto">
        <DropdownMenuLabel>{verb} hunks</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-1.5 text-2xs text-muted-foreground">
            <Spinner /> Loading hunks…
          </div>
        ) : !hunks || hunks.length === 0 ? (
          <div className="px-2 py-1.5 text-2xs text-muted-foreground">
            No hunks to {verb.toLowerCase()}.
          </div>
        ) : (
          hunks.map((hunk, index) => (
            <DropdownMenuItem
              key={`${index}:${hunk.header}`}
              className="flex flex-col items-start gap-0.5"
              onSelect={() => onApply(hunk)}
            >
              <span className="flex w-full items-center justify-between gap-2 font-mono text-3xs">
                <span className="min-w-0 truncate">{hunk.header}</span>
                <span className="shrink-0 tabular-nums">
                  <span className="text-git-added">+{hunk.added}</span>{" "}
                  <span className="text-git-deleted">−{hunk.deleted}</span>
                </span>
              </span>
              <span className="text-3xs text-muted-foreground">{verb} this hunk</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

async function loadGitDiffContents(
  rootUri: string,
  selected: SelectedChange,
  entry: GitStatusEntry | undefined,
  api: NonNullable<NonNullable<typeof window.yaade>["git"]>,
  fsApi: NonNullable<NonNullable<typeof window.yaade>["fs"]>,
): Promise<DiffContents> {
  const rootPath = fileUriToPath(rootUri).replace(/[/\\]+$/, "")
  const fullPath = `${rootPath}/${selected.path.replace(/^[/\\]+/, "")}`
  const fileUri = pathToFileUri(fullPath)

  const truncate = (text: string): string => {
    const max = 1 * 1024 * 1024
    if (text.length <= max) return text
    return `${text.slice(0, max)}\n\n… truncated for UI (${text.length} chars total)`
  }

  if (entry?.status === "untracked") {
    try {
      return { original: "", modified: truncate(await fsApi.readFile(fileUri)) }
    } catch {
      return { original: "", modified: "" }
    }
  }

  if (entry?.status === "deleted") {
    const original = selected.staged
      ? await api.show(rootUri, selected.path, "HEAD")
      : await api.show(rootUri, selected.path, "INDEX")
    return { original: truncate(original), modified: "" }
  }

  if (selected.staged) {
    const [original, modified] = await Promise.all([
      api.show(rootUri, selected.path, "HEAD"),
      api.show(rootUri, selected.path, "INDEX"),
    ])
    return { original: truncate(original), modified: truncate(modified) }
  }

  const [original, modified] = await Promise.all([
    api.show(rootUri, selected.path, "INDEX").then(
      value => value || api.show(rootUri, selected.path, "HEAD"),
    ),
    fsApi.readFile(fileUri).catch(() => ""),
  ])
  return { original: truncate(original), modified: truncate(modified) }
}

function HistoryList(props: {
  commits: GitCommit[]
  selectedHash: string | null
  onSelect: (hash: string) => void
  includeWorkingTree?: boolean
  dirtyCount?: number
  hasNextPage: boolean
  loading: boolean
  error: string | null
  onLoadMore: () => void
  onRetry: () => void
}) {
  const {
    commits,
    selectedHash,
    onSelect,
    includeWorkingTree = false,
    dirtyCount = 0,
    hasNextPage,
    loading,
    error,
    onLoadMore,
    onRetry,
  } = props
  const rowCount = commits.length + (includeWorkingTree ? 1 : 0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 54,
    overscan: 10,
  })
  const virtualItems = virtualizer.getVirtualItems()
  const lastVisibleIndex = virtualItems.at(-1)?.index ?? -1

  useEffect(() => {
    if (!hasNextPage || loading || lastVisibleIndex < rowCount - 20) return
    onLoadMore()
  }, [hasNextPage, lastVisibleIndex, loading, onLoadMore, rowCount])

  return (
    <div ref={scrollRef} data-yaade-list-panel="git-history" className="min-h-0 flex-1 overflow-auto p-2">
      {rowCount === 0 && loading ? (
        <CenteredStatus label="Loading commit history…" />
      ) : rowCount === 0 ? (
        <div className="flex h-full min-h-0 flex-col">
          <CenteredEmpty title="No commit history" description="Commits will appear here once this repository has history." />
          {error ? <HistoryRetry error={error} onRetry={onRetry} /> : null}
        </div>
      ) : (
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map(item => {
            if (includeWorkingTree && item.index === 0) {
              const active = selectedHash === GIT_WORKING_TREE_ID
              return (
                <Button
                  type="button"
                  variant="ghost"
                  key={GIT_WORKING_TREE_ID}
                  data-yaade-list-item=""
                  data-yaade-git-working-tree=""
                  data-active={active ? "" : undefined}
                  onClick={() => onSelect(GIT_WORKING_TREE_ID)}
                  className={cn(
                    "absolute top-0 left-0 grid w-full shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center justify-normal gap-3 rounded-none border-b border-border/35 px-3 py-2 text-left font-normal",
                    active
                      ? "bg-primary/10 before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-primary"
                      : "hover:bg-accent/25",
                  )}
                  style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                >
                  <FileDiffIcon className="text-primary/80" aria-hidden />
                  <div className="min-w-0">
                    <span className="block truncate text-xs text-foreground">
                      Uncommitted
                    </span>
                    <span className="mt-0.5 block truncate text-3xs text-muted-foreground">
                      {dirtyCount === 0
                        ? "Working tree clean"
                        : `${dirtyCount} file${dirtyCount === 1 ? "" : "s"} changed`}
                    </span>
                  </div>
                  <div className="text-right font-mono text-3xs tabular-nums text-muted-foreground">
                    <span className="block text-primary/90">HEAD</span>
                  </div>
                </Button>
              )
            }
            const commit = commits[includeWorkingTree ? item.index - 1 : item.index]
            if (!commit) return null
            const active = commit.hash === selectedHash
            return (
              <Button
                type="button"
                variant="ghost"
                key={commit.hash}
                data-yaade-list-item=""
                data-active={active ? "" : undefined}
                onClick={() => onSelect(commit.hash)}
                className={cn(
                  "absolute top-0 left-0 grid w-full shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center justify-normal gap-3 rounded-none border-b border-border/35 px-3 py-2 text-left font-normal",
                  active
                    ? "bg-primary/10 before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-primary"
                    : "hover:bg-accent/25",
                )}
                style={{ height: item.size, transform: `translateY(${item.start}px)` }}
              >
                <HistoryIcon className="text-primary/80" aria-hidden />
                <div className="min-w-0">
                  <span className="block truncate text-xs text-foreground">{commit.subject}</span>
                  <span className="mt-0.5 block truncate text-3xs text-muted-foreground">{commit.author}</span>
                </div>
                <div className="text-right font-mono text-3xs tabular-nums text-muted-foreground">
                  <span className="block text-primary/90">{commit.shortHash}</span>
                  <span className="block">{dateFormatter.format(new Date(commit.authoredAt))}</span>
                </div>
              </Button>
            )
          })}
          {error ? <HistoryRetry error={error} onRetry={onRetry} /> : null}
          {loading ? (
            <div className="absolute right-3 bottom-2 flex items-center gap-1.5 rounded-md bg-background/90 px-2 py-1 text-3xs text-muted-foreground shadow-sm">
              <Spinner /> Loading more commits…
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

function HistoryRetry({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/35 px-3 py-2 text-3xs text-muted-foreground">
      <span className="min-w-0 truncate" title={error}>Could not load more commits: {error}</span>
      <Button type="button" variant="outline" size="xs" onClick={onRetry}>Retry</Button>
    </div>
  )
}

function appendHistoryCommits(current: GitCommit[], next: GitCommit[]): GitCommit[] {
  if (next.length === 0) return current
  const known = new Set(current.map(commit => commit.hash))
  const appended = next.filter(commit => {
    if (known.has(commit.hash)) return false
    known.add(commit.hash)
    return true
  })
  return appended.length === 0 ? current : [...current, ...appended]
}

function CenteredStatus({ label }: { label: string }) {
  return <div className="flex h-full min-h-32 items-center justify-center gap-2 text-xs text-muted-foreground"><Spinner /> {label}</div>
}

function CenteredEmpty({ title, description }: { title: string; description: string }) {
  return (
    <Empty className="h-full rounded-none border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon"><FileDiffIcon aria-hidden /></EmptyMedia>
        <EmptyTitle className="text-sm">{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function buildNavigationRows(entries: GitStatusEntry[], view: GitView): NavigationRow[] {
  const rows: NavigationRow[] = []
  const addSection = (id: string, label: string, files: GitStatusEntry[], staged: boolean) => {
    if (files.length === 0) return
    rows.push({ kind: "section", id: `section:${id}`, label, count: files.length })
    for (const entry of files) rows.push({ kind: "file", id: `${id}:${entry.path}`, entry, staged })
  }
  if (view === "staged") {
    addSection("staged", "Staged Changes", entries.filter(entry => entry.staged), true)
    return rows
  }
  addSection("conflicts", "Conflicts", entries.filter(entry => entry.status === "conflict"), false)
  addSection("staged", "Staged Changes", entries.filter(entry => entry.staged && entry.status !== "conflict"), true)
  addSection("changes", "Changes", entries.filter(entry => entry.unstaged && entry.status !== "conflict"), false)
  return rows
}

function statusLetter(status: GitStatusEntry["status"]): string {
  return status === "modified" ? "M" : status === "added" ? "A" : status === "deleted" ? "D" : status === "renamed" ? "R" : status === "untracked" ? "U" : "!"
}

function statusColor(status: GitStatusEntry["status"]): string {
  if (status === "conflict") return "text-git-conflict"
  if (status === "deleted") return "text-git-deleted"
  if (status === "added" || status === "untracked") return "text-git-added"
  return "text-git-modified"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function handleTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
  if (tabs.length === 0) return
  const current = Math.max(0, tabs.indexOf(document.activeElement as HTMLButtonElement))
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
  event.preventDefault()
  tabs[next]?.focus()
  tabs[next]?.click()
}
