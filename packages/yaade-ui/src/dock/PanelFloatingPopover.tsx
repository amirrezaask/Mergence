import { useLayoutEffect, useState, type CSSProperties, type ReactNode } from "react"
import type { PanelId } from "@yaade/shared"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover.js"
import { cn } from "@/lib/utils.js"

export type PanelFloatCorner = "top-right" | "top-left" | "bottom-right" | "bottom-left"

export type PanelFloatingPopoverProps = {
  panelId: PanelId
  open: boolean
  onOpenChange?: (open: boolean) => void
  corner: PanelFloatCorner
  inset?: Partial<{ top: number; right: number; bottom: number; left: number }>
  contentClassName?: string
  children: ReactNode
}

const DEFAULT_INSET = {
  "top-right": { top: 4, right: 8, bottom: 4, left: 8 },
  "top-left": { top: 4, right: 8, bottom: 4, left: 8 },
  "bottom-right": { top: 4, right: 8, bottom: 4, left: 8 },
  "bottom-left": { top: 4, right: 8, bottom: 4, left: 8 },
} satisfies Record<PanelFloatCorner, { top: number; right: number; bottom: number; left: number }>

function anchorStyle(
  corner: PanelFloatCorner,
  rect: DOMRect,
  inset: { top: number; right: number; bottom: number; left: number },
): CSSProperties {
  switch (corner) {
    case "top-right":
      return { top: rect.top + inset.top, left: rect.right - inset.right }
    case "top-left":
      return { top: rect.top + inset.top, left: rect.left + inset.left }
    case "bottom-right":
      return { top: rect.bottom - inset.bottom, left: rect.right - inset.right }
    case "bottom-left":
      return { top: rect.bottom - inset.bottom, left: rect.left + inset.left }
  }
}

function popoverPlacement(corner: PanelFloatCorner): {
  side: "top" | "bottom"
  align: "start" | "end"
} {
  switch (corner) {
    case "top-right":
      return { side: "bottom", align: "end" }
    case "top-left":
      return { side: "bottom", align: "start" }
    case "bottom-right":
      return { side: "top", align: "end" }
    case "bottom-left":
      return { side: "top", align: "start" }
  }
}

export function PanelFloatingPopover({
  panelId,
  open,
  onOpenChange,
  corner,
  inset,
  contentClassName,
  children,
}: PanelFloatingPopoverProps) {
  const [anchorPoint, setAnchorPoint] = useState<CSSProperties | null>(null)
  const defaultInset = DEFAULT_INSET[corner]
  const insetTop = inset?.top ?? defaultInset.top
  const insetRight = inset?.right ?? defaultInset.right
  const insetBottom = inset?.bottom ?? defaultInset.bottom
  const insetLeft = inset?.left ?? defaultInset.left
  const placement = popoverPlacement(corner)

  useLayoutEffect(() => {
    if (!open) {
      setAnchorPoint(null)
      return
    }
    const measure = () => {
      const leaf = document.querySelector(`[data-yaade-panel-leaf="${panelId.id}"]`)
      if (!leaf) return
      setAnchorPoint(
        anchorStyle(corner, leaf.getBoundingClientRect(), {
          top: insetTop,
          right: insetRight,
          bottom: insetBottom,
          left: insetLeft,
        }),
      )
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [
    corner,
    insetBottom,
    insetLeft,
    insetRight,
    insetTop,
    open,
    panelId.id,
  ])

  if (!open || !anchorPoint) return null

  return (
    <Popover open={open} onOpenChange={onOpenChange} modal={false}>
      <PopoverAnchor asChild>
        <span
          aria-hidden
          data-yaade-panel-float=""
          className="pointer-events-none fixed h-px w-px"
          style={anchorPoint}
        />
      </PopoverAnchor>
      <PopoverContent
        side={placement.side}
        align={placement.align}
        sideOffset={4}
        className={cn("w-auto p-2", contentClassName)}
        onOpenAutoFocus={e => e.preventDefault()}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}
