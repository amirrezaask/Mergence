import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core"
import { CSS } from "@dnd-kit/utilities"
import { arrayMove } from "@dnd-kit/sortable"
import type { DropAction, PanelId } from "@yaade/shared"
import { yaadeMotion } from "@/motion/tokens.js"
import { YaadeTabDragGhost } from "@/motion/YaadeOverlayMotion.js"
import type { DropSiteKind } from "./panel-drop-zones.js"
import {
  dropSitesRegistry,
  hitTestSites,
  siteToAction,
  type DropSite,
} from "./panel-drop-zones.js"
import {
  parseDropDndId,
  parseTabBarDndId,
  parseTabDndId,
  isSessionDragData,
  isTabDragData,
  type DockDragData,
} from "./tab-dnd-types.js"
import { PanelDragProvider, usePanelDrag } from "./PanelDragContext.js"

export type TabDndHandlers = {
  onTabReorder: (panelId: PanelId, tabId: string, toIndex: number) => void
  onTabDrop: (
    source: PanelId,
    sourceTabId: string,
    target: PanelId,
    action: DropAction,
  ) => void
  /**
   * Drop a session that is not currently open as a pane tab (sidebar drag).
   * Opens into the target pane / split, then focuses it.
   */
  onSessionDrop?: (
    tabId: string,
    target: PanelId,
    action: DropAction,
  ) => void
  /** Tab ids per panel for reorder index math. */
  tabIdsForPanel: (panelId: PanelId) => string[]
}

type TabDndInnerProps = {
  children: ReactNode
  handlers: TabDndHandlers
}

type DropHotState = {
  panelId: PanelId
  zone: DropSiteKind
  preview: DropSite["preview"]
} | null

let dropHotState: DropHotState = null
const dropHotListeners = new Set<() => void>()

function subscribeDropHot(cb: () => void): () => void {
  dropHotListeners.add(cb)
  return () => dropHotListeners.delete(cb)
}

function setDropHotState(next: DropHotState): void {
  if (dropHotState === next) return
  dropHotState = next
  for (const cb of dropHotListeners) cb()
}

function getDropHot(): DropHotState {
  return dropHotState
}

/** Subscribe to the current drop-hot zone. Fine-grained: only re-renders when hot changes. */
export function useDropHot(): DropHotState {
  return useSyncExternalStore(subscribeDropHot, getDropHot, getDropHot)
}

type DropAnimTarget = { x: number; y: number; w: number; h: number }

function resolveDropAnimTarget(hot: DropHotState): DropAnimTarget | null {
  if (!hot) return null
  const overlay = document.querySelector<HTMLElement>(
    `[data-yaade-panel-drop-overlay][data-yaade-drop-panel="${hot.panelId.id}"]`,
  )
  if (!overlay) return null
  const panelRect = overlay.getBoundingClientRect()
  const p = hot.preview
  return {
    x: panelRect.left + p.x,
    y: panelRect.top + p.y,
    w: p.w,
    h: p.h,
  }
}

function createTabDropAnimation(
  dropAnimTargetRef: RefObject<DropAnimTarget | null>,
): DropAnimation {
  return {
    duration: Math.round(yaadeMotion.layoutTransition.duration * 1000),
    easing: "ease-out",
    keyframes({ transform, dragOverlay }) {
      const target = dropAnimTargetRef.current
      if (target && dragOverlay?.rect) {
        const overlay = dragOverlay.rect
        const dx = target.x + target.w / 2 - (overlay.left + overlay.width / 2)
        const dy = target.y + target.h / 2 - (overlay.top + overlay.height / 2)
        return [
          { opacity: 1, transform: CSS.Transform.toString(transform.initial) },
          {
            opacity: 0,
            transform: CSS.Transform.toString({
              ...transform.initial,
              x: transform.initial.x + dx,
              y: transform.initial.y + dy,
              scaleX: 0.9,
              scaleY: 0.9,
            }),
          },
        ]
      }
      return [
        { opacity: 1, transform: CSS.Transform.toString(transform.initial) },
        { opacity: 0, transform: CSS.Transform.toString(transform.initial) },
      ]
    },
    sideEffects() {
      return () => {
        dropAnimTargetRef.current = null
      }
    },
  }
}

type OverlaySnapshot = {
  el: HTMLElement
  panelId: number
  rect: DOMRect
  ro: ResizeObserver
}

function TabDndInner({ children, handlers }: TabDndInnerProps) {
  const drag = usePanelDrag()
  const [activeDrag, setActiveDrag] = useState<DockDragData | null>(null)
  const dropHotRef = useRef<DropHotState>(null)
  const dropAnimTargetRef = useRef<DropAnimTarget | null>(null)
  const dropAnimation = useMemo(() => createTabDropAnimation(dropAnimTargetRef), [])
  const overlaysRef = useRef<OverlaySnapshot[]>([])
  const pendingMoveRef = useRef<{ cx: number; cy: number } | null>(null)
  const rafRef = useRef<number | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  const clearOverlaySnapshots = useCallback(() => {
    for (const s of overlaysRef.current) s.ro.disconnect()
    overlaysRef.current = []
  }, [])

  const runMove = useCallback(() => {
    rafRef.current = null
    const pending = pendingMoveRef.current
    if (!pending) return
    const { cx, cy } = pending
    let best: DropHotState = null
    for (const snap of overlaysRef.current) {
      const rect = snap.rect
      if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) continue
      const sites = dropSitesRegistry.get(snap.el)
      if (!sites || sites.length === 0) continue
      const mx = cx - rect.left
      const my = cy - rect.top
      const hit = hitTestSites(mx, my, sites)
      if (hit) {
        best = { panelId: { id: snap.panelId }, zone: hit.id, preview: hit.preview }
        break
      }
    }
    dropHotRef.current = best
    setDropHotState(best)
  }, [])

  const snapshotOverlays = useCallback(() => {
    clearOverlaySnapshots()
    const els = document.querySelectorAll<HTMLElement>("[data-yaade-panel-drop-overlay]")
    const snapshots: OverlaySnapshot[] = []
    for (const el of els) {
      if (el.closest("[data-yaade-layout-morph-clone]")) continue
      const panelId = Number(el.dataset.yaadeDropPanel)
      if (!Number.isFinite(panelId)) continue
      const rect = el.getBoundingClientRect()
      const snap: OverlaySnapshot = {
        el,
        panelId,
        rect,
        ro: new ResizeObserver(() => {
          snap.rect = el.getBoundingClientRect()
        }),
      }
      snap.ro.observe(el)
      snapshots.push(snap)
    }
    overlaysRef.current = snapshots
  }, [clearOverlaySnapshots])

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      const data = event.active.data.current as DockDragData | undefined
      if (isTabDragData(data)) {
        setActiveDrag(data)
        drag.startTab({ panelId: data.panelId, tabId: data.tabId })
      } else if (isSessionDragData(data)) {
        setActiveDrag(data)
        drag.startTab({ panelId: null, tabId: data.tabId })
      } else {
        return
      }
      // Re-snapshot after overlays flip to active and register drop sites.
      requestAnimationFrame(() => {
        snapshotOverlays()
        if (pendingMoveRef.current) runMove()
      })
    },
    [drag, snapshotOverlays, runMove],
  )

  const onDragMove = useCallback((event: DragMoveEvent) => {
    const activator = event.activatorEvent
    if (!activator || !("clientX" in activator)) {
      dropHotRef.current = null
      setDropHotState(null)
      return
    }
    pendingMoveRef.current = {
      cx: (activator as PointerEvent).clientX + event.delta.x,
      cy: (activator as PointerEvent).clientY + event.delta.y,
    }
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(runMove)
    }
  }, [runMove])

  const applyHotOrOverDrop = useCallback(
    (
      tabId: string,
      sourcePanel: PanelId | null,
      hot: DropHotState,
      overId: string | null,
    ) => {
      if (hot) {
        if (sourcePanel && sourcePanel.id === hot.panelId.id && hot.zone === "center") {
          // same-pane center is a no-op for tabs; for sidebar always open/focus
        } else if (sourcePanel) {
          handlers.onTabDrop(
            sourcePanel,
            tabId,
            hot.panelId,
            siteToAction(hot.zone),
          )
          return true
        } else if (handlers.onSessionDrop) {
          handlers.onSessionDrop(tabId, hot.panelId, siteToAction(hot.zone))
          return true
        }
      }

      if (!overId) return false

      const dropTarget = parseDropDndId(overId)
      if (dropTarget) {
        if (sourcePanel) {
          handlers.onTabDrop(
            sourcePanel,
            tabId,
            dropTarget.panelId,
            siteToAction(dropTarget.zone),
          )
        } else {
          handlers.onSessionDrop?.(
            tabId,
            dropTarget.panelId,
            siteToAction(dropTarget.zone),
          )
        }
        return true
      }

      const tabBarTarget = parseTabBarDndId(overId)
      if (tabBarTarget) {
        if (sourcePanel && tabBarTarget.id === sourcePanel.id) return true
        if (sourcePanel) {
          handlers.onTabDrop(sourcePanel, tabId, tabBarTarget, { kind: "moveToPane" })
        } else {
          handlers.onSessionDrop?.(tabId, tabBarTarget, { kind: "moveToPane" })
        }
        return true
      }

      const tabTarget = parseTabDndId(overId)
      if (!tabTarget) return false

      if (sourcePanel && tabTarget.panelId.id === sourcePanel.id) {
        const ids = handlers.tabIdsForPanel(sourcePanel)
        const oldIndex = ids.indexOf(tabId)
        const newIndex = ids.indexOf(tabTarget.tabId)
        if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return true
        const next = arrayMove(ids, oldIndex, newIndex)
        handlers.onTabReorder(sourcePanel, tabId, next.indexOf(tabId))
        return true
      }

      const targetIds = handlers.tabIdsForPanel(tabTarget.panelId)
      const insertIndex = targetIds.indexOf(tabTarget.tabId)
      const action = {
        kind: "moveToPane" as const,
        insertIndex: insertIndex >= 0 ? insertIndex : undefined,
      }
      if (sourcePanel) {
        handlers.onTabDrop(sourcePanel, tabId, tabTarget.panelId, action)
      } else {
        handlers.onSessionDrop?.(tabId, tabTarget.panelId, action)
      }
      return true
    },
    [handlers],
  )

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const data = event.active.data.current as DockDragData | undefined
      const hot = dropHotRef.current
      dropAnimTargetRef.current = hot ? resolveDropAnimTarget(hot) : null
      setActiveDrag(null)
      dropHotRef.current = null
      setDropHotState(null)
      drag.endTab()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      pendingMoveRef.current = null
      clearOverlaySnapshots()
      if (!data) return

      const overId = event.over ? String(event.over.id) : null

      if (isTabDragData(data)) {
        if (hot && data.panelId.id !== hot.panelId.id) {
          handlers.onTabDrop(data.panelId, data.tabId, hot.panelId, siteToAction(hot.zone))
          return
        }
        if (hot && data.panelId.id === hot.panelId.id && hot.zone !== "center") {
          handlers.onTabDrop(data.panelId, data.tabId, hot.panelId, siteToAction(hot.zone))
          return
        }
        applyHotOrOverDrop(data.tabId, data.panelId, null, overId)
        return
      }

      if (isSessionDragData(data)) {
        applyHotOrOverDrop(data.tabId, null, hot, overId)
      }
    },
    [drag, handlers, clearOverlaySnapshots, applyHotOrOverDrop],
  )

  const onDragCancel = useCallback(() => {
    setActiveDrag(null)
    dropHotRef.current = null
    setDropHotState(null)
    drag.endTab()
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    pendingMoveRef.current = null
    clearOverlaySnapshots()
  }, [drag, clearOverlaySnapshots])

  const ghostLabel =
    activeDrag && isTabDragData(activeDrag)
      ? activeDrag.label
      : activeDrag && isSessionDragData(activeDrag)
        ? activeDrag.label
        : null
  const ghostDirty =
    activeDrag && isTabDragData(activeDrag) ? activeDrag.dirty : false

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      {children}
      <DragOverlay dropAnimation={dropAnimation}>
        {ghostLabel != null ? (
          <YaadeTabDragGhost label={ghostLabel} dirty={ghostDirty} />
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

export function TabDndRoot({
  children,
  handlers,
}: {
  children: ReactNode
  handlers: TabDndHandlers
}) {
  return (
    <PanelDragProvider>
      <TabDndInner handlers={handlers}>{children}</TabDndInner>
    </PanelDragProvider>
  )
}
