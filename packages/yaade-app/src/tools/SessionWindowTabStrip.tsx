import { useRef, useState, type KeyboardEvent } from "react"
import { AnimatePresence, LayoutGroup } from "motion/react"
import { div as MotionDiv } from "motion/react-m"
import { Plus, X } from "lucide-react"
import type { SessionTab, SessionTabId, ToolKind } from "@yaade/rpc"
import { Button, Input } from "@yaade/ui/primitives"
import {
  AgentProviderIcon,
  cn,
  deckTileStyle,
  processIdentity,
  yaadeMotion,
} from "@yaade/ui/session"
import { ShortcutTooltip } from "./ShortcutTooltip.js"
import { toolSessionShortcutFor } from "./tool-session-keymap.js"

export type WindowTabMeta = {
  readonly kind: ToolKind
  readonly processName?: string | null
  readonly agentProvider?: string | null
}

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

function WindowTabProcessTile(props: {
  readonly kind: ToolKind
  readonly processName?: string | null
  readonly agentProvider?: string | null
}) {
  if (props.kind === "terminal") {
    return (
      <AgentProviderIcon
        agent={props.agentProvider ?? "terminal"}
        className="size-4 shrink-0"
      />
    )
  }
  const identity = processIdentity(props.processName ?? props.kind)
  const isShell = identity.glyph === ">_"
  if (isShell) {
    return (
      <span
        className="grid size-4 shrink-0 place-items-center font-mono text-3xs font-semibold text-muted-foreground"
        aria-hidden
      >
        {identity.glyph}
      </span>
    )
  }
  const tile = deckTileStyle(identity)
  return (
    <span
      className="grid size-4 shrink-0 place-items-center rounded-sm font-mono text-3xs font-semibold"
      style={{ backgroundColor: tile.backgroundColor, color: tile.color }}
      aria-hidden
    >
      {identity.glyph}
    </span>
  )
}

export type SessionWindowTabStripProps = {
  readonly tabs: readonly SessionTab[]
  readonly activeTabId?: SessionTabId
  readonly tabMeta?: ReadonlyMap<SessionTabId, WindowTabMeta>
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

  const startRename = (tab: SessionTab) => {
    setDraftTitle(tab.title)
    setEditingId(tab.id)
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
    <div
      className="flex h-[var(--yaade-tab-bar-height)] min-w-0 flex-1 items-center px-0"
      data-yaade-window-tabs=""
    >
      <LayoutGroup id="yaade-window-tabs">
        <nav
          className="flex h-full min-w-0 items-center gap-1.5 overflow-x-auto"
          aria-label="Session tabs"
          role="tablist"
          onKeyDown={handleWindowTabKeyDown}
        >
        <AnimatePresence initial={false} mode="popLayout">
          {props.tabs.map((tab, index) => {
            const active = tab.id === props.activeTabId
            const editing = editingId === tab.id
            const meta = props.tabMeta?.get(tab.id)
            const kind = meta?.kind ?? "terminal"
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
                    startRename(tab)
                  }}
                  onKeyDown={event => {
                    if (editing) return
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      props.onSelect(tab)
                    }
                  }}
                  className={cn(
                    "group relative isolate flex h-[var(--yaade-tab-pill-height)] min-w-20 max-w-56 cursor-pointer items-center gap-1.5 px-2 outline-none transition-[color,background-color] duration-[var(--yaade-motion-hot)] focus-visible:ring-2 focus-visible:ring-ring/50",
                    active ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {active ? (
                    <MotionDiv
                      layoutId="yaade-window-tab-pill"
                      className="pointer-events-none absolute inset-0 -z-10"
                      data-yaade-window-tab-pill=""
                      transition={yaadeMotion.layoutTransition}
                    />
                  ) : null}
                  <WindowTabProcessTile
                    kind={kind}
                    processName={meta?.processName}
                    agentProvider={meta?.agentProvider}
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
                    className="size-5 shrink-0 text-muted-foreground"
                    onClick={event => {
                      event.stopPropagation()
                      props.onClose(tab)
                    }}
                    onPointerDown={event => event.stopPropagation()}
                  >
                    <X />
                  </Button>
                </div>
              </MotionDiv>
            )
          })}
        </AnimatePresence>
        </nav>
      </LayoutGroup>
      <ShortcutTooltip label="New tab" shortcut={newTabShortcut} side="bottom">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="New tab"
          data-yaade-new-session-tab=""
          className="size-[var(--yaade-tab-pill-height)]"
          onClick={props.onCreate}
        >
          <Plus />
        </Button>
      </ShortcutTooltip>
    </div>
  )
}
