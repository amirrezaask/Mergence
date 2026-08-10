import { useEffect, useMemo, useState } from "react"
import type { GitWorktree } from "@yaade/shared"
import { fileUriToPath, pathToFileUri } from "@yaade/shared"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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

export type CheckoutSelection = {
  cwdPath: string
  title: string
  worktreeBranch?: string | null
  worktreePath?: string | null
  checkoutKey: string
}

export type CheckoutPickerProps = {
  projectPath: string
  homeDir: string
  defaultBranch: string
  activeLabel?: string | null
  activeCwdPath?: string | null
  onSelectCheckout: (input: CheckoutSelection) => void | Promise<void>
  onCreateWorktree: (input: {
    branch: string
    baseRef?: string
  }) => Promise<CheckoutSelection | void>
  onRemoveWorktree?: (input: {
    cwdPath: string
    branch: string | null
  }) => Promise<void>
  onIntent?: () => void
  /** `popover` for Changes chrome; `dialog` for launch flows. */
  mode?: "popover" | "dialog"
  open?: boolean
  onOpenChange?: (open: boolean) => void
  dialogTitle?: string
  dialogDescription?: string
  triggerClassName?: string
  /** Hide the remove-current action (launch dialogs). */
  allowRemove?: boolean
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

export function checkoutKeyForPath(projectPath: string, cwdPath: string): string {
  return sameCheckoutPath(cwdPath, projectPath) ? "main" : cwdPath
}

export function checkoutLabelForPath(
  projectPath: string,
  cwdPath: string,
  worktreeBranch?: string | null,
): string {
  if (sameCheckoutPath(cwdPath, projectPath)) return "Main"
  if (worktreeBranch?.trim()) return worktreeBranch.trim()
  return cwdPath.split("/").filter(Boolean).pop() ?? cwdPath
}

/** Resolve a sidebar badge from a leaf `cwdRootUri`. */
export function checkoutLabelFromUri(
  projectPath: string,
  cwdRootUri: string | null | undefined,
): string {
  if (!cwdRootUri) return "Main"
  try {
    return checkoutLabelForPath(projectPath, fileUriToPath(cwdRootUri))
  } catch {
    return "Main"
  }
}

export function selectionFromPaths(
  projectPath: string,
  cwdPath: string,
  title?: string | null,
  worktreeBranch?: string | null,
): CheckoutSelection {
  const isMain = sameCheckoutPath(cwdPath, projectPath)
  return {
    cwdPath,
    title: title?.trim() || checkoutLabelForPath(projectPath, cwdPath, worktreeBranch),
    worktreeBranch: isMain ? null : worktreeBranch ?? title ?? null,
    worktreePath: isMain ? null : cwdPath,
    checkoutKey: checkoutKeyForPath(projectPath, cwdPath),
  }
}

function useWorktreeList(projectPath: string, open: boolean) {
  const [worktrees, setWorktrees] = useState<GitWorktree[] | null>(null)
  const [isRepo, setIsRepo] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootUri = useMemo(() => pathToFileUri(projectPath), [projectPath])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void window.yaade?.git
      ?.isRepo(rootUri)
      .then(repo => {
        if (cancelled) return []
        setIsRepo(repo)
        return repo ? window.yaade?.git?.worktreeList(rootUri) ?? [] : []
      })
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

  const linked = useMemo(() => {
    if (!worktrees) return []
    return worktrees.filter(
      wt =>
        !wt.bare &&
        !wt.prunable &&
        !sameCheckoutPath(wt.path, projectPath),
    )
  }, [projectPath, worktrees])

  return { linked, loading, error, isRepo, setError }
}

export function CheckoutPicker({
  projectPath,
  homeDir,
  defaultBranch,
  activeLabel,
  activeCwdPath,
  onSelectCheckout,
  onCreateWorktree,
  onRemoveWorktree,
  onIntent,
  mode = "popover",
  open: openControlled,
  onOpenChange,
  dialogTitle = "Choose checkout",
  dialogDescription = "Pick Main or a git worktree.",
  triggerClassName,
  allowRemove = true,
}: CheckoutPickerProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = openControlled ?? uncontrolledOpen
  const setOpen = (next: boolean) => {
    onOpenChange?.(next)
    if (openControlled === undefined) setUncontrolledOpen(next)
  }
  const [createOpen, setCreateOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [highlight, setHighlight] = useState("main")
  const { linked, loading, error, isRepo, setError } = useWorktreeList(
    projectPath,
    open,
  )
  const activeWorktree = linked.find(
    worktree => activeCwdPath && sameCheckoutPath(activeCwdPath, worktree.path),
  )

  const selectMain = async () => {
    setBusy(true)
    try {
      await onSelectCheckout(selectionFromPaths(projectPath, projectPath, "Main"))
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
      await onSelectCheckout(
        selectionFromPaths(
          projectPath,
          wt.path,
          branch ?? branchLabel(wt),
          branch,
        ),
      )
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const handleCreate = async (input: { branch: string; baseRef?: string }) => {
    const created = await onCreateWorktree(input)
    setCreateOpen(false)
    setOpen(false)
    if (created) await onSelectCheckout(created)
  }

  const menu = (
    <Command value={highlight} onValueChange={setHighlight} className="rounded-md">
      <CommandInput
        placeholder="Filter worktrees…"
        aria-label="Filter worktrees"
        data-yaade-worktree-switcher-search=""
      />
      <CommandList className="max-h-72">
        {loading ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>
        ) : error ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">{error}</div>
        ) : (
          <>
            <CommandEmpty className="py-3 text-xs">No matches</CommandEmpty>
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
                    activeCwdPath && sameCheckoutPath(activeCwdPath, projectPath)
                      ? "opacity-100"
                      : "opacity-0",
                  )}
                />
                <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm">Main working tree</span>
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
                      <span className="block truncate text-sm">{itemLabel}</span>
                      <span className="block truncate font-mono text-3xs text-muted-foreground">
                        {wt.path}
                      </span>
                    </div>
                  </CommandItem>
                )
              })}
            </CommandGroup>
            {isRepo ? <CommandSeparator /> : null}
            {isRepo ? (
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
              {allowRemove && onRemoveWorktree && activeWorktree ? (
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
                    })
                      .then(() => setOpen(false))
                      .finally(() => setBusy(false))
                  }}
                  className="gap-2 text-destructive"
                >
                  <Trash2Icon className="size-3.5 shrink-0" />
                  <span>Remove current worktree…</span>
                </CommandItem>
              ) : null}
              </CommandGroup>
            ) : null}
          </>
        )}
      </CommandList>
    </Command>
  )

  return (
    <>
      {mode === "dialog" ? (
        <Dialog
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
          <DialogContent size="picker" className="gap-0 overflow-hidden p-0">
            <DialogHeader className="px-4 pt-4 pb-3">
              <DialogTitle>{dialogTitle}</DialogTitle>
              <DialogDescription>{dialogDescription}</DialogDescription>
            </DialogHeader>
            <div className="border-t" data-yaade-worktree-switcher-menu="">
              {menu}
            </div>
          </DialogContent>
        </Dialog>
      ) : (
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
                triggerClassName,
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
            {menu}
          </PopoverContent>
        </Popover>
      )}

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
