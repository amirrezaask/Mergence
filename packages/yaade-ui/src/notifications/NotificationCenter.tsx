import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { AppNotification } from "@yaade/shared"
import { Bell, CheckCheck, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button.js"
import { Input } from "@/components/ui/input.js"
import { ScrollArea } from "@/components/ui/scroll-area.js"
import { groupNotificationsByTime } from "./group-by-time.js"
import { NotificationItem } from "./NotificationItem.js"

export type NotificationCenterProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: AppNotification[]
  query: string
  onQueryChange: (query: string) => void
  loading?: boolean
  error?: string | null
  onMarkAllRead: () => void
  onRefresh?: () => void
  isSessionAvailable?: (sessionId: string) => boolean
  onOpenNotification: (n: AppNotification) => void
  onMarkRead: (id: string) => void
  onMarkUnread: (id: string) => void
  onDismiss: (id: string) => void
  onAcknowledge?: (id: string) => void
  selectedId?: string | null
  onSelectedIdChange?: (id: string | null) => void
}

/**
 * Body-portaled drawer — not Radix Sheet/Dialog.
 * Session stage is already a modal Dialog; a nested Dialog sheet opens then
 * immediately dismisses (or stays inert under the stage). Plain portal + z-[60]
 * stacks above the stage reliably.
 */
export function NotificationCenter(props: NotificationCenterProps) {
  const {
    open,
    onOpenChange,
    items,
    query,
    onQueryChange,
    loading,
    error,
    onMarkAllRead,
    isSessionAvailable,
    onOpenNotification,
    onMarkRead,
    onMarkUnread,
    onDismiss,
    onAcknowledge,
    selectedId,
    onSelectedIdChange,
  } = props

  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const [localSelected, setLocalSelected] = useState<string | null>(null)
  const activeSelected = selectedId ?? localSelected
  const setSelected = useCallback(
    (id: string | null) => {
      onSelectedIdChange?.(id)
      setLocalSelected(id)
    },
    [onSelectedIdChange],
  )

  const groups = useMemo(() => groupNotificationsByTime(items), [items])
  const flatIds = useMemo(() => items.map(i => i.id), [items])

  useEffect(() => {
    if (!open) return
    if (activeSelected && flatIds.includes(activeSelected)) return
    setSelected(flatIds[0] ?? null)
  }, [activeSelected, flatIds, open, setSelected])

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  // Session stage Dialog (Radix modal) marks other body portals inert/aria-hidden.
  // Keep this layer interactive and visible while open.
  useEffect(() => {
    if (!open) return
    const layer = document.querySelector<HTMLElement>(
      "[data-yaade-notification-layer]",
    )
    if (!layer) return
    const unlock = () => {
      if (layer.getAttribute("aria-hidden") != null) {
        layer.removeAttribute("aria-hidden")
      }
      if (layer.getAttribute("data-aria-hidden") != null) {
        layer.removeAttribute("data-aria-hidden")
      }
      if (layer.inert) layer.inert = false
    }
    unlock()
    const observer = new MutationObserver(unlock)
    observer.observe(layer, {
      attributes: true,
      attributeFilter: ["aria-hidden", "data-aria-hidden", "inert"],
    })
    return () => observer.disconnect()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        onOpenChange(false)
        return
      }
      if (!flatIds.length) return
      const idx = activeSelected ? flatIds.indexOf(activeSelected) : -1
      if (e.key === "ArrowDown") {
        e.preventDefault()
        const next = flatIds[Math.min(flatIds.length - 1, Math.max(0, idx + 1))]
        if (next) setSelected(next)
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        const prev = flatIds[Math.max(0, idx - 1)]
        if (prev) setSelected(prev)
      } else if (e.key === "Enter" && activeSelected) {
        e.preventDefault()
        const n = items.find(i => i.id === activeSelected)
        if (n) onOpenNotification(n)
      } else if ((e.key === "r" || e.key === "R") && activeSelected && !e.metaKey && !e.ctrlKey) {
        const n = items.find(i => i.id === activeSelected)
        if (!n) return
        e.preventDefault()
        if (n.status === "unread") onMarkRead(n.id)
        else onMarkUnread(n.id)
      } else if ((e.key === "d" || e.key === "D") && activeSelected && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        onDismiss(activeSelected)
      }
    }
    // Capture so session Dialog Escape handler cannot swallow close.
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [
    open,
    flatIds,
    activeSelected,
    items,
    onOpenChange,
    onOpenNotification,
    onMarkRead,
    onMarkUnread,
    onDismiss,
    setSelected,
  ])

  if (!open || typeof document === "undefined") return null

  return createPortal(
    <div
      data-yaade-notification-layer
      className="pointer-events-none fixed inset-0 z-[100]"
    >
      <button
        type="button"
        data-yaade-notification-overlay
        aria-label="Dismiss notification center"
        className="pointer-events-auto absolute inset-0 bg-black/50"
        onClick={() => onOpenChange(false)}
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Notification center"
        data-yaade-notification-center
        data-state="open"
        // z above session Dialog; pointer-events auto beats Radix body lock.
        // Liquid-glass stays on the INNER shell — its `position: relative` must
        // not override this drawer's absolute right dock.
        className="pointer-events-auto absolute inset-y-0 right-0 z-[1] flex h-full w-full max-w-md flex-col border-l bg-background shadow-lg"
        onClick={e => e.stopPropagation()}
      >
        <div
          className="flex h-full min-h-0 w-full flex-col gap-0 bg-background"
        >
          <h2 className="sr-only">Notification center</h2>
          <div
            className="flex shrink-0 flex-col gap-1.5 border-b bg-card px-3 py-2 text-left"
          >
            <div className="flex items-center gap-2">
              <Input
                ref={searchRef}
                data-yaade-notification-search
                value={query}
                onChange={e => onQueryChange(e.target.value)}
                placeholder="Search notifications…"
                className="h-8 min-w-0 flex-1 text-xs"
                aria-label="Search notifications"
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 shrink-0 gap-1 px-2 text-3xs"
                data-yaade-notification-mark-all-read
                onClick={onMarkAllRead}
              >
                <CheckCheck className="size-3.5" />
                Mark all as read
              </Button>
            </div>
          </div>

          <div className="relative min-h-0 flex-1">
            {error ? (
              <p
                data-yaade-notification-error
                className="border-b border-border/50 bg-destructive/10 px-3 py-1.5 text-3xs text-destructive"
                role="status"
              >
                {error}
              </p>
            ) : null}
            <ScrollArea className="h-[calc(100vh-4.5rem)]">
              <div
                ref={listRef}
                role="listbox"
                aria-label="Unread notifications"
                data-yaade-notification-list
                className="flex flex-col gap-3 px-2 py-2"
              >
                {loading && items.length === 0 ? (
                  <div className="flex items-center justify-center gap-2 py-10 text-3xs text-muted-foreground">
                    <LoaderCircle className="size-3.5 animate-spin" />
                    Loading…
                  </div>
                ) : items.length === 0 ? (
                  <div
                    data-yaade-notification-empty
                    className="flex flex-col items-center gap-1 px-4 py-10 text-center"
                  >
                    <Bell className="mb-1 size-5 text-muted-foreground/70" />
                    <p className="text-xs font-medium text-foreground">No unread notifications</p>
                    <p className="max-w-[16rem] text-3xs text-muted-foreground">
                      You’re caught up.
                    </p>
                  </div>
                ) : (
                  groups.map(group => (
                    <section key={group.id} data-yaade-notification-group={group.id}>
                      <h3 className="px-2 pb-1 text-4xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                        {group.label}
                      </h3>
                      <div className="flex flex-col gap-0.5">
                        {group.items.map(n => (
                          <NotificationItem
                            key={n.id}
                            notification={n}
                            selected={activeSelected === n.id}
                            sessionMissing={
                              Boolean(n.sessionId) &&
                              isSessionAvailable != null &&
                              !isSessionAvailable(n.sessionId!)
                            }
                            onOpen={() => {
                              setSelected(n.id)
                              onOpenNotification(n)
                            }}
                            onMarkRead={() => onMarkRead(n.id)}
                            onMarkUnread={() => onMarkUnread(n.id)}
                            onDismiss={() => onDismiss(n.id)}
                            onAcknowledge={
                              onAcknowledge ? () => onAcknowledge(n.id) : undefined
                            }
                          />
                        ))}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      </aside>
    </div>,
    document.body,
  )
}
