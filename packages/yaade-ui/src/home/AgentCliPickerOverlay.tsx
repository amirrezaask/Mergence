import { FolderOpen, Plus, Trash2 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js"
import { Button } from "../components/ui/button.js"
import { Checkbox } from "../components/ui/checkbox.js"
import { Input } from "../components/ui/input.js"
import { Label } from "../components/ui/label.js"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js"
import {
  AGENT_CLI_DRIVERS,
  type AgentCliDriver,
} from "./agent-cli-drivers.js"
import { AgentProviderIcon } from "./sidebar/SessionStatusIndicator.js"

export type AgentCliPickerProject = {
  rootUri: string
  name: string
  path: string
}

export type AgentCliLaunchSelection = {
  driver: AgentCliDriver
  /** When true, create (or use) a git worktree for the launch. */
  useWorktree: boolean
  /** Optional branch / worktree name. Empty → host generates one. */
  worktreeName: string
}

export type AgentCliPickerOverlayProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (selection: AgentCliLaunchSelection) => void
  /** Workspace projects available for the new session. */
  projects?: AgentCliPickerProject[]
  /** Selected project root URI (required when creating a session). */
  selectedRootUri?: string | null
  onSelectedRootUriChange?: (rootUri: string) => void
  onRemoveProject?: (rootUri: string) => boolean | void | Promise<boolean | void>
  /** Opens the Add project folder modal. */
  onAddProject?: () => void
}

export function AgentCliPickerOverlay({
  open,
  onOpenChange,
  onSelect,
  projects = [],
  selectedRootUri = null,
  onSelectedRootUriChange,
  onRemoveProject,
  onAddProject,
}: AgentCliPickerOverlayProps) {
  const [useWorktree, setUseWorktree] = useState(false)
  const [worktreeName, setWorktreeName] = useState("")

  useEffect(() => {
    if (!open) return
    setUseWorktree(false)
    setWorktreeName("")
  }, [open])

  const selectedProject =
    projects.find(project => project.rootUri === selectedRootUri) ?? projects[0]
  const showProjectControl = projects.length > 0 || onAddProject != null

  const removeSelectedProject = async () => {
    if (!selectedProject || !onRemoveProject) return
    const removed = await onRemoveProject(selectedProject.rootUri)
    if (removed === false) return
    const next = projects.find(project => project.rootUri !== selectedProject.rootUri)
    if (next) onSelectedRootUriChange?.(next.rootUri)
  }

  const pick = (driver: AgentCliDriver) => {
    onSelect({
      driver,
      useWorktree,
      worktreeName: worktreeName.trim(),
    })
  }

  const previewHint = useMemo(() => {
    if (!useWorktree) return null
    if (worktreeName.trim()) return `Worktree branch: ${worktreeName.trim()}`
    return "Worktree name will be generated on launch"
  }, [useWorktree, worktreeName])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="picker" className="gap-0 overflow-hidden p-0">
        <DialogHeader className="px-4 pt-4 pb-3">
          <DialogTitle>Launch an agent</DialogTitle>
          <DialogDescription>
            Pick a provider. Optionally launch into a fresh git worktree.
          </DialogDescription>
        </DialogHeader>

        {showProjectControl ? (
          <div
            className="flex items-end gap-2 border-t px-4 py-3"
            data-yaade-agent-cli-project-picker=""
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <label className="text-sm font-medium" htmlFor="agent-project">
                Project
              </label>
              {projects.length > 0 ? (
                <Select
                  value={selectedProject?.rootUri}
                  onValueChange={value => onSelectedRootUriChange?.(value)}
                >
                  <SelectTrigger id="agent-project" className="w-full">
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map(project => (
                      <SelectItem
                        key={project.rootUri}
                        value={project.rootUri}
                        data-yaade-agent-cli-project-option={project.rootUri}
                        data-yaade-agent-cli-project-name={project.name}
                      >
                        <span className="truncate">{project.name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Button
                  id="agent-project"
                  variant="outline"
                  className="w-full justify-start"
                  onClick={onAddProject}
                >
                  <FolderOpen data-icon="inline-start" />
                  Add a project
                </Button>
              )}
            </div>
            {onAddProject && projects.length > 0 ? (
              <Button
                size="icon"
                variant="outline"
                aria-label="Add project"
                data-yaade-agent-cli-add-project=""
                onClick={onAddProject}
              >
                <Plus />
              </Button>
            ) : null}
            {onRemoveProject && selectedProject ? (
              <Button
                size="icon"
                variant="outline"
                aria-label={`Remove ${selectedProject.name}`}
                data-yaade-agent-cli-project-remove={selectedProject.rootUri}
                onClick={() => void removeSelectedProject()}
              >
                <Trash2 />
              </Button>
            ) : null}
          </div>
        ) : null}

        <div
          className="grid gap-3 border-t px-4 py-3"
          data-yaade-agent-cli-worktree=""
        >
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={useWorktree}
              onCheckedChange={checked => setUseWorktree(checked === true)}
              data-yaade-use-worktree=""
            />
            Use a git worktree
          </label>
          {useWorktree ? (
            <div className="grid gap-1.5">
              <Label htmlFor="agent-worktree-name">Worktree name</Label>
              <Input
                id="agent-worktree-name"
                value={worktreeName}
                onChange={event => setWorktreeName(event.target.value)}
                placeholder="Optional — e.g. feat/agent-task"
                data-yaade-worktree-name=""
              />
              {previewHint ? (
                <p className="text-3xs text-muted-foreground">{previewHint}</p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div
          className="max-h-80 overflow-y-auto border-t"
          data-yaade-list-panel="yaade:palette"
          role="listbox"
          aria-label="Agent providers"
        >
          <ul className="flex flex-col p-1">
            {AGENT_CLI_DRIVERS.map(driver => (
              <li key={driver.id}>
                <button
                  type="button"
                  role="option"
                  data-yaade-list-item=""
                  data-yaade-agent-cli-option={driver.id}
                  className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                  onClick={() => pick(driver)}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/50">
                    <AgentProviderIcon agent={driver.id} className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{driver.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {driver.description}
                    </span>
                  </span>
                  <code className="text-xs text-muted-foreground">{driver.command}</code>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  )
}
