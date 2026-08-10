import type { ReactNode } from "react"
import { Folder, FolderPlus } from "lucide-react"
import { Button } from "../components/ui/button.js"
import {
  SidebarTrigger,
  useSidebar,
} from "../components/ui/sidebar.js"
import { cn } from "../lib/utils.js"
import { SidebarShell } from "./SidebarShell.js"

export type ProjectSidebarProject = {
  id: string
  name: string
  rootPath: string
}

export type ProjectSidebarProps = {
  projects: readonly ProjectSidebarProject[]
  activeProjectId?: string | null
  onSelectProject: (project: ProjectSidebarProject) => void
  /** Render the page-owned project picker trigger for the current sidebar state. */
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
  const { state, isMobile, peek } = useSidebar()
  const compact = state === "collapsed" && !peek && !isMobile

  return (
    <SidebarShell
      className={cn(
        "shrink-0",
        compact ? "w-(--sidebar-width-icon)" : "w-(--sidebar-width)",
        isMobile && "w-full max-w-[18rem]",
        className,
      )}
      aria-label="Projects"
      dataAttributes={{
        "data-yaade-project-sidebar": "",
        "data-yaade-sidebar-state": state,
      }}
      header={
        <>
          {compact ? (
            <div className="flex flex-col items-center gap-1">
              <SidebarTrigger
                aria-label="Toggle projects sidebar"
                data-yaade-project-sidebar-toggle=""
              />
              {renderAddProject(true)}
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <SidebarTrigger
                aria-label="Toggle projects sidebar"
                data-yaade-project-sidebar-toggle=""
              />
              <span className="min-w-0 flex-1 truncate px-1 text-xs font-semibold">
                Projects
              </span>
              {renderAddProject(false)}
            </div>
          )}
        </>
      }
      contentProps={{ "data-yaade-project-sidebar-content": "" }}
      contentClassName="gap-0"
    >
      {loading ? (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
          Loading projects…
        </div>
      ) : error ? (
        <div className="flex flex-col gap-2 px-3 py-6 text-center text-xs">
          <p className="text-destructive">{error}</p>
          {onRetry ? (
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : projects.length === 0 ? (
        <div
          className="flex flex-col items-center gap-2 px-3 py-8 text-center"
          data-yaade-project-sidebar-empty=""
        >
          <FolderPlus className="size-4 text-muted-foreground" aria-hidden />
          <p className="text-xs font-medium">No projects yet</p>
          <p className="text-3xs text-muted-foreground">
            Add a project to get started.
          </p>
        </div>
      ) : (
        <div className="p-1.5">
          {!compact ? (
            <p className="px-2 pb-1 text-3xs uppercase tracking-wide text-muted-foreground">
              Available projects
            </p>
          ) : null}
          <div className="flex flex-col gap-0.5">
            {projects.map(project => {
              const selected = project.id === activeProjectId
              return (
                <button
                  key={project.id}
                  type="button"
                  className={cn(
                    "flex h-9 min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors",
                    selected
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/60",
                  )}
                  aria-current={selected ? "page" : undefined}
                  data-yaade-project-sidebar-item={project.id}
                  title={compact ? project.name : undefined}
                  onClick={() => onSelectProject(project)}
                >
                  <Folder
                    className={cn(
                      "size-3.5 shrink-0",
                      selected && "text-sidebar-primary",
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">
                      {project.name}
                    </span>
                    {!compact ? (
                      <span className="block truncate text-3xs text-muted-foreground">
                        {projectDirectory(project.rootPath)}
                      </span>
                    ) : null}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </SidebarShell>
  )
}
