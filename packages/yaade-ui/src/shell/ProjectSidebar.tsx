import type { ReactNode } from "react"
import { Activity, Folder, FolderPlus } from "lucide-react"
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

export type ProjectSidebarProject = {
  id: string
  name: string
  rootPath: string
}

export type ProjectSidebarProps = {
  projects: readonly ProjectSidebarProject[]
  activeProjectId?: string | null
  onSelectProject: (project: ProjectSidebarProject) => void
  renderAddProject: (compact: boolean) => ReactNode
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  className?: string
}

function projectDirectory(rootPath: string): string {
  const normalized = rootPath.replace(/\\/g, "/").replace(/\/+$/, "")
  return normalized.split("/").pop() || rootPath
}

export function ProjectSidebar({
  projects,
  activeProjectId = null,
  onSelectProject,
  renderAddProject,
  loading = false,
  error = null,
  onRetry,
  className,
}: ProjectSidebarProps) {
  const { isMobile, setOpenMobile, state } = useSidebar()

  const selectProject = (project: ProjectSidebarProject) => {
    onSelectProject(project)
    if (isMobile) setOpenMobile(false)
  }

  return (
    <Sidebar
      variant="sidebar"
      collapsible="icon"
      className={cn("border-sidebar-border", className)}
      aria-label="HQ navigation"
      data-yaade-hq-sidebar=""
      data-yaade-project-sidebar=""
      data-yaade-sidebar-state={state}
    >
      <SidebarHeader className="gap-1 border-b border-sidebar-border p-2">
        <div className="flex items-center gap-1">
          <SidebarTrigger
            aria-label="Toggle HQ sidebar"
            data-yaade-project-sidebar-toggle=""
          />
          <div className="min-w-0 flex-1 px-1 group-data-[collapsible=icon]:hidden">
            <span className="block truncate text-xs font-semibold">YAADE HQ</span>
            <span className="block truncate text-3xs text-sidebar-foreground/60">
              Local developer cockpit
            </span>
          </div>
          <div className="group-data-[collapsible=icon]:hidden">
            {renderAddProject(false)}
          </div>
        </div>
        <div className="hidden group-data-[collapsible=icon]:block">
          {renderAddProject(true)}
        </div>
      </SidebarHeader>

      <SidebarContent className="gap-0" data-yaade-project-sidebar-content="">
        <SidebarGroup className="gap-1 py-2">
          <SidebarGroupLabel>HQ</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem data-yaade-hq-nav-item="agents">
                <SidebarMenuButton
                  type="button"
                  isActive
                  tooltip="Live agents"
                  aria-current="page"
                >
                  <Activity aria-hidden />
                  <span>Live agents</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup className="gap-1 py-2">
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <SidebarGroupContent>
            {loading ? (
              <div className="px-2 py-3 text-3xs text-sidebar-foreground/60">
                Loading projects…
              </div>
            ) : error ? (
              <div className="flex flex-col gap-2 px-2 py-3 text-3xs">
                <p className="text-destructive">{error}</p>
                {onRetry ? (
                  <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                    Retry
                  </Button>
                ) : null}
              </div>
            ) : projects.length === 0 ? (
              <div
                className="flex flex-col items-center gap-2 px-2 py-6 text-center"
                data-yaade-project-sidebar-empty=""
              >
                <FolderPlus className="size-4 text-muted-foreground" aria-hidden />
                <p className="text-xs font-medium">No projects yet</p>
                <p className="text-3xs text-sidebar-foreground/60">
                  Add a project to get started.
                </p>
              </div>
            ) : (
              <SidebarMenu>
                {projects.map(project => {
                  const selected = project.id === activeProjectId
                  return (
                    <SidebarMenuItem
                      key={project.id}
                      data-yaade-project-sidebar-item={project.id}
                    >
                      <SidebarMenuButton
                        type="button"
                        isActive={selected}
                        tooltip={project.name}
                        aria-current={selected ? "page" : undefined}
                        onClick={() => selectProject(project)}
                      >
                        <Folder aria-hidden />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-xs font-medium">{project.name}</span>
                          <span className="truncate text-3xs text-sidebar-foreground/60">
                            {projectDirectory(project.rootPath)}
                          </span>
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <div className="px-2 text-3xs text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden">
          Projects on this machine
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
