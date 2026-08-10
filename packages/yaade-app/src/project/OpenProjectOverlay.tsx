import {
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from "react"
import {
  Badge,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
} from "@yaade/ui/primitives"
import { pathToFileUri } from "@yaade/shared"
import { Check, FolderKanban, FolderOpen } from "lucide-react"

export type OpenProjectCandidate = {
  id: string
  name: string
  rootPath: string
  availability?: "available" | "missing" | "forbidden"
  lastActivityAt?: string | null
}

export type OpenProjectOverlayProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  homeDir: string
  projects: readonly OpenProjectCandidate[]
  selectedRootPath?: string | null
  onOpenProject: (project: OpenProjectCandidate) => void
  onOpenPath: (rootPath: string) => Promise<void>
  trigger: ReactElement
  side?: "top" | "bottom" | "left" | "right"
  align?: "start" | "center" | "end"
}

export function resolveProjectInput(input: string, homeDir: string): string {
  const trimmed = input.trim()
  if (trimmed === "~") return homeDir
  if (trimmed.startsWith("~/")) {
    return `${homeDir.replace(/\/+$/, "")}/${trimmed.slice(2)}`
  }
  return trimmed
}

export function isPathInput(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/")
}

function sameProjectPath(a: string, b: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\/+$/, "").replace(/^\/private(\/var\/)/, "$1")
  return normalize(a) === normalize(b)
}

function projectCommandValue(project: OpenProjectCandidate): string {
  return `${project.name} ${project.rootPath}`
}

export function OpenProjectOverlay({
  open,
  onOpenChange,
  homeDir,
  projects,
  selectedRootPath = null,
  onOpenProject,
  onOpenPath,
  trigger,
  side = "bottom",
  align = "start",
}: OpenProjectOverlayProps) {
  const [query, setQuery] = useState("")
  const deferredInput = useDeferredValue(query.trim())
  const deferredQuery = deferredInput.toLocaleLowerCase()
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [pathCheck, setPathCheck] = useState<{
    path: string
    status: "checking" | "exists" | "missing"
  } | null>(null)
  const pathQuery = isPathInput(query)
  const deferredPathQuery = isPathInput(deferredInput)
  const resolvedPath = resolveProjectInput(query, homeDir)
  const deferredResolvedPath = resolveProjectInput(deferredInput, homeDir)
  const currentPathStatus =
    pathCheck?.path === resolvedPath ? pathCheck.status : "checking"
  const canOpenPath =
    pathQuery &&
    resolvedPath.length > 0 &&
    currentPathStatus === "exists"

  const filtered = useMemo(() => {
    const sorted = [...projects].sort((a, b) =>
      (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""),
    )
    if (!deferredQuery || deferredPathQuery) {
      return deferredPathQuery ? [] : sorted.slice(0, 20)
    }
    return sorted
      .filter(
        project =>
          project.name.toLocaleLowerCase().includes(deferredQuery) ||
          project.rootPath.toLocaleLowerCase().includes(deferredQuery),
      )
      .slice(0, 20)
  }, [deferredPathQuery, deferredQuery, projects])

  useEffect(() => {
    setPathCheck(null)
    if (!open || !deferredPathQuery || !deferredResolvedPath) return

    let cancelled = false
    const path = deferredResolvedPath
    setPathCheck({ path, status: "checking" })
    const timer = window.setTimeout(() => {
      const stat = window.yaade?.fs?.stat
      if (!stat) {
        setPathCheck({ path, status: "missing" })
        return
      }
      void stat(pathToFileUri(path))
        .then(stat => {
          if (!cancelled) {
            setPathCheck({
              path,
              status: stat.isDirectory ? "exists" : "missing",
            })
          }
        })
        .catch(() => {
          if (!cancelled) setPathCheck({ path, status: "missing" })
        })
    }, 140)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [deferredPathQuery, deferredResolvedPath, open])

  useEffect(() => {
    if (!open) {
      setQuery("")
      setError(null)
      setSubmitting(false)
      setPathCheck(null)
    }
  }, [open])

  const close = () => {
    onOpenChange(false)
    setQuery("")
    setError(null)
  }

  const selectProject = (project: OpenProjectCandidate) => {
    if (project.availability && project.availability !== "available") return
    onOpenProject(project)
    close()
  }

  const submitPath = async () => {
    if (!canOpenPath || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onOpenPath(resolvedPath)
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open project")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={next => {
        if (!next) close()
        else onOpenChange(true)
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={8}
        className="w-[min(22rem,calc(100vw-1rem))] p-0"
        data-yaade-project-switcher-menu=""
        onOpenAutoFocus={event => {
          event.preventDefault()
          const root = event.currentTarget as HTMLElement
          root
            .querySelector<HTMLInputElement>("[data-yaade-project-switcher-search]")
            ?.focus()
        }}
        onCloseAutoFocus={event => event.preventDefault()}
      >
        <Command shouldFilter={false} className="rounded-md">
          <CommandInput
            placeholder="Search projects or enter a path…"
            aria-label="Search projects or enter a path"
            data-yaade-project-switcher-search=""
            value={query}
            onValueChange={value => {
              setQuery(value)
              setError(null)
            }}
            onKeyDown={event => {
              if (event.key !== "Enter") return
              event.preventDefault()
              if (canOpenPath) {
                void submitPath()
                return
              }
              const project = filtered[0]
              if (project) selectProject(project)
            }}
            disabled={submitting}
          />
          <CommandList
            className="max-h-72 p-1"
            data-yaade-list-panel="project-switcher"
          >
            {pathQuery && currentPathStatus === "checking" ? (
              <div
                className="px-2 py-3 text-center text-xs text-muted-foreground"
                data-yaade-project-path-status="checking"
              >
                Checking path…
              </div>
            ) : canOpenPath ? (
              <CommandGroup>
                <CommandItem
                  value={`open path ${resolvedPath}`}
                  data-yaade-list-item
                  data-yaade-project-path=""
                  disabled={submitting}
                  onSelect={() => void submitPath()}
                  className="min-h-9 gap-2 px-2 py-1.5"
                >
                  {submitting ? (
                    <Spinner className="size-4 shrink-0" />
                  ) : (
                    <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">Open path</span>
                    <span className="block truncate font-mono text-3xs text-muted-foreground">
                      {resolvedPath}
                    </span>
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : pathQuery ? (
              <CommandEmpty className="py-6 text-xs">
                Path does not exist or is not a directory.
              </CommandEmpty>
            ) : filtered.length > 0 ? (
              <CommandGroup heading="Projects">
                {filtered.map(project => {
                  const unavailable =
                    project.availability && project.availability !== "available"
                  const selected =
                    selectedRootPath != null &&
                    sameProjectPath(project.rootPath, selectedRootPath)
                  return (
                    <CommandItem
                      key={project.id}
                      value={projectCommandValue(project)}
                      data-yaade-list-item
                      data-yaade-open-project-item={project.id}
                      disabled={Boolean(unavailable) || submitting}
                      onSelect={() => selectProject(project)}
                      className="min-h-10 gap-2 px-2 py-1.5"
                    >
                      <Check
                        className={selected ? "size-3.5 shrink-0" : "size-3.5 shrink-0 opacity-0"}
                        aria-hidden
                      />
                      <FolderKanban className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm">{project.name}</span>
                          {unavailable ? (
                            <Badge variant="destructive" className="capitalize">
                              {project.availability}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="block truncate font-mono text-3xs text-muted-foreground">
                          {project.rootPath}
                        </span>
                      </span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ) : (
              <CommandEmpty className="py-6 text-xs">
                {projects.length === 0
                  ? "No known projects. Enter a path to open one."
                  : "No matching projects."}
              </CommandEmpty>
            )}
          </CommandList>
          {error ? (
            <p className="border-t px-3 py-2 text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
