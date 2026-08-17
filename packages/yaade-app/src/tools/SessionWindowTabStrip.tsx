import { useRef, useState, type KeyboardEvent } from "react"
import { AnimatePresence } from "motion/react"
import { div as MotionDiv } from "motion/react-m"
import { PanelTop, Plus, X } from "lucide-react"
import type { SessionTab, SessionTabId } from "@yaade/rpc"
import { Button, Input } from "@yaade/ui/primitives"
import { GlassSurface, cn, yaadeMotion } from "@yaade/ui"
import { ShortcutTooltip } from "./ShortcutTooltip.js"
import { toolSessionShortcutFor } from "./tool-session-keymap.js"

function handleWindowTabKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
  const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')]
  if (tabs.length === 0) return
  const activeElement = document.activeElement
  const current = Math.max(
    0,
    activeElement instanceof HTMLElement ? tabs.indexOf(activeElement) : -1,
  )
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
  event.preventDefault()
  tabs[next]?.focus()
  tabs[next]?.click()
}

export type SessionWindowTabStripProps = {
  readonly tabs: readonly SessionTab[]
  readonly activeTabId?: SessionTabId
  readonly onSelect: (tab: SessionTab) => void
  readonly onCreate: () => void
  readonly onClose: (tab: SessionTab) => void
  readonly onRename: (id: SessionTabId, title: string) => void
  readonly onReorder: (ids: readonly SessionTabId[]) => void
}

export function SessionWindowTabStrip(props: SessionWindowTabStripProps) {
  const dragId = useRef<SessionTabId | null>(null)
  const [editingId, setEditingId] = useState<SessionTabId | null>(null)
  const [draftTitle, setDraftTitle] = useState("")
  const newTabShortcut = toolSessionShortcutFor("tab.new")

  const finishRename = (tab: SessionTab) => {
    const title = draftTitle.trim()
    setEditingId(null)
    if (title && title !== tab.title) props.onRename(tab.id, title)
  }

  const moveTab = (tabId: SessionTabId, index: number) => {
    const from = dragId.current
    dragId.current = null
    if (!from || from === tabId) return
    const ids = props.tabs.map(tab => tab.id)
    const fromIndex = ids.indexOf(from)
    if (fromIndex < 0) return
    ids.splice(fromIndex, 1)
    ids.splice(index, 0, from)
    props.onReorder(ids)
  }

  return (
    <GlassSurface material="chrome" asChild>
    <div
      className="flex h-8 min-w-0 shrink-0 items-center border-b border-border/50 bg-transparent px-0"
      data-yaade-window-tabs=""
    >
      <nav
        className="flex h-full min-w-0 flex-1 items-stretch gap-0 overflow-x-auto"
        aria-label="Session tabs"
        role="tablist"
        onKeyDown={handleWindowTabKeyDown}
      >
        <AnimatePresence initial={false} mode="popLayout">
          {props.tabs.map((tab, index) => {
            const active = tab.id === props.activeTabId
            const editing = editingId === tab.id
            return (
              <MotionDiv
                key={tab.id}
                layout
                initial={{ opacity: 0, scale: 0.97, y: 3 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, y: -3 }}
                transition={{ layout: yaadeMotion.layoutTransition, default: yaadeMotion.layoutTransition }}
                className="flex h-full min-w-0 shrink-0 items-center"
              >
                <div
                  role="tab"
                  tabIndex={active ? 0 : -1}
                  aria-selected={active}
                  aria-label={tab.title}
                  data-yaade-session-tab={tab.id}
                  data-active={active ? "true" : undefined}
                  draggable={!editing}
                  onDragStart={() => { dragId.current = tab.id }}
                  onDragOver={event => event.preventDefault()}
                  onDrop={() => moveTab(tab.id, index)}
                  onClick={() => { if (!editing) props.onSelect(tab) }}
                  onDoubleClick={() => {
                    if (editing) return
                    setDraftTitle(tab.title)
                    setEditingId(tab.id)
                  }}
                  onKeyDown={event => {
                    if (editing) return
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      props.onSelect(tab)
                    }
                  }}
                  className={cn(
                    "group relative flex h-full min-w-20 max-w-48 cursor-pointer items-center gap-1 rounded-md px-1.5 outline-none transition-[color,background-color,border-color,box-shadow,transform] duration-[var(--yaade-motion-hot)] hover:bg-accent/45 focus-visible:ring-2 focus-visible:ring-ring/50",
                    active && "text-foreground",
                  )}
                >
                  <PanelTop
                    className={cn(
                      "size-3 shrink-0",
                      active ? "text-primary" : "text-muted-foreground/70",
                    )}
                    aria-hidden
                  />
                  {editing ? (
                    <Input
                      aria-label={`Rename ${tab.title}`}
                      autoFocus
                      value={draftTitle}
                      className="h-5 min-w-0 flex-1 bg-background px-1"
                      onClick={event => event.stopPropagation()}
                      onChange={event => setDraftTitle(event.target.value)}
                      onBlur={() => finishRename(tab)}
                      onKeyDown={event => {
                        event.stopPropagation()
                        if (event.key === "Enter") finishRename(tab)
                        if (event.key === "Escape") setEditingId(null)
                      }}
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {tab.title}
                    </span>
                  )}
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Close ${tab.title}`}
                    className="shrink-0 opacity-0 group-hover:opacity-70 group-focus-within:opacity-70"
                    onClick={event => {
                      event.stopPropagation()
                      props.onClose(tab)
                    }}
                  >
                    <X />
                  </Button>
                </div>
              </MotionDiv>
            )
          })}
        </AnimatePresence>
      </nav>
      <ShortcutTooltip label="New tab" shortcut={newTabShortcut} side="bottom">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="New tab"
          data-yaade-new-session-tab=""
          onClick={props.onCreate}
        >
          <Plus />
        </Button>
      </ShortcutTooltip>
    </div>
    </GlassSurface>
  )
}
