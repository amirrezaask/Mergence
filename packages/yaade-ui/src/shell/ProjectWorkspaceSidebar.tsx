import { useState, type ReactNode } from "react"
import { ChevronRight, Circle, House } from "lucide-react"
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
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
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

export type ProjectWorkspaceSidebarProcess = SidebarProcessItemData & {
  icon: ReactNode
  selected: boolean
}

export type ProjectWorkspaceSidebarProps = {
  projectName: string
  projectSwitcher?: ReactNode
  views: readonly ProjectWorkspaceSidebarView[]
  processes: readonly ProjectWorkspaceSidebarProcess[]
  onOpenHq: () => void
  /** Single Running launcher (+ shell & agent providers). */
  launcher?: ReactNode
  loading?: boolean
  error?: string | null
  footer?: ReactNode
  className?: string
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
  views,
  processes,
  onOpenHq,
  launcher,
  loading,
  error,
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
          items={processes}
          loading={loading}
          error={error}
          launcher={launcher}
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
