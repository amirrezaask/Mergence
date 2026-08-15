import {
  FileCode2,
  GitBranch,
  Search,
  Terminal,
  type LucideIcon,
} from "lucide-react"
import type { ToolKind } from "@yaade/rpc"
import { KeyBindingKbd } from "@yaade/ui"
import {
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Skeleton,
} from "@yaade/ui/primitives"
import { toolSessionShortcutFor } from "./tool-session-keymap.js"

type ToolTile = {
  readonly kind: ToolKind
  readonly label: string
  readonly hint: string
  readonly command: string
  readonly Icon: LucideIcon
}

const TOOL_TILES: readonly ToolTile[] = [
  {
    kind: "terminal",
    label: "Terminal",
    hint: "Host shell",
    command: "tool.newTerminal",
    Icon: Terminal,
  },
  {
    kind: "search",
    label: "Search",
    hint: "Project grep",
    command: "tool.newSearch",
    Icon: Search,
  },
  {
    kind: "editor",
    label: "Editor",
    hint: "Files in a worktree",
    command: "tool.newEditor",
    Icon: FileCode2,
  },
  {
    kind: "git",
    label: "Git",
    hint: "History and diff",
    command: "tool.newGit",
    Icon: GitBranch,
  },
]

export function SessionBootState() {
  return (
    <div
      className="flex h-full min-h-0 w-full items-center justify-center p-4 sm:p-6"
      data-yaade-session-boot=""
      role="status"
      aria-label="Loading sessions"
    >
      <div className="flex w-full max-w-3xl flex-col items-center gap-6">
        <Skeleton className="h-4 w-28" />
        <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4">
          {TOOL_TILES.map(tile => (
            <Skeleton key={tile.kind} className="h-28 rounded-md" />
          ))}
        </div>
      </div>
    </div>
  )
}

export function SessionEmptyState(props: {
  readonly onAddKind: (kind: ToolKind) => void
}) {
  return (
    <Empty
      className="h-full min-h-0 w-full justify-center rounded-none border-0 p-4 sm:p-6"
      data-yaade-session-empty=""
      role="region"
      aria-label="Start a tool"
    >
      <EmptyHeader className="max-w-md">
        <EmptyTitle className="text-base">Start a tool</EmptyTitle>
        <EmptyDescription className="text-xs">
          Each tool picks its own project and worktree. Press{" "}
          <KeyBindingKbd binding="Ctrl-a" /> then a letter, or pick one below.
        </EmptyDescription>
      </EmptyHeader>

      <EmptyContent className="max-w-3xl gap-6">
        <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4">
          {TOOL_TILES.map(tile => {
            const shortcut = toolSessionShortcutFor(tile.command)
            const Icon = tile.Icon
            return (
              <Button
                key={tile.kind}
                type="button"
                variant="outline"
                data-yaade-empty-tool={tile.kind}
                aria-label={tile.label}
                onClick={() => props.onAddKind(tile.kind)}
                className="group/empty-tile h-auto flex-col gap-2.5 border-border bg-card px-3 py-4 text-center"
              >
                <span
                  className="flex size-10 items-center justify-center rounded-md border border-border bg-secondary text-foreground transition-colors duration-[var(--yaade-motion-hot)] group-hover/empty-tile:border-primary/35 group-hover/empty-tile:text-primary"
                  aria-hidden
                >
                  <Icon className="size-5" />
                </span>
                <span className="flex flex-col items-center gap-0.5">
                  <span className="text-xs font-medium text-foreground">
                    {tile.label}
                  </span>
                  <span className="line-clamp-2 text-3xs text-muted-foreground">
                    {tile.hint}
                  </span>
                </span>
                {shortcut ? (
                  <KeyBindingKbd
                    binding={shortcut}
                    className="opacity-70 group-hover/empty-tile:opacity-100"
                  />
                ) : null}
              </Button>
            )
          })}
        </div>
      </EmptyContent>
    </Empty>
  )
}
