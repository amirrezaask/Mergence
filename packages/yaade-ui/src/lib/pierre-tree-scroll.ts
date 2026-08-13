import type { WheelEvent as ReactWheelEvent } from "react"

const FILE_TREE_SCROLL_SELECTOR = '[data-file-tree-virtualized-scroll="true"]'
const WHEEL_LINE_HEIGHT = 16

/**
 * The tree's virtualized scroller lives inside its shadow root. Chromium can
 * deliver wheel events to that element without applying the native scroll
 * default, so forward the delta explicitly at the host boundary.
 */
export function forwardPierreTreeWheel(event: ReactWheelEvent<HTMLElement>): void {
  const scrollElement = event.currentTarget.shadowRoot?.querySelector<HTMLElement>(
    FILE_TREE_SCROLL_SELECTOR,
  )
  if (!scrollElement || event.deltaY === 0) return

  const delta =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? event.deltaY * WHEEL_LINE_HEIGHT
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? event.deltaY * scrollElement.clientHeight
        : event.deltaY
  if (delta === 0) return

  const maxScrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight)
  const nextScrollTop = Math.max(
    0,
    Math.min(maxScrollTop, scrollElement.scrollTop + delta),
  )
  if (nextScrollTop === scrollElement.scrollTop) return

  scrollElement.scrollTop = nextScrollTop
}
