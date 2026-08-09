import { useEffect, useMemo, useState } from "react"
import type { GitWorktree } from "@yaade/shared"
import { pathToFileUri } from "@yaade/shared"
import { cn } from "@yaade/ui/project"
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@yaade/ui/primitives"
import {
  CheckIcon,
  ChevronDownIcon,
  GitBranchIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"
import { CreateWorktreeDialog } from "./CreateWorktreeDialog.js"

export type WorktreeSwitcherProps = {
  projectPath: string
  homeDir: string
  defaultBranch: string
  /** Currently open checkout label (shown on the trigger). */
  activeLabel?: string | null
  /** Absolute cwd of the open checkout (for menu checkmarks). */
  activeCwdPath?: string | null
  onSelectCheckout: (input: {
    cwdPath: string
    title?: string
    worktreeBranch?: string | null
    worktreePath?: string | null
  }) => Promise<void>
  onCreateWorktree: (input: {
    branch: string
    baseRef?: string
  }) => Promise<void>
  onRemoveWorktree?: (input: { cwdPath: string; branch: string | null }) => Promise<void>
  /** Warm the session workspace when the user signals intent to open it. */
  onIntent?: () => void
}

function branchLabel(wt: GitWorktree): string {
  if (wt.branch) return wt.branch.replace(/^refs\/heads\//, "")
  if (wt.detached && wt.head) return `detached@${wt.head.slice(0, 7)}`
  return wt.path.split("/").filter(Boolean).pop() ?? wt.path
}

/** Collapse macOS `/private/var` ↔ `/var` so Main is not listed twice. */
export function checkoutPathKey(p: string): string {
  return p.replace(/\/+$/, "").replace(/^\/private(\/var\/)/, "$1")
}

export function sameCheckoutPath(a: string, b: string): boolean {
  return checkoutPathKey(a) === checkoutPathKey(b)
}

export function WorktreeSwitcher({
  projectPath,
  homeDir,
  defaultBranch,
  activeLabel,
  activeCwdPath,
  onSelectCheckout,
  onCreateWorktree,
  onRemoveWorktree,
  onIntent,
}: WorktreeSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [worktrees, setWorktrees] = useState<GitWorktree[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [highlight, setHighlight] = useState("main")
  const rootUri = useMemo(() => pathToFileUri(projectPath), [projectPath])

  const linked = useMemo(() => {
    if (!worktrees) return []
    return worktrees.filter(
      wt =>
        !wt.bare &&
        !wt.prunable &&
        !sameCheckoutPath(wt.path, projectPath),
    )
  }, [projectPath, worktrees])
  const activeWorktree = linked.find(
    worktree => activeCwdPath && sameCheckoutPath(activeCwdPath, worktree.path),
  )

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void window.yaade?.git
      ?.worktreeList(rootUri)
      .then(rows => {
        if (cancelled) return
        setWorktrees(rows)
      })
      .catch(err => {
        if (cancelled) return
        setWorktrees([])
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, rootUri])

  const selectMain = async () => {
    setBusy(true)
    try {
      await onSelectCheckout({
        cwdPath: projectPath,
        title: "Main",
      })
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const selectWorktree = async (wt: GitWorktree) => {
    setBusy(true)
    try {
      const branch = wt.branch
        ? wt.branch.replace(/^refs\/heads\//, "")
        : null
      await onSelectCheckout({
        cwdPath: wt.path,
        title: branch ?? branchLabel(wt),
        worktreeBranch: branch,
        worktreePath: wt.path,
      })
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const handleCreate = async (input: { branch: string; baseRef?: string }) => {
    await onCreateWorktree(input)
    setCreateOpen(false)
    setOpen(false)
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={next => {
          if (next) onIntent?.()
          setOpen(next)
          if (!next) {
            setError(null)
            setHighlight("main")
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-yaade-worktree-switcher=""
            aria-label="Worktree"
            aria-expanded={open}
            disabled={busy}
            onPointerEnter={onIntent}
            onFocus={onIntent}
            className={cn(
              "h-7 max-w-48 gap-1 border border-transparent bg-secondary/60 px-2 text-xs text-foreground hover:text-foreground",
              open && "text-foreground",
            )}
          >
            <GitBranchIcon className="size-3.5" aria-hidden />
            <span className="truncate">{activeLabel ?? "Main"}</span>
            <ChevronDownIcon className="size-2.5 opacity-70" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-72 p-0"
          data-yaade-worktree-switcher-menu=""
          onOpenAutoFocus={e => {
            e.preventDefault()
            const root = e.currentTarget as HTMLElement
            root
              .querySelector<HTMLInputElement>(
                "[data-yaade-worktree-switcher-search]",
              )
              ?.focus()
          }}
          onCloseAutoFocus={e => e.preventDefault()}
        >
          <Command
            value={highlight}
            onValueChange={setHighlight}
            className="rounded-md"
          >
            <CommandInput
              placeholder="Filter worktrees…"
              aria-label="Filter worktrees"
              data-yaade-worktree-switcher-search=""
            />
            <CommandList className="max-h-72">
              {loading ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  Loading…
                </div>
              ) : error ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  {error}
                </div>
              ) : (
                <>
                  <CommandEmpty className="py-3 text-xs">
                    No matches
                  </CommandEmpty>
                  <CommandGroup heading="Checkout">
                    <CommandItem
                      value="main"
                      data-yaade-worktree-main=""
                      disabled={busy}
                      onSelect={() => void selectMain()}
                      className="gap-2"
                    >
                      <CheckIcon
                        className={cn(
                          "size-3.5 shrink-0",
                          activeCwdPath &&
                            sameCheckoutPath(activeCwdPath, projectPath)
                            ? "opacity-100"
                            : "opacity-0",
                        )}
                      />
                      <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-sm">
                          Main working tree
                        </span>
                        <span className="block truncate font-mono text-3xs text-muted-foreground">
                          {projectPath}
                        </span>
                      </div>
                    </CommandItem>
                    {linked.map(wt => {
                      const itemLabel = branchLabel(wt)
                      const selected = Boolean(
                        activeCwdPath && sameCheckoutPath(activeCwdPath, wt.path),
                      )
                      return (
                        <CommandItem
                          key={wt.path}
                          value={`${itemLabel} ${wt.path}`}
                          data-yaade-worktree-item={itemLabel}
                          disabled={busy}
                          onSelect={() => void selectWorktree(wt)}
                          className="gap-2"
                        >
                          <CheckIcon
                            className={cn(
                              "size-3.5 shrink-0",
                              selected ? "opacity-100" : "opacity-0",
                            )}
                          />
                          <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <span className="block truncate text-sm">
                              {itemLabel}
                            </span>
                            <span className="block truncate font-mono text-3xs text-muted-foreground">
                              {wt.path}
                            </span>
                          </div>
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                  <CommandSeparator />
                  <CommandGroup>
                    <CommandItem
                      value="create new worktree"
                      data-yaade-worktree-create=""
                      disabled={busy}
                      onSelect={() => {
                        setOpen(false)
                        setCreateOpen(true)
                      }}
                      className="gap-2"
                    >
                      <PlusIcon className="size-3.5 shrink-0" />
                      <span>Create worktree…</span>
                    </CommandItem>
                    {onRemoveWorktree && activeWorktree ? (
                      <CommandItem
                        value={`remove ${branchLabel(activeWorktree)} worktree`}
                        data-yaade-worktree-remove={branchLabel(activeWorktree)}
                        disabled={busy}
                        onSelect={() => {
                          setBusy(true)
                          void onRemoveWorktree({
                            cwdPath: activeWorktree.path,
                            branch: activeWorktree.branch
                              ? activeWorktree.branch.replace(/^refs\/heads\//, "")
                              : null,
                          }).then(() => setOpen(false)).finally(() => setBusy(false))
                        }}
                        className="gap-2 text-destructive"
                      >
                        <Trash2Icon className="size-3.5 shrink-0" />
                        <span>Remove current worktree…</span>
                      </CommandItem>
                    ) : null}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <CreateWorktreeDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectPath={projectPath}
        homeDir={homeDir}
        defaultBranch={defaultBranch}
        onCreate={handleCreate}
      />
    </>
  )
}
