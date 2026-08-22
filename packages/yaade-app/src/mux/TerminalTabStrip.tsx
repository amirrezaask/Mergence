import { useRef, useState, type KeyboardEvent } from "react"
import { AnimatePresence } from "motion/react"
import { div as MotionDiv } from "motion/react-m"
import { Plus, Terminal, X } from "lucide-react"
import type { MuxTerminal, MuxTerminalId, SessionId, TerminalKind } from "@yaade/rpc"
import { Button, Input } from "@yaade/ui/primitives"
import { cn, yaadeMotion } from "@yaade/ui/session"
import { muxTerminalWorkTitle, type RuntimeTerminalTitle } from "./terminal-title.js"

export type MuxTerminalNavigationLayout = "tabs" | "two-sidebars" | "single-sidebar"

export type TerminalTabStripProps = {
  readonly terminalIds: readonly MuxTerminalId[]
  readonly terminalsById: ReadonlyMap<MuxTerminalId, MuxTerminal>
  readonly activeMuxTerminalId?: MuxTerminalId
  readonly openMuxTerminalIds?: ReadonlySet<MuxTerminalId>
  readonly runtimeTitles: ReadonlyMap<MuxTerminalId, RuntimeTerminalTitle>
  readonly onSelect: (terminal: MuxTerminal) => void
  readonly onAddKind: (kind: TerminalKind) => void
  readonly onClose: (terminal: MuxTerminal) => void
  readonly onRename: (terminal: MuxTerminal, title: string) => void
  readonly onReorder: (ids: readonly MuxTerminalId[]) => void
  readonly onToggleSidebar?: () => void
  readonly sectionLabel?: string
  readonly emptyLabel?: string
  readonly sessionTitlesById?: ReadonlyMap<SessionId, string>
  readonly dockable?: boolean
  readonly dockableTerminalIds?: ReadonlySet<MuxTerminalId>
  readonly layout?: MuxTerminalNavigationLayout
  readonly collapsed?: boolean
  readonly sidebarOrientation?: "horizontal" | "vertical"
}

function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
  const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')]
  if (tabs.length === 0) return
  const current = Math.max(0, tabs.indexOf(document.activeElement as HTMLElement))
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : (current + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length
  event.preventDefault()
  tabs[next]?.focus()
}

export function TerminalTabStrip(props: TerminalTabStripProps) {
  const [editingId, setEditingId] = useState<MuxTerminalId | null>(null)
  const [draftTitle, setDraftTitle] = useState("")
  const dragId = useRef<MuxTerminalId | null>(null)
  const vertical = props.layout !== "tabs"

  const finishRename = (terminal: MuxTerminal) => {
    const title = draftTitle.trim()
    setEditingId(null)
    if (title && title !== terminal.title) props.onRename(terminal, title)
  }

  return (
    <aside
      className={cn("flex min-h-0", vertical ? "h-full flex-col" : "h-full min-w-0 flex-row items-center")}
      data-yaade-terminal-tabs=""
      data-yaade-terminal-tabs-layout={props.layout ?? "tabs"}
    >
      {props.sectionLabel && !props.collapsed ? (
        <p className="px-2 py-1 text-2xs font-medium text-muted-foreground">{props.sectionLabel}</p>
      ) : null}
      <nav
        className={cn("flex min-h-0 min-w-0 gap-1", vertical ? "flex-1 flex-col overflow-y-auto p-1" : "flex-1 items-center overflow-x-auto")}
        aria-label="Terminals"
        role="tablist"
        aria-orientation={vertical ? "vertical" : "horizontal"}
        onKeyDown={handleKeyDown}
      >
        <AnimatePresence initial={false}>
          {props.terminalIds.map((id, index) => {
            const terminal = props.terminalsById.get(id)
            if (!terminal) return null
            const active = id === props.activeMuxTerminalId
            const title = muxTerminalWorkTitle(terminal, props.runtimeTitles.get(id))
            return (
              <MotionDiv
                key={id}
                layout
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={yaadeMotion.layoutTransition}
                draggable
                onDragStart={() => { dragId.current = id }}
                onDragOver={event => event.preventDefault()}
                onDrop={() => {
                  const source = dragId.current
                  if (!source || source === id) return
                  const next = [...props.terminalIds]
                  const from = next.indexOf(source)
                  next.splice(from, 1)
                  next.splice(index, 0, source)
                  props.onReorder(next)
                }}
                className={cn("group flex min-w-0 items-center rounded-[var(--yaade-control-radius)]", active && "bg-accent text-accent-foreground")}
              >
                {editingId === id ? (
                  <Input
                    value={draftTitle}
                    onChange={event => setDraftTitle(event.target.value)}
                    onBlur={() => finishRename(terminal)}
                    onKeyDown={event => {
                      if (event.key === "Enter") finishRename(terminal)
                      if (event.key === "Escape") setEditingId(null)
                    }}
                    autoFocus
                    className="h-7 min-w-24"
                  />
                ) : (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs"
                    onClick={() => props.onSelect(terminal)}
                    onDoubleClick={() => { setDraftTitle(terminal.title); setEditingId(id) }}
                  >
                    <Terminal className="size-3.5 shrink-0" aria-hidden />
                    {!props.collapsed ? <span className="truncate">{title}</span> : null}
                  </button>
                )}
                {!props.collapsed ? (
                  <Button type="button" size="icon-xs" variant="ghost" aria-label={`Close ${title}`} onClick={() => props.onClose(terminal)}>
                    <X />
                  </Button>
                ) : null}
              </MotionDiv>
            )
          })}
        </AnimatePresence>
        {props.terminalIds.length === 0 && !props.collapsed ? (
          <p className="p-2 text-xs text-muted-foreground">{props.emptyLabel ?? "No terminals"}</p>
        ) : null}
      </nav>
      <Button type="button" size="icon-xs" variant="ghost" aria-label="New terminal" onClick={() => props.onAddKind("terminal")}>
        <Plus />
      </Button>
    </aside>
  )
}
