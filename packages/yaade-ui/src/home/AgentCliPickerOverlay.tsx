import { FolderOpen, Plus, RefreshCw, Trash2 } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { AgentDriverCapabilities, AgentProvider } from "@yaade/agents"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../components/ui/command.js"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js"
import { Button } from "../components/ui/button.js"
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

export type AgentCliPickerOverlayProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (driver: AgentCliDriver) => void
  /** Workspace projects available for the new session. */
  projects?: AgentCliPickerProject[]
  /** Selected project root URI (required when creating a session). */
  selectedRootUri?: string | null
  onSelectedRootUriChange?: (rootUri: string) => void
  onRemoveProject?: (rootUri: string) => boolean | void | Promise<boolean | void>
  /** Opens the Add project folder modal. */
  onAddProject?: () => void
}

type ProviderAvailability = {
  provider: AgentProvider
  available: boolean
  binary: string
  version: string | null
  capabilities: AgentDriverCapabilities
  error: string | null
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
  const [providers, setProviders] = useState<ProviderAvailability[]>([])
  const [providersLoading, setProvidersLoading] = useState(false)
  const [providersError, setProvidersError] = useState<string | null>(null)
  const refreshProviders = useCallback(async (refresh = false) => {
    const api = window.yaade?.agents
    if (!api) {
      setProvidersError("Provider detection is unavailable")
      return
    }
    setProvidersLoading(true)
    try {
      setProviders(await api.listProviders(refresh))
      setProvidersError(null)
    } catch (error) {
      setProvidersError(error instanceof Error ? error.message : "Could not detect providers")
    } finally {
      setProvidersLoading(false)
    }
  }, [])
  useEffect(() => {
    if (open) void refreshProviders(false)
  }, [open, refreshProviders])
  const providerById = useMemo(
    () => new Map(providers.map(provider => [provider.provider, provider])),
    [providers],
  )
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="picker" className="gap-0 overflow-hidden p-0">
        <DialogHeader className="px-4 pt-4 pb-3">
          <div className="flex items-start justify-between gap-3">
          <DialogTitle>Launch an agent</DialogTitle>
          <Button
            size="xs"
            variant="ghost"
            disabled={providersLoading}
            onClick={() => void refreshProviders(true)}
          >
            <RefreshCw className={providersLoading ? "animate-spin" : undefined} />
            Refresh
          </Button>
          </div>
          <DialogDescription>
            Choose a provider to start in the selected project workspace.
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

        <Command className="rounded-none border-t">
          <CommandInput placeholder="Search providers…" aria-label="Search providers" />
          <CommandList
            className="max-h-80"
            data-yaade-list-panel="yaade:palette"
          >
            <CommandEmpty>No matching agents.</CommandEmpty>
            <CommandGroup heading="Providers">
              {AGENT_CLI_DRIVERS.map(driver => {
                const detected = providerById.get(driver.id)
                const unavailable = detected ? !detected.available : providersLoading
                const capabilityLabels = detected
                  ? Object.entries(detected.capabilities)
                      .filter(([, enabled]) => enabled)
                      .map(([name]) => name.replace(/Lifecycle$/, ""))
                      .slice(0, 3)
                  : []
                return <CommandItem
                  key={driver.id}
                  value={`${driver.label} ${driver.description} ${driver.command}`}
                  onSelect={() => onSelect(driver)}
                  disabled={unavailable}
                  data-yaade-list-item=""
                  data-yaade-agent-provider-available={detected?.available ? "true" : "false"}
                  className="py-3"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/50">
                    <AgentProviderIcon agent={driver.id} className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate font-medium"
                      data-yaade-agent-cli-option={driver.id}
                    >
                      {driver.label}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {detected?.available
                        ? [detected.version, ...capabilityLabels].filter(Boolean).join(" · ") || driver.description
                        : detected?.error ?? (providersLoading ? "Checking availability…" : "CLI not found in PATH")}
                    </span>
                  </span>
                  <code className="text-xs text-muted-foreground">
                    {detected?.available ? detected.binary : "Unavailable"}
                  </code>
                </CommandItem>
              })}
            </CommandGroup>
            {providersError ? (
              <p className="px-3 py-2 text-xs text-destructive">{providersError}</p>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
