import { useDeferredValue, useMemo, useState } from "react"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Spinner,
} from "@yaade/ui/primitives"
import { FolderKanban, FolderOpen, Search } from "lucide-react"

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
  onOpenProject: (project: OpenProjectCandidate) => void
  onOpenPath: (rootPath: string) => Promise<void>
}

function resolveProjectInput(input: string, homeDir: string): string {
  const trimmed = input.trim()
  if (trimmed === "~") return homeDir
  if (trimmed.startsWith("~/")) {
    return `${homeDir.replace(/\/+$/, "")}/${trimmed.slice(2)}`
  }
  return trimmed
}

function isPathInput(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/")
}

export function OpenProjectOverlay({
  open,
  onOpenChange,
  homeDir,
  projects,
  onOpenProject,
  onOpenPath,
}: OpenProjectOverlayProps) {
  const [query, setQuery] = useState("")
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase())
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const filtered = useMemo(() => {
    const sorted = [...projects].sort((a, b) =>
      (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""),
    )
    if (!deferredQuery || isPathInput(deferredQuery)) return sorted.slice(0, 20)
    return sorted
      .filter(
        project =>
          project.name.toLocaleLowerCase().includes(deferredQuery) ||
          project.rootPath.toLocaleLowerCase().includes(deferredQuery),
      )
      .slice(0, 20)
  }, [deferredQuery, projects])

  const close = () => {
    onOpenChange(false)
    setQuery("")
    setError(null)
  }

  const submit = async () => {
    const rootPath = resolveProjectInput(query, homeDir)
    if (!rootPath.startsWith("/")) {
      if (filtered.length === 1 && filtered[0]?.availability !== "missing") {
        onOpenProject(filtered[0])
        close()
        return
      }
      setError("Enter an absolute path, a ~/ path, or select a known project.")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await onOpenPath(rootPath)
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open project")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) close()
        else onOpenChange(true)
      }}
    >
      <DialogContent size="picker" motion="instant" data-yaade-open-project="">
        <DialogHeader>
          <DialogTitle>Open Project</DialogTitle>
          <DialogDescription>
            Select a recent project or enter an existing directory.
          </DialogDescription>
        </DialogHeader>
        <form
          className="min-h-0"
          onSubmit={event => {
            event.preventDefault()
            void submit()
          }}
        >
          <FieldGroup>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="yaade-open-project-path" className="sr-only">
                Project path or search
              </FieldLabel>
              <div className="relative">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  id="yaade-open-project-path"
                  autoFocus
                  value={query}
                  onChange={event => {
                    setQuery(event.target.value)
                    setError(null)
                  }}
                  placeholder="Search projects or enter ~/dev/project"
                  aria-invalid={error ? true : undefined}
                  className="pl-9 font-mono"
                />
              </div>
              <FieldDescription>
                YAADE registers the directory; it never creates missing folders.
              </FieldDescription>
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>

            <div className="max-h-72 overflow-y-auto" data-yaade-list-panel="open-projects">
              {filtered.length > 0 ? (
                <ItemGroup className="gap-0.5">
                  {filtered.map(project => {
                    const unavailable = project.availability && project.availability !== "available"
                    return (
                      <Item
                        key={project.id}
                        asChild
                        size="sm"
                        data-yaade-list-item
                        data-yaade-open-project-item={project.id}
                      >
                        <button
                          type="button"
                          disabled={Boolean(unavailable)}
                          className="w-full text-left disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={() => {
                            onOpenProject(project)
                            close()
                          }}
                        >
                          <FolderKanban className="size-4 shrink-0 text-muted-foreground" />
                          <ItemContent>
                            <ItemTitle className="flex items-center gap-2">
                              <span className="truncate">{project.name}</span>
                              {unavailable ? (
                                <Badge variant="destructive" className="capitalize">
                                  {project.availability}
                                </Badge>
                              ) : null}
                            </ItemTitle>
                            <ItemDescription className="truncate font-mono">
                              {project.rootPath}
                            </ItemDescription>
                          </ItemContent>
                        </button>
                      </Item>
                    )
                  })}
                </ItemGroup>
              ) : (
                <p className="py-8 text-center text-xs text-muted-foreground">
                  No matching known projects.
                </p>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={!query.trim() || submitting}>
                {submitting ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <FolderOpen data-icon="inline-start" />
                )}
                Open Path
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  )
}
