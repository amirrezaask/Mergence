import { useState } from "react"
import {
  Check,
  ChevronsUpDownIcon,
  FolderKanban,
  X,
} from "lucide-react"
import type { AppSession, SessionId } from "@yaade/rpc"
import { cn, formatKeyBinding } from "@yaade/ui"
import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@yaade/ui/primitives"
import { toolSessionShortcutFor } from "./tool-session-keymap.js"

export type SessionSwitcherProps = {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly sessions: readonly AppSession[]
  readonly activeSessionId?: AppSession["id"]
  readonly onSelect: (session: AppSession) => void
  readonly onClose?: (id: SessionId) => void
  readonly onRename?: (id: SessionId, title: string) => void
  readonly toolCounts?: ReadonlyMap<SessionId, number>
}

export function SessionSwitcher(props: SessionSwitcherProps) {
  const [editingId, setEditingId] = useState<SessionId | null>(null)
  const [draftTitle, setDraftTitle] = useState("")
  const activeSession = props.sessions.find(
    session => session.id === props.activeSessionId,
  )
  const switchShortcut = toolSessionShortcutFor("session.switch")

  const finishRename = (session: AppSession) => {
    const next = draftTitle.trim()
    setEditingId(null)
    if (next && next !== session.title) props.onRename?.(session.id, next)
  }

  const selectSession = (session: AppSession) => {
    setEditingId(null)
    props.onSelect(session)
    props.onOpenChange(false)
  }

  return (
    <Popover
      open={props.open}
      onOpenChange={props.onOpenChange}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Switch session${activeSession ? `, current ${activeSession.title}` : ""}`}
          aria-haspopup="dialog"
          data-yaade-session-switcher=""
          data-yaade-active-session={activeSession?.id}
          title={switchShortcut ? `Switch session (${formatKeyBinding(switchShortcut)})` : "Switch session"}
          className="h-9 min-w-0 max-w-64 shrink-0 justify-start gap-2 rounded-md px-2 text-left hover:bg-accent/70"
        >
          <span
            className="grid size-6 shrink-0 place-items-center rounded-md border border-border/70 bg-secondary/80 text-muted-foreground"
            aria-hidden
          >
            <FolderKanban className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-semibold tracking-[-0.01em]">
            {activeSession?.title ?? "Choose session"}
          </span>
          <ChevronsUpDownIcon
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={8}
        className="w-80 overflow-hidden p-1.5"
        data-yaade-session-switcher-popover=""
      >
        <div
          className="flex max-h-[min(22rem,calc(100dvh-12rem))] flex-col gap-0.5 overflow-y-auto"
          role="listbox"
          aria-label="Sessions"
        >
          {props.sessions.length === 0 ? (
            <p className="px-2.5 py-4 text-xs text-muted-foreground">
              No active sessions.
            </p>
          ) : (
            props.sessions.map(session => {
              const active = session.id === props.activeSessionId
              const editing = editingId === session.id
              const count = props.toolCounts?.get(session.id) ?? 0
              return (
                <div
                  key={session.id}
                  className="group flex min-w-0 items-center gap-1 rounded-md"
                >
                  {editing ? (
                    <Input
                      aria-label={`Rename ${session.title}`}
                      autoFocus
                      value={draftTitle}
                      onChange={event => setDraftTitle(event.target.value)}
                      onBlur={() => finishRename(session)}
                      onKeyDown={event => {
                        event.stopPropagation()
                        if (event.key === "Enter") finishRename(session)
                        if (event.key === "Escape") setEditingId(null)
                      }}
                      className="h-8 min-w-0 flex-1 bg-background px-2"
                    />
                  ) : (
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      data-yaade-session={session.id}
                      data-active={active ? "true" : undefined}
                      className={cn(
                        "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left outline-none transition-[background-color,color] duration-[var(--yaade-motion-hot)] hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring/60",
                        active && "bg-accent text-accent-foreground",
                      )}
                      onClick={() => selectSession(session)}
                      onDoubleClick={() => {
                        if (!props.onRename) return
                        setDraftTitle(session.title)
                        setEditingId(session.id)
                      }}
                    >
                      <span
                        className={cn(
                          "grid size-4 shrink-0 place-items-center text-muted-foreground",
                          active && "text-primary",
                        )}
                        aria-hidden
                      >
                        {active ? <Check className="size-3.5" /> : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">
                        {session.title}
                      </span>
                      {count > 0 ? (
                        <span className="shrink-0 font-mono text-3xs tabular-nums text-muted-foreground">
                          {count}
                        </span>
                      ) : null}
                    </button>
                  )}
                  {props.onClose ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Close ${session.title}`}
                      className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                      onClick={() => props.onClose?.(session.id)}
                    >
                      <X />
                    </Button>
                  ) : null}
                </div>
              )
            })
          )}

        </div>

      </PopoverContent>
    </Popover>
  )
}
