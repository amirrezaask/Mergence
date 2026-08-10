import { useState, type ReactNode } from "react"
import { ChevronDown, ChevronRight, Circle, House, Plus, X } from "lucide-react"
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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "../components/ui/sidebar.js"
import { Badge } from "../components/ui/badge.js"
import { cn } from "../lib/utils.js"

export type ProjectWorkspaceSidebarView = {
  id: string
  label: string
  icon: ReactNode
  selected: boolean
  onSelect: () => void
}

export type ProjectWorkspaceSidebarProcess = {
  id: string
  label: string
  subtitle?: string
  icon: ReactNode
  selected: boolean
  status?: string
  statusVariant?: "default" | "secondary" | "destructive" | "outline"
  onSelect: () => void
  onClose?: () => void
}

export type ProjectWorkspaceSidebarProps = {
  projectName: string
  projectSwitcher?: ReactNode
  views: readonly ProjectWorkspaceSidebarView[]
  agents: readonly ProjectWorkspaceSidebarProcess[]
  terminals: readonly ProjectWorkspaceSidebarProcess[]
  onOpenHq: () => void
  onNewAgent: () => void
  onNewTerminal: () => void
  agentLauncher?: ReactNode
  terminalLauncher?: ReactNode
  agentLoading?: boolean
  terminalLoading?: boolean
  agentError?: string | null
  terminalError?: string | null
  footer?: ReactNode
  className?: string
}

function ProcessGroup({
  label,
  items,
  emptyLabel,
  loading,
  error,
  onNew,
  launcher,
  dataGroup,
}: {
  label: string
  items: readonly ProjectWorkspaceSidebarProcess[]
  emptyLabel: string
  loading?: boolean
  error?: string | null
  onNew: () => void
  launcher?: ReactNode
  dataGroup: "agents" | "terminals"
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
        data-yaade-project-process-group={dataGroup}
        data-yaade-instance-sidebar={dataGroup}
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
            <span>{label}</span>
            <span className="ml-auto tabular-nums text-3xs text-sidebar-foreground/60">
              {items.length}
            </span>
          </SidebarGroupLabel>
        </CollapsibleTrigger>
        {launcher ? (
          <div className="absolute top-3 right-3 z-10 group-data-[collapsible=icon]:hidden">
            {launcher}
          </div>
        ) : (
          <SidebarGroupAction
            type="button"
            aria-label={`New ${label.slice(0, -1).toLowerCase()}`}
            onClick={event => {
              event.stopPropagation()
              onNew()
            }}
            data-yaade-project-process-new={dataGroup}
            data-yaade-instance-sidebar-new=""
          >
            <ChevronDown />
          </SidebarGroupAction>
        )}
        <CollapsibleContent>
          <SidebarGroupContent data-yaade-list-panel={`project-${dataGroup}`}>
            {loading || error || items.length === 0 ? (
              <div className="px-2 py-2 text-3xs text-sidebar-foreground/60">
                {loading ? `Loading ${label.toLowerCase()}…` : error ?? emptyLabel}
              </div>
            ) : (
              <SidebarMenu>
                {items.map(item => (
                  <SidebarMenuItem
                    key={item.id}
                    className="shrink-0"
                    data-yaade-project-process-item={item.id}
                    data-yaade-list-item=""
                  >
                    <SidebarMenuButton
                      type="button"
                      isActive={item.selected}
                      tooltip={item.label}
                      onClick={() => select(item)}
                      className="h-auto min-h-8 py-1.5"
                      aria-current={item.selected ? "true" : undefined}
                      data-yaade-instance-sidebar-item={item.id}
                    >
                      {item.icon}
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-xs">{item.label}</span>
                        {item.subtitle ? (
                          <span className="truncate text-3xs text-sidebar-foreground/60">
                            {item.subtitle}
                          </span>
                        ) : null}
                      </span>
                    </SidebarMenuButton>
                    {item.status ? (
                      <SidebarMenuBadge>
                        <Badge
                          variant={item.statusVariant ?? "secondary"}
                          className="h-4 px-1 text-4xs"
                        >
                          {item.status}
                        </Badge>
                      </SidebarMenuBadge>
                    ) : null}
                    {item.onClose ? (
                      <SidebarMenuAction
                        type="button"
                        showOnHover
                        aria-label={`Close ${item.label}`}
                        onClick={event => {
                          event.stopPropagation()
                          item.onClose?.()
                        }}
                        data-yaade-instance-sidebar-close={item.id}
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

export function ProjectWorkspaceSidebar({
  projectName,
  projectSwitcher,
  views,
  agents,
  terminals,
  onOpenHq,
  onNewAgent,
  onNewTerminal,
  agentLoading,
  terminalLoading,
  agentError,
  terminalError,
  agentLauncher,
  terminalLauncher,
  footer,
  className,
}: ProjectWorkspaceSidebarProps) {
  const { isMobile, setOpenMobile } = useSidebar()

  const selectView = (view: ProjectWorkspaceSidebarView) => {
    view.onSelect()
    if (isMobile) setOpenMobile(false)
  }

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
        </div>
        <div className="min-w-0">
          {projectSwitcher}
        </div>
      </SidebarHeader>

      <SidebarContent className="gap-0" data-yaade-project-sidebar-content="">
        <SidebarGroup className="gap-1 py-2">
          <SidebarGroupContent>
            <SidebarMenu>
              {views.map(view => (
                <SidebarMenuItem key={view.id} data-yaade-project-nav-item={view.id}>
                  <SidebarMenuButton
                    type="button"
                    isActive={view.selected}
                    tooltip={view.label}
                    onClick={() => selectView(view)}
                    aria-current={view.selected ? "page" : undefined}
                    aria-selected={view.selected ? "true" : "false"}
                    data-yaade-project-tab={view.id}
                  >
                    {view.icon}
                    <span>{view.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <ProcessGroup
          label="Agents"
          items={agents}
          emptyLabel="No agents yet"
          loading={agentLoading}
          error={agentError}
          onNew={onNewAgent}
          launcher={agentLauncher}
          dataGroup="agents"
        />
        <ProcessGroup
          label="Terminals"
          items={terminals}
          emptyLabel="No terminals yet"
          loading={terminalLoading}
          error={terminalError}
          onNew={onNewTerminal}
          launcher={terminalLauncher}
          dataGroup="terminals"
        />
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
