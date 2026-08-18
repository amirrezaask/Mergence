import { useState, type ReactNode } from "react"
import {
  ChevronRight,
  Circle,
  GitBranch,
  House,
  Plus,
  Search,
  Settings,
  X,
} from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible.js"
import { Button } from "../components/ui/button.js"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "../components/ui/sidebar.js"
import { cn } from "../lib/utils.js"
import { SidebarProcessItem, type SidebarProcessItemData } from "./SidebarProcessItem.js"

export type ProjectWorkspaceSidebarView = {
  id: string
  label: string
  icon: ReactNode
  selected: boolean
  onSelect: () => void
}

export type ProjectWorkspaceSidebarWorktree = {
  id: string
  label: string
  subtitle?: string
  selected: boolean
  onSelect: () => void
  onRemove?: () => void
}

export type ProjectWorkspaceSidebarProcess = SidebarProcessItemData & {
  icon: ReactNode
  selected: boolean
}

export type ProjectWorkspaceSidebarSearch = {
  id: string
  label: string
  selected: boolean
  onSelect: () => void
  onClose: () => void
}

const EMPTY_SEARCHES: readonly ProjectWorkspaceSidebarSearch[] = []

export type ProjectWorkspaceSidebarProps = {
  projectName: string
  projectSwitcher?: ReactNode
  gitHistoryWorktrees: readonly ProjectWorkspaceSidebarWorktree[]
  gitHistoryLoading?: boolean
  gitHistoryError?: string | null
  onNewGitWorktree: () => void
  searches?: readonly ProjectWorkspaceSidebarSearch[]
  onNewSearch?: () => void
  onOpenHq: () => void
  onOpenSettings: () => void
  /** Single Running launcher (+ shell & agent providers). */
  launcher?: ReactNode
  /** Omit this slot to compose a workspace without the Running section. */
  processes?: readonly ProjectWorkspaceSidebarProcess[]
  loading?: boolean
  error?: string | null
  footer?: ReactNode
  className?: string
}

function GitHistoryGroup({
  worktrees,
  loading,
  error,
  onNew,
}: {
  worktrees: readonly ProjectWorkspaceSidebarWorktree[]
  loading?: boolean
  error?: string | null
  onNew: () => void
}) {
  const { isMobile, setOpenMobile } = useSidebar()
  const [open, setOpen] = useState(true)

  const select = (item: ProjectWorkspaceSidebarWorktree) => {
    item.onSelect()
    if (isMobile) setOpenMobile(false)
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <SidebarGroup
        className="gap-1 py-2 group-data-[collapsible=icon]:hidden"
        data-yaade-project-git-history-group=""
        data-state={open ? "open" : "closed"}
      >
        <CollapsibleTrigger asChild>
          <SidebarGroupLabel className="cursor-pointer select-none pr-10 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
            <ChevronRight
              className={cn(
                "transition-transform duration-[var(--yaade-motion-fast)] ease-[var(--yaade-ease-out)]",
                open && "rotate-90",
              )}
              aria-hidden
            />
            <GitBranch aria-hidden />
            <span>Git</span>
            <span className="ml-auto tabular-nums text-3xs text-sidebar-foreground/60">
              {worktrees.length}
            </span>
          </SidebarGroupLabel>
        </CollapsibleTrigger>
        <SidebarGroupAction
          type="button"
          aria-label="New worktree"
          onClick={event => {
            event.stopPropagation()
            onNew()
          }}
          data-yaade-project-worktree-create=""
        >
          <Plus />
        </SidebarGroupAction>
        <CollapsibleContent>
          <SidebarGroupContent data-yaade-list-panel="project-git-history">
            {loading || error || worktrees.length === 0 ? (
              <div className="px-2 py-2 text-3xs text-sidebar-foreground/60">
                {loading ? "Loading worktrees…" : error ?? "No worktrees yet"}
              </div>
            ) : (
              <SidebarMenu>
                {worktrees.map(item => (
                  <SidebarMenuItem
                    key={item.id}
                    className="shrink-0"
                    data-yaade-project-worktree-item={item.id}
                    data-yaade-list-item=""
                  >
                    <SidebarMenuButton
                      type="button"
                      isActive={item.selected}
                      tooltip={item.label}
                      onClick={() => select(item)}
                      className="h-auto min-h-8 py-1.5"
                      aria-current={item.selected ? "page" : undefined}
                    >
                      <GitBranch aria-hidden />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-xs">{item.label}</span>
                        {item.subtitle ? (
                          <span className="truncate text-3xs text-sidebar-foreground/60">
                            {item.subtitle}
                          </span>
                        ) : null}
                      </span>
                    </SidebarMenuButton>
                    {item.onRemove ? (
                      <SidebarMenuAction
                        type="button"
                        showOnHover
                        aria-label={`Remove ${item.label} worktree`}
                        onClick={event => {
                          event.stopPropagation()
                          item.onRemove?.()
                        }}
                        data-yaade-project-worktree-remove={item.id}
                      >
                        <X />
                      </SidebarMenuAction>
                    ) : null}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  )
}

function SearchesGroup({
  items,
  onNew,
}: {
  items: readonly ProjectWorkspaceSidebarSearch[]
  onNew: () => void
}) {
  const { isMobile, setOpenMobile } = useSidebar()
  const [open, setOpen] = useState(true)

  const select = (item: ProjectWorkspaceSidebarSearch) => {
    item.onSelect()
    if (isMobile) setOpenMobile(false)
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <SidebarGroup
        className="gap-1 py-2 group-data-[collapsible=icon]:hidden"
        data-yaade-project-searches-group=""
        data-state={open ? "open" : "closed"}
      >
        <CollapsibleTrigger asChild>
          <SidebarGroupLabel className="cursor-pointer select-none pr-10 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
            <ChevronRight
              className={cn(
                "transition-transform duration-[var(--yaade-motion-fast)] ease-[var(--yaade-ease-out)]",
                open && "rotate-90",
              )}
              aria-hidden
            />
            <Search aria-hidden />
            <span>Searches</span>
            <span className="ml-auto tabular-nums text-3xs text-sidebar-foreground/60">
              {items.length}
            </span>
          </SidebarGroupLabel>
        </CollapsibleTrigger>
        <SidebarGroupAction
          type="button"
          aria-label="New search"
          onClick={event => {
            event.stopPropagation()
            onNew()
          }}
          data-yaade-project-search-create=""
        >
          <Plus />
        </SidebarGroupAction>
        <CollapsibleContent>
          <SidebarGroupContent data-yaade-list-panel="project-searches">
            {items.length === 0 ? (
              <div className="px-2 py-2 text-3xs text-sidebar-foreground/60">
                No searches yet
              </div>
            ) : (
              <SidebarMenu>
                {items.map(item => (
                  <SidebarMenuItem
                    key={item.id}
                    className="shrink-0"
                    data-yaade-project-search-item={item.id}
                    data-yaade-list-item=""
                  >
                    <SidebarMenuButton
                      type="button"
                      isActive={item.selected}
                      tooltip={item.label}
                      onClick={() => select(item)}
                      className="h-auto min-h-8 py-1.5"
                      aria-current={item.selected ? "page" : undefined}
                    >
                      <Search aria-hidden />
                      <span className="truncate text-xs">{item.label}</span>
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      type="button"
                      showOnHover
                      aria-label={`Close search ${item.label}`}
                      onClick={event => {
                        event.stopPropagation()
                        item.onClose()
                      }}
                      data-yaade-project-search-close={item.id}
                    >
                      <X />
                    </SidebarMenuAction>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  )
}

function ProcessGroup({
  items,
  loading,
  error,
  launcher,
}: {
  items: readonly ProjectWorkspaceSidebarProcess[]
  loading?: boolean
  error?: string | null
  launcher?: ReactNode
}) {
  const { isMobile, setOpenMobile } = useSidebar()
  const [open, setOpen] = useState(true)

  const select = (item: ProjectWorkspaceSidebarProcess) => {
    item.onSelect()
    if (isMobile) setOpenMobile(false)
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <SidebarGroup
        className="gap-1 py-2 group-data-[collapsible=icon]:hidden"
        data-yaade-project-process-group="running"
        data-state={open ? "open" : "closed"}
      >
        <CollapsibleTrigger asChild>
          <SidebarGroupLabel className="cursor-pointer select-none pr-10 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
            <ChevronRight
              className={cn(
                "transition-transform duration-[var(--yaade-motion-fast)] ease-[var(--yaade-ease-out)]",
                open && "rotate-90",
              )}
              aria-hidden
            />
            <span>Running</span>
            <span className="ml-auto tabular-nums text-3xs text-sidebar-foreground/60">
              {items.length}
            </span>
          </SidebarGroupLabel>
        </CollapsibleTrigger>
        {launcher ? (
          <div className="absolute top-3 right-3 z-10 group-data-[collapsible=icon]:hidden">
            {launcher}
          </div>
        ) : null}
        <CollapsibleContent>
          <SidebarGroupContent data-yaade-list-panel="project-running">
            {loading || error || items.length === 0 ? (
              <div className="px-2 py-2 text-3xs text-sidebar-foreground/60">
                {loading ? "Loading processes…" : error ?? "No processes yet"}
              </div>
            ) : (
              <SidebarMenu>
                {items.map(item => (
                  <SidebarProcessItem
                    key={item.id}
                    item={item}
                    variant="menu"
                    onSelect={() => select(item)}
                  />
                ))}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  )
}

export function ProjectWorkspaceSidebar({
  projectName,
  projectSwitcher,
  gitHistoryWorktrees,
  gitHistoryLoading,
  gitHistoryError,
  onNewGitWorktree,
  processes,
  searches = EMPTY_SEARCHES,
  onNewSearch,
  onOpenHq,
  onOpenSettings,
  launcher,
  loading,
  error,
  footer,
  className,
}: ProjectWorkspaceSidebarProps) {
  return (
    <Sidebar
      variant="sidebar"
      collapsible="icon"
      className={cn("border-sidebar-border", className)}
      data-yaade-project-sidebar=""
      aria-label={`${projectName} project navigation`}
    >
      <SidebarHeader className="gap-1 border-b border-sidebar-border p-2">
        <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
          <SidebarTrigger
            aria-label="Toggle project sidebar"
            data-yaade-project-sidebar-toggle=""
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            aria-label="Open HQ"
            onClick={onOpenHq}
          >
            <House />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            aria-label="Open settings"
            title="Settings"
            onClick={onOpenSettings}
            data-yaade-project-sidebar-settings=""
          >
            <Settings />
          </Button>
        </div>
        <div className="min-w-0">
          {projectSwitcher}
        </div>
      </SidebarHeader>

      <SidebarContent className="gap-0" data-yaade-project-sidebar-content="">
        <GitHistoryGroup
          worktrees={gitHistoryWorktrees}
          loading={gitHistoryLoading}
          error={gitHistoryError}
          onNew={onNewGitWorktree}
        />
        <SidebarSeparator />
        {onNewSearch ? (
          <>
            <SearchesGroup items={searches} onNew={onNewSearch} />
            <SidebarSeparator />
          </>
        ) : null}
        {processes ? (
          <ProcessGroup
            items={processes}
            loading={loading}
            error={error}
            launcher={launcher}
          />
        ) : null}
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        {footer}
        <div className="flex items-center gap-2 px-2 text-3xs text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden">
          <Circle className="size-1.5 fill-current text-success" aria-hidden />
          <span className="truncate">{projectName}</span>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
