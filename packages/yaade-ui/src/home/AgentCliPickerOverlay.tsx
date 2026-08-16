import { Check, ChevronDown, FolderOpen, Plus, Trash2 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import type { GitWorktree } from "@yaade/shared"
import { pathToFileUri } from "@yaade/shared"
import { cn } from "@yaade/ui/project"
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@yaade/ui/primitives"
import {
  AGENT_CLI_DRIVERS,
  type AgentCliDriver,
} from "./agent-cli-drivers.js"
import { AgentProviderIcon } from "./AgentProviderIcon.js"

export type AgentCliPickerProject = {
  rootUri: string
  name: string
  path: string
}

const EMPTY_PROJECTS: readonly AgentCliPickerProject[] = []

export type AgentCliLaunchSelection = {
  driver: AgentCliDriver
  /** When true, create a fresh git worktree for the launch. */
  useWorktree: boolean
  /** Optional branch / worktree name when creating. Empty → host generates one. */
  worktreeName: string
  checkoutPath?: string
  checkoutKey?: string
  checkoutLabel?: string
}

export type AgentCliPickerOverlayProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (selection: AgentCliLaunchSelection) => void
  /** Workspace projects available for the new session. */
  projects?: readonly AgentCliPickerProject[]
  /** Selected project root URI (required when creating a session). */
  selectedRootUri?: string | null
  onSelectedRootUriChange?: (rootUri: string) => void
  onRemoveProject?: (rootUri: string) => boolean | void | Promise<boolean | void>
  /** Opens the Add project folder modal. */
  onAddProject?: () => void
  /** Absolute project path for listing existing worktrees. */
  projectPath?: string
  homeDir?: string
  defaultBranch?: string
}

function checkoutPathKey(p: string): string {
  return p.replace(/\/+$/, "").replace(/^\/private(\/var\/)/, "$1")
}

function sameCheckoutPath(a: string, b: string): boolean {
  return checkoutPathKey(a) === checkoutPathKey(b)
}

function branchLabel(wt: GitWorktree): string {
  if (wt.branch) return wt.branch.replace(/^refs\/heads\//, "")
  if (wt.detached && wt.head) return `detached@${wt.head.slice(0, 7)}`
  return wt.path.split("/").filter(Boolean).pop() ?? wt.path
}

const CREATE_VALUE = "__create__"
const MAIN_VALUE = "__main__"

export function AgentCliPickerOverlay({
  open,
  onOpenChange,
  onSelect,
  projects = EMPTY_PROJECTS,
  selectedRootUri = null,
  onSelectedRootUriChange,
  onRemoveProject,
  onAddProject,
  projectPath,
}: AgentCliPickerOverlayProps) {
  const [agentOpen, setAgentOpen] = useState(false)
  const [agentId, setAgentId] = useState<AgentCliDriver["id"]>(
    AGENT_CLI_DRIVERS[0].id,
  )
  const [checkoutValue, setCheckoutValue] = useState(MAIN_VALUE)
  const [worktreeName, setWorktreeName] = useState("")
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])

  const selectedProject =
    projects.find(project => project.rootUri === selectedRootUri) ?? projects[0]
  const showProjectControl = projects.length > 0 || onAddProject != null
  const resolvedProjectPath = projectPath ?? selectedProject?.path ?? ""

  useEffect(() => {
    if (!open) return
    setAgentOpen(false)
    setAgentId(AGENT_CLI_DRIVERS[0].id)
    setCheckoutValue(MAIN_VALUE)
    setWorktreeName("")
  }, [open])

  useEffect(() => {
    if (!open || !resolvedProjectPath) {
      setWorktrees([])
      return
    }
    let cancelled = false
    const rootUri = pathToFileUri(resolvedProjectPath)
    void window.yaade?.git
      ?.isRepo(rootUri)
      .then(isRepo =>
        isRepo ? window.yaade?.git?.worktreeList(rootUri) ?? [] : [],
      )
      .then(rows => {
        if (cancelled) return
        setWorktrees(
          rows.filter(
            wt =>
              !wt.bare &&
              !wt.prunable &&
              !sameCheckoutPath(wt.path, resolvedProjectPath),
          ),
        )
      })
      .catch(() => {
        if (!cancelled) setWorktrees([])
      })
    return () => {
      cancelled = true
    }
  }, [open, resolvedProjectPath])

  const removeSelectedProject = async () => {
    if (!selectedProject || !onRemoveProject) return
    const removed = await onRemoveProject(selectedProject.rootUri)
    if (removed === false) return
    const next = projects.find(project => project.rootUri !== selectedProject.rootUri)
    if (next) onSelectedRootUriChange?.(next.rootUri)
  }

  const selectedDriver =
    AGENT_CLI_DRIVERS.find(driver => driver.id === agentId) ??
    AGENT_CLI_DRIVERS[0]

  const pick = () => {
    if (checkoutValue === CREATE_VALUE) {
      onSelect({
        driver: selectedDriver,
        useWorktree: true,
        worktreeName: worktreeName.trim(),
      })
      return
    }
    if (checkoutValue === MAIN_VALUE || !resolvedProjectPath) {
      onSelect({
        driver: selectedDriver,
        useWorktree: false,
        worktreeName: "",
        checkoutPath: resolvedProjectPath || undefined,
        checkoutKey: "main",
        checkoutLabel: "Main",
      })
      return
    }
    const wt = worktrees.find(item => item.path === checkoutValue)
    const label = wt ? branchLabel(wt) : checkoutValue
    onSelect({
      driver: selectedDriver,
      useWorktree: false,
      worktreeName: "",
      checkoutPath: checkoutValue,
      checkoutKey: checkoutValue,
      checkoutLabel: label,
    })
  }

  const previewHint = useMemo(() => {
    if (checkoutValue !== CREATE_VALUE) return null
    if (worktreeName.trim()) return `Worktree branch: ${worktreeName.trim()}`
    return "Worktree name will be generated on launch"
  }, [checkoutValue, worktreeName])

  const pickerContent = (
    <>
        <DialogHeader className="px-4 pt-4 pb-3">
          <DialogTitle>Launch an agent</DialogTitle>
        </DialogHeader>

        {showProjectControl ? (
          <div
            className="flex items-end gap-2 border-t px-4 py-3"
            data-yaade-agent-cli-project-picker=""
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
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

        {resolvedProjectPath ? (
          <div
            className="grid grid-cols-2 gap-3 border-t px-4 py-3"
            data-yaade-agent-cli-worktree=""
          >
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor="agent-provider">Agent</Label>
              <Popover open={agentOpen} onOpenChange={setAgentOpen}>
                <PopoverTrigger asChild>
                  <Button
                    id="agent-provider"
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={agentOpen}
                    className="w-full justify-between font-normal"
                    data-yaade-agent-cli-combobox=""
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <AgentProviderIcon
                        agent={selectedDriver.id}
                        className="size-4"
                      />
                      <span className="truncate">{selectedDriver.label}</span>
                    </span>
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-[var(--radix-popover-trigger-width)] p-0"
                >
                  <Command>
                    <CommandInput
                      placeholder="Search providers…"
                      aria-label="Search providers"
                    />
                    <CommandList>
                      <CommandEmpty>No providers found.</CommandEmpty>
                      <CommandGroup>
                        {AGENT_CLI_DRIVERS.map(driver => (
                          <CommandItem
                            key={driver.id}
                            value={`${driver.label} ${driver.description} ${driver.command}`}
                            data-yaade-agent-cli-option={driver.id}
                            onSelect={() => {
                              setAgentId(driver.id)
                              setAgentOpen(false)
                            }}
                            className="gap-3 py-2.5"
                          >
                            <Check
                              className={cn(
                                "size-4 shrink-0",
                                driver.id === selectedDriver.id
                                  ? "opacity-100"
                                  : "opacity-0",
                              )}
                            />
                            <span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-muted/50">
                              <AgentProviderIcon
                                agent={driver.id}
                                className="size-4"
                              />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">
                                {driver.label}
                              </span>
                              <span className="block truncate text-3xs text-muted-foreground">
                                {driver.description}
                              </span>
                            </span>
                            <code className="text-3xs text-muted-foreground">
                              {driver.command}
                            </code>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor="agent-checkout">Worktree</Label>
              <Select value={checkoutValue} onValueChange={setCheckoutValue}>
                <SelectTrigger
                  id="agent-checkout"
                  className="w-full"
                  data-yaade-agent-checkout=""
                >
                  <SelectValue placeholder="Main" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={MAIN_VALUE} data-yaade-worktree-main="">
                    Main
                  </SelectItem>
                  {worktrees.map(wt => (
                    <SelectItem
                      key={wt.path}
                      value={wt.path}
                      data-yaade-worktree-item={branchLabel(wt)}
                    >
                      {branchLabel(wt)}
                    </SelectItem>
                  ))}
                  <SelectItem value={CREATE_VALUE} data-yaade-worktree-create="">
                    Create worktree…
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {checkoutValue === CREATE_VALUE ? (
              <div className="col-span-2 grid gap-1.5">
                <Label htmlFor="agent-worktree-name">Worktree name</Label>
                <Input
                  id="agent-worktree-name"
                  value={worktreeName}
                  onChange={event => setWorktreeName(event.target.value)}
                  placeholder="Optional — e.g. feat/agent-task"
                  data-yaade-worktree-name=""
                  data-yaade-use-worktree=""
                />
                {previewHint ? (
                  <p className="text-3xs text-muted-foreground">{previewHint}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={pick} data-yaade-agent-cli-launch="">
            Launch {selectedDriver.label}
          </Button>
        </div>
    </>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="picker" className="gap-0 overflow-hidden p-0">
        {pickerContent}
      </DialogContent>
    </Dialog>
  )
}
