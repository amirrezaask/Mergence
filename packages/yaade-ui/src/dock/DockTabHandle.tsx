import { useDraggable, useDroppable } from "@dnd-kit/core"
import type { KeyboardEventHandler, ReactNode } from "react"
import type { PanelId } from "@yaade/shared"
import { cn } from "@/lib/utils.js"
import { tabBarDndId, tabDndId, type TabDragData } from "./tab-dnd-types.js"

export type DockTabHandleProps = {
  panelId: PanelId
  tabId: string
  label: string
  active: boolean
  className?: string
  children: ReactNode
  onActivate: () => void
}

/** Draggable, keyboard-focusable tab label for a PanelDock tab group. */
export function DockTabHandle(props: DockTabHandleProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: tabDndId(props.panelId, props.tabId),
    data: {
      type: "tab",
      panelId: props.panelId,
      tabId: props.tabId,
      label: props.label,
    } satisfies TabDragData,
  })

  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      role="tab"
      aria-selected={props.active}
      tabIndex={props.active ? 0 : -1}
      data-dragging={isDragging ? "" : undefined}
      className={cn(isDragging && "opacity-40", props.className)}
      title={props.label}
      onClick={props.onActivate}
      {...listeners}
    >
      {props.children}
    </button>
  )
}

export type DockTabBarDropTargetProps = {
  panelId: PanelId
  className?: string
  activeClassName?: string
  children: ReactNode
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>
  ariaLabel?: string
}

/** Droppable tab-strip surface; dropping on its empty area appends a tab. */
export function DockTabBarDropTarget(props: DockTabBarDropTargetProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: tabBarDndId(props.panelId),
  })
  return (
    <div
      ref={setNodeRef}
      className={cn(props.className, isOver && props.activeClassName)}
      role="tablist"
      aria-label={props.ariaLabel}
      onKeyDown={props.onKeyDown}
    >
      {props.children}
    </div>
  )
}
