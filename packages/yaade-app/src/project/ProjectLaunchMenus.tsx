import { useEffect, useState, type ReactNode } from "react"
import type { GitWorktree } from "@yaade/shared"
import { pathToFileUri } from "@yaade/shared"
import {
  AGENT_CLI_DRIVERS,
  AgentProviderIcon,
  type AgentCliDriver,
} from "@yaade/ui/agent-picker"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Spinner,
} from "@yaade/ui/primitives"
import { Check, GitBranch } from "lucide-react"
import {
  sameCheckoutPath,
  selectionFromPaths,
  type CheckoutSelection,
} from "./CheckoutPicker.js"

function worktreeLabel(worktree: GitWorktree): string {
  if (worktree.branch) return worktree.branch.replace(/^refs\/heads\//, "")
  if (worktree.detached && worktree.head) {
    return `detached@${worktree.head.slice(0, 7)}`
  }
  return worktree.path.split("/").filter(Boolean).pop() ?? worktree.path
}

function useProjectWorktrees(projectPath: string, open: boolean) {
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])
  const [loading, setLoading] = useState(false)

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
  }, [open, projectPath])

  return { loading, worktrees }
}

function CheckoutItems({
  projectPath,
  loading,
  worktrees,
  onSelect,
}: {
  projectPath: string
  loading: boolean
  worktrees: readonly GitWorktree[]
  onSelect: (selection: CheckoutSelection) => void
}) {
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
    </>
  )
}

export function AgentLaunchMenu({
  projectPath,
  open,
  onOpenChange,
  onLaunch,
  trigger,
}: {
  projectPath: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onLaunch: (driver: AgentCliDriver, checkout: CheckoutSelection) => void
  trigger: ReactNode
}) {
  const { loading, worktrees } = useProjectWorktrees(projectPath, open)

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        className="w-64 border-0"
        data-yaade-agent-launch-menu=""
      >
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
                onSelect={checkout => onLaunch(driver, checkout)}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TerminalLaunchMenu({
  projectPath,
  open,
  onOpenChange,
  onSelect,
  trigger,
}: {
  projectPath: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (checkout: CheckoutSelection) => void
  trigger: ReactNode
}) {
  const { loading, worktrees } = useProjectWorktrees(projectPath, open)

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        className="w-56 border-0"
        data-yaade-terminal-launch-menu=""
      >
        <CheckoutItems
          projectPath={projectPath}
          loading={loading}
          worktrees={worktrees}
          onSelect={onSelect}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
