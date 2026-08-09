import { useMemo, useState } from "react"
import type { HqAgentSummary } from "@yaade/rpc"
import { cn } from "@yaade/ui/project"
import {
  Badge,
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@yaade/ui/primitives"
import { Bot, CheckIcon, ChevronDownIcon } from "lucide-react"
import { sortHqAgents } from "../hq/hq-model.js"

export type AgentSwitcherProps = {
  agents: readonly HqAgentSummary[]
  loading?: boolean
  error?: string | null
  active?: boolean
  activeAgentTabId?: string | null
  activeLabel?: string | null
  onSelectAgent: (agent: HqAgentSummary) => void | Promise<void>
  onLaunchAgent?: () => void
  onIntent?: () => void
  onOpenChange?: (open: boolean) => void
  /** Render as the compact selector beside semantic project tabs. */
  contextual?: boolean
}

function statusLabel(agent: HqAgentSummary): string {
  if (agent.telemetry === "pending") return "Connecting"
  if (agent.telemetry === "degraded") return "Limited telemetry"
  if (agent.telemetry === "process_only") return "Running"
  return agent.status.replaceAll("_", " ")
}

export function AgentSwitcher({
  agents,
  loading = false,
  error = null,
  active = false,
  activeAgentTabId = null,
  activeLabel = null,
  onSelectAgent,
  onLaunchAgent,
  onIntent,
  onOpenChange,
  contextual = false,
}: AgentSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [highlight, setHighlight] = useState("")

  const sorted = useMemo(() => sortHqAgents(agents), [agents])

  const setOpenState = (next: boolean) => {
    if (next) onIntent?.()
    setOpen(next)
    onOpenChange?.(next)
    if (!next) setHighlight("")
  }

  const select = async (agent: HqAgentSummary) => {
    setBusy(true)
    try {
      await onSelectAgent(agent)
      setOpenState(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpenState}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-yaade-agent-switcher=""
          data-yaade-project-tab={contextual ? undefined : "agents"}
          data-yaade-context-selector={contextual ? "agents" : undefined}
          aria-label={contextual ? "Select agent" : "Agents"}
          aria-expanded={open}
          disabled={busy}
          onPointerEnter={onIntent}
          onFocus={onIntent}
          className={cn(
            "relative gap-1 border border-transparent text-xs text-muted-foreground hover:text-foreground",
            contextual
              ? "h-7 max-w-56 bg-secondary/60 px-2 text-foreground"
              : "h-[calc(100%-1px)] gap-0.5 px-1.5 py-0 after:absolute after:inset-x-0 after:bottom-0.5 after:h-0.5 after:bg-foreground after:opacity-0 after:transition-opacity",
            (open || active) && "text-foreground",
            active && !contextual && "after:opacity-100",
          )}
        >
          <Bot className="size-3.5" aria-hidden />
          <span className="truncate">
            {contextual ? (activeLabel ?? "Select agent") : "Agents"}
          </span>
          {!contextual && active && activeLabel ? (
            <span className="hidden max-w-[7rem] truncate font-normal text-foreground/80 sm:inline">
              · {activeLabel}
            </span>
          ) : sorted.length > 0 ? (
            <Badge
              variant="secondary"
              className="h-4 min-w-4 px-1 text-4xs font-normal"
            >
              {sorted.length}
            </Badge>
          ) : null}
          <ChevronDownIcon className="size-2.5 opacity-70" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-0"
        data-yaade-agent-switcher-menu=""
        onOpenAutoFocus={e => {
          e.preventDefault()
          const root = e.currentTarget as HTMLElement
          root
            .querySelector<HTMLInputElement>("[data-yaade-agent-switcher-search]")
            ?.focus()
        }}
        onCloseAutoFocus={e => e.preventDefault()}
      >
        <Command
          value={highlight}
          onValueChange={setHighlight}
          className="rounded-md"
        >
          <CommandInput
            placeholder="Filter agents…"
            aria-label="Filter agents"
            data-yaade-agent-switcher-search=""
          />
          <CommandList className="max-h-72">
            {loading ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                Loading…
              </div>
            ) : error ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                {error}
              </div>
            ) : (
              <>
                <CommandEmpty className="py-3 text-xs">
                  No running agents
                </CommandEmpty>
                {sorted.length > 0 ? (
                  <CommandGroup heading="Running">
                    {sorted.map(agent => {
                      const selected = activeAgentTabId === agent.sessionId
                      return (
                        <CommandItem
                          key={`${agent.sessionId}:${agent.ptyId}`}
                          value={`${agent.title} ${agent.provider} ${agent.worktreeBranch ?? ""} ${agent.projectSessionTitle}`}
                          data-yaade-agent-item={agent.sessionId}
                          disabled={busy}
                          onSelect={() => void select(agent)}
                          className="gap-2"
                        >
                          <CheckIcon
                            className={cn(
                              "size-3.5 shrink-0",
                              selected ? "opacity-100" : "opacity-0",
                            )}
                          />
                          <Bot className="size-3.5 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <span className="block truncate text-sm">
                              {agent.title}
                            </span>
                            <span className="block truncate text-3xs text-muted-foreground">
                              {agent.provider}
                              {agent.worktreeBranch
                                ? ` · ${agent.worktreeBranch}`
                                : ""}
                              {" · "}
                              {statusLabel(agent)}
                            </span>
                          </div>
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                ) : null}
                {onLaunchAgent ? (
                  <CommandGroup>
                    <CommandItem
                      value="launch agent"
                      data-yaade-agent-launch=""
                      disabled={busy}
                      onSelect={() => {
                        setOpenState(false)
                        onLaunchAgent()
                      }}
                      className="gap-2"
                    >
                      <Bot className="size-3.5 shrink-0" />
                      <span>Launch agent…</span>
                    </CommandItem>
                  </CommandGroup>
                ) : null}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
