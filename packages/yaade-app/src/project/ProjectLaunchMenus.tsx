import { useEffect, useRef, useState, type ReactNode } from "react"
import type { GitWorktree } from "@yaade/shared"
import { pathToFileUri } from "@yaade/shared"
import {
  AGENT_CLI_DRIVERS,
  AgentProviderIcon,
  type AgentCliDriver,
} from "@yaade/ui/agent-picker"
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Input,
  Spinner,
} from "@yaade/ui/primitives"
import { Check, GitBranch, Plus } from "lucide-react"
import {
  sameCheckoutPath,
  selectionFromPaths,
  type CheckoutSelection,
} from "./CheckoutPicker.js"
import { showYaadeToast } from "@yaade/ui/toast"

export type ProcessLaunchSelection =
  | { kind: "terminal" }
  | { kind: "agent"; driver: AgentCliDriver }

function worktreeLabel(worktree: GitWorktree): string {
  if (worktree.branch) return worktree.branch.replace(/^refs\/heads\//, "")
  if (worktree.detached && worktree.head) {
    return `detached@${worktree.head.slice(0, 7)}`
  }
  return worktree.path.split("/").filter(Boolean).pop() ?? worktree.path
}

function randomWorktreeBranch(): string {
  return `yaade/wt-${Date.now().toString(36)}`
}

function useProjectWorktrees(projectPath: string, open: boolean) {
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    const rootUri = pathToFileUri(projectPath)
    void window.yaade?.git
      ?.isRepo(rootUri)
      .then(isRepo => (isRepo ? window.yaade?.git?.worktreeList(rootUri) ?? [] : []))
      .then(rows => {
        if (cancelled) return
        setWorktrees(
          rows.filter(
            worktree =>
              !worktree.bare &&
              !worktree.prunable &&
              !sameCheckoutPath(worktree.path, projectPath),
          ),
        )
      })
      .catch(() => {
        if (!cancelled) setWorktrees([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, projectPath, revision])

  return {
    loading,
    worktrees,
    refresh: () => setRevision(value => value + 1),
  }
}

function CheckoutItems({
  projectPath,
  loading,
  worktrees,
  menuOpen,
  onSelect,
  onCreateWorktree,
}: {
  projectPath: string
  loading: boolean
  worktrees: readonly GitWorktree[]
  menuOpen: boolean
  onSelect: (selection: CheckoutSelection) => void
  onCreateWorktree: (input: { branch: string }) => Promise<CheckoutSelection>
}) {
  const [composing, setComposing] = useState(false)
  const [branchName, setBranchName] = useState("")
  const [creating, setCreating] = useState(false)
  const branchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (menuOpen) return
    setComposing(false)
    setBranchName("")
    setCreating(false)
  }, [menuOpen])

  useEffect(() => {
    if (!composing) return
    const id = requestAnimationFrame(() => {
      branchInputRef.current?.focus()
      branchInputRef.current?.select()
    })
    return () => cancelAnimationFrame(id)
  }, [composing])

  const create = async () => {
    if (creating) return
    setCreating(true)
    try {
      const branch = branchName.trim() || randomWorktreeBranch()
      const checkout = await onCreateWorktree({ branch })
      onSelect(checkout)
    } catch (error) {
      showYaadeToast(
        error instanceof Error ? error.message : "Could not create worktree",
        { variant: "destructive" },
      )
    } finally {
      setCreating(false)
    }
  }

  // Swap the whole submenu for a plain form so Radix menu typeahead / roving
  // focus cannot steal keystrokes from the branch field.
  if (composing) {
    return (
      <div
        className="flex flex-col gap-2 p-1.5"
        data-yaade-worktree-create-form=""
        onKeyDown={event => event.stopPropagation()}
        onKeyUp={event => event.stopPropagation()}
      >
        <Input
          ref={branchInputRef}
          value={branchName}
          onChange={event => setBranchName(event.target.value)}
          placeholder="Branch name (optional)"
          aria-label="New worktree branch"
          data-yaade-worktree-branch=""
          className="h-8 select-text"
          disabled={creating}
          onKeyDown={event => {
            event.stopPropagation()
            if (event.key === "Enter") {
              event.preventDefault()
              void create()
            }
          }}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="justify-start"
          data-yaade-worktree-create=""
          disabled={creating}
          onPointerDown={event => event.preventDefault()}
          onClick={() => void create()}
        >
          {creating ? <Spinner /> : <Plus aria-hidden />}
          Create worktree
        </Button>
      </div>
    )
  }

  return (
    <>
      <DropdownMenuItem
        data-yaade-worktree-main=""
        onSelect={() =>
          onSelect(selectionFromPaths(projectPath, projectPath, "Main"))
        }
      >
        <Check className="opacity-0" aria-hidden />
        <GitBranch aria-hidden />
        <span>Main</span>
      </DropdownMenuItem>
      {loading ? (
        <DropdownMenuItem disabled aria-label="Loading worktrees">
          <Spinner />
        </DropdownMenuItem>
      ) : worktrees.length > 0 ? (
        worktrees.map(worktree => {
          const label = worktreeLabel(worktree)
          return (
            <DropdownMenuItem
              key={worktree.path}
              data-yaade-worktree-item={label}
              onSelect={() =>
                onSelect(
                  selectionFromPaths(
                    projectPath,
                    worktree.path,
                    label,
                    worktree.branch?.replace(/^refs\/heads\//, "") ?? null,
                  ),
                )
              }
            >
              <Check className="opacity-0" aria-hidden />
              <GitBranch aria-hidden />
              <span className="truncate">{label}</span>
            </DropdownMenuItem>
          )
        })
      ) : (
        <DropdownMenuItem disabled>No linked worktrees</DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        data-yaade-worktree-create=""
        onSelect={event => {
          event.preventDefault()
          setComposing(true)
        }}
      >
        <Plus aria-hidden />
        <span>New worktree</span>
      </DropdownMenuItem>
    </>
  )
}

/** Unified Running launcher: system shell + agent CLIs, each with a checkout submenu. */
export function ProcessLaunchMenu({
  projectPath,
  open,
  onOpenChange,
  onLaunch,
  onCreateWorktree,
  trigger,
}: {
  projectPath: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onLaunch: (selection: ProcessLaunchSelection, checkout: CheckoutSelection) => void
  onCreateWorktree: (input: { branch: string }) => Promise<CheckoutSelection>
  trigger: ReactNode
}) {
  const { loading, worktrees } = useProjectWorktrees(projectPath, open)

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        className="w-64 border-0"
        data-yaade-process-launch-menu=""
        data-yaade-agent-launch-menu=""
        onCloseAutoFocus={event => event.preventDefault()}
      >
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            className="gap-2"
            data-yaade-agent-provider="terminal"
          >
            <AgentProviderIcon agent="terminal" className="size-4" />
            <span>Terminal</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            className="w-56 border-0"
            onCloseAutoFocus={event => event.preventDefault()}
          >
            <CheckoutItems
              projectPath={projectPath}
              loading={loading}
              worktrees={worktrees}
              menuOpen={open}
              onCreateWorktree={onCreateWorktree}
              onSelect={checkout => onLaunch({ kind: "terminal" }, checkout)}
            />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {AGENT_CLI_DRIVERS.map(driver => (
          <DropdownMenuSub key={driver.id}>
            <DropdownMenuSubTrigger
              className="gap-2"
              data-yaade-agent-provider={driver.id}
            >
              <AgentProviderIcon agent={driver.id} className="size-4" />
              <span>{driver.label}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56 border-0">
              <CheckoutItems
                projectPath={projectPath}
                loading={loading}
                worktrees={worktrees}
                menuOpen={open}
                onCreateWorktree={onCreateWorktree}
                onSelect={checkout =>
                  onLaunch({ kind: "agent", driver }, checkout)
                }
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** @deprecated Use ProcessLaunchMenu */
export const AgentLaunchMenu = ProcessLaunchMenu
