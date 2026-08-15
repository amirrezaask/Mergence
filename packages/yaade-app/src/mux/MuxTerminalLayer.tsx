import {
  memo,
  useLayoutEffect,
  useState,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react"

export type MuxTerminalSlotBox = {
  top: number
  left: number
  width: number
  height: number
}

function boxesEqual(
  previous: Map<string, MuxTerminalSlotBox>,
  next: Map<string, MuxTerminalSlotBox>,
): boolean {
  if (previous.size !== next.size) return false
  for (const [id, box] of next) {
    const old = previous.get(id)
    if (
      !old ||
      old.top !== box.top ||
      old.left !== box.left ||
      old.width !== box.width ||
      old.height !== box.height
    ) {
      return false
    }
  }
  return true
}

function slotSelector(ptyTabId: string): string {
  // tab ids are terminal:… — escape for querySelector
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(ptyTabId)
      : ptyTabId.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  return `[data-yaade-mux-terminal-slot="${escaped}"]`
}

const MAX_SLOT_MEASURE_RETRIES = 45

function slotNeedsMeasure(
  container: HTMLElement,
  ptyTabId: string,
): boolean {
  const slot = container.querySelector<HTMLElement>(slotSelector(ptyTabId))
  if (!slot) return true
  const rect = slot.getBoundingClientRect()
  return rect.width < 1 || rect.height < 1
}

function paneSelector(tabId: string): string {
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(tabId)
      : tabId.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  return `[data-yaade-mux-pane="${escaped}"]`
}

/**
 * Measure every visible mux leaf for geometric keyboard focus. Writes into
 * `boxesRef` only — never React state — so split/resize cannot re-render MuxApp.
 */
export function useMuxPaneBoxesSync(
  containerRef: RefObject<HTMLElement | null>,
  dockRef: RefObject<HTMLElement | null>,
  tabIds: string[],
  layoutEpoch: string | number,
  boxesRef: MutableRefObject<Map<string, MuxTerminalSlotBox>>,
): void {
  const idKey = tabIds.join("\0")

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) {
      boxesRef.current = new Map()
      return
    }

    let raf = 0
    const syncNow = () => {
      const containerBox = container.getBoundingClientRect()
      const next = new Map<string, MuxTerminalSlotBox>()
      for (const id of tabIds) {
        const pane = container.querySelector<HTMLElement>(paneSelector(id))
        if (!pane) continue
        const rect = pane.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) continue
        next.set(id, {
          top: Math.round(rect.top - containerBox.top),
          left: Math.round(rect.left - containerBox.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        })
      }
      if (!boxesEqual(boxesRef.current, next)) {
        boxesRef.current = next
      }
    }
    const sync = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = 0
        syncNow()
      })
    }

    syncNow()
    const resizeObserver = new ResizeObserver(sync)
    resizeObserver.observe(container)
    const dock = dockRef.current
    if (dock) resizeObserver.observe(dock)
    for (const id of tabIds) {
      const pane = container.querySelector<HTMLElement>(paneSelector(id))
      if (pane) resizeObserver.observe(pane)
    }

    let mutationObserver: MutationObserver | null = null
    if (dock) {
      mutationObserver = new MutationObserver(mutations => {
        if (mutations.some(mutation => mutation.type === "childList")) sync()
      })
      mutationObserver.observe(dock, { childList: true, subtree: true })
    }
    window.addEventListener("resize", sync)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      mutationObserver?.disconnect()
      window.removeEventListener("resize", sync)
    }
  }, [boxesRef, containerRef, dockRef, idKey, layoutEpoch, tabIds])
}

/**
 * Keep terminal hosts mounted across PanelDock remounts (split/retile/DnD).
 * Slots are empty placeholders in the dock; this layer paints terminals over them.
 *
 * Geometry is measured relative to `containerRef`. Primary signal is ResizeObserver
 * on the container, dock, and each slot. A childList-only MutationObserver on the
 * dock catches PanelDock remounts that do not resize the outer box. Never observe
 * the xterm hosts — terminal DOM churn must not thrash layout.
 */
export function useMuxTerminalSlotBoxes(
  containerRef: RefObject<HTMLElement | null>,
  dockRef: RefObject<HTMLElement | null>,
  ptyTabIds: string[],
  /** Bump when panel tree structure changes so we re-query slots. */
  layoutEpoch: string | number,
): Map<string, MuxTerminalSlotBox> {
  const [boxes, setBoxes] = useState(() => new Map<string, MuxTerminalSlotBox>())
  const idKey = ptyTabIds.join("\0")

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) {
      setBoxes(new Map())
      return
    }

    let raf = 0
    const syncNow = () => {
      const cbox = container.getBoundingClientRect()
      const next = new Map<string, MuxTerminalSlotBox>()
      for (const id of ptyTabIds) {
        const slot = container.querySelector<HTMLElement>(slotSelector(id))
        if (!slot) continue
        const r = slot.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) continue
        // Integer CSS px — subpixel getBoundingClientRect noise must not
        // churn React state every animation frame.
        next.set(id, {
          top: Math.round(r.top - cbox.top),
          left: Math.round(r.left - cbox.left),
          width: Math.round(r.width),
          height: Math.round(r.height),
        })
      }
      setBoxes(prev => {
        if (prev.size === next.size) {
          let same = true
          for (const [id, box] of next) {
            const old = prev.get(id)
            if (
              !old ||
              old.top !== box.top ||
              old.left !== box.left ||
              old.width !== box.width ||
              old.height !== box.height
            ) {
              same = false
              break
            }
          }
          if (same) return prev
        }
        return next
      })
    }

    const sync = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = 0
        syncNow()
      })
    }

    syncNow()
    const ro = new ResizeObserver(() => sync())
    ro.observe(container)
    const dock = dockRef.current
    if (dock) ro.observe(dock)
    const observeSlots = () => {
      for (const id of ptyTabIds) {
        const slot = container.querySelector<HTMLElement>(slotSelector(id))
        if (slot) ro.observe(slot)
      }
    }
    observeSlots()
    let measureRetries = 0
    const retryIncompleteSlots = () => {
      if (ptyTabIds.some(id => slotNeedsMeasure(container, id))) {
        observeSlots()
        if (measureRetries >= MAX_SLOT_MEASURE_RETRIES) return
        measureRetries += 1
        raf = requestAnimationFrame(() => {
          raf = 0
          syncNow()
          retryIncompleteSlots()
        })
      }
    }
    retryIncompleteSlots()

    // childList only — attribute/characterData churn from panel chrome is ignored.
    let mo: MutationObserver | null = null
    if (dock) {
      mo = new MutationObserver(mutations => {
        if (mutations.some(m => m.type === "childList")) sync()
      })
      mo.observe(dock, { childList: true, subtree: true })
    }
    window.addEventListener("resize", sync)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      mo?.disconnect()
      window.removeEventListener("resize", sync)
    }
  }, [containerRef, dockRef, idKey, layoutEpoch, ptyTabIds])

  return boxes
}

export const MuxTerminalLayer = memo(function MuxTerminalLayer(props: {
  ptyTabIds: string[]
  boxes: Map<string, MuxTerminalSlotBox>
  focusedPtyTabId: string | null
  renderTerminal: (
    ptyTabId: string,
    focused: boolean,
    slotVisible: boolean,
  ) => ReactNode
}) {
  const { ptyTabIds, boxes, focusedPtyTabId, renderTerminal } = props
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[5] overflow-hidden"
      data-yaade-mux-terminal-layer=""
    >
      {ptyTabIds.map(id => {
        const box = boxes.get(id)
        const focused = focusedPtyTabId === id
        return (
          <div
            key={id}
            data-yaade-mux-terminal-host={id}
            data-yaade-tab-slot=""
            data-yaade-tab-active={focused ? "" : undefined}
            data-focused={focused ? "" : undefined}
            aria-hidden={box ? undefined : true}
            inert={box ? undefined : true}
            className={
              box
                ? "pointer-events-auto absolute overflow-hidden"
                : "pointer-events-none absolute h-0 w-0 overflow-hidden opacity-0"
            }
            style={
              box
                ? {
                    top: box.top,
                    left: box.left,
                    width: box.width,
                    height: box.height,
                  }
                : undefined
            }
          >
            {renderTerminal(id, focused, Boolean(box))}
          </div>
        )
      })}
    </div>
  )
})

/**
 * Owns terminal slot geometry state below MuxApp so RO/MO updates re-render
 * only this layer (not the full session chrome).
 */
export const MuxTerminalGeometryLayer = memo(function MuxTerminalGeometryLayer(props: {
  containerRef: RefObject<HTMLElement | null>
  dockRef: RefObject<HTMLElement | null>
  measureIds: string[]
  mountedPtyIds: string[]
  layoutEpoch: string | number
  focusedPtyTabId: string | null
  renderTerminal: (
    ptyTabId: string,
    focused: boolean,
    slotVisible: boolean,
  ) => ReactNode
}) {
  const boxes = useMuxTerminalSlotBoxes(
    props.containerRef,
    props.dockRef,
    props.measureIds,
    props.layoutEpoch,
  )
  return (
    <MuxTerminalLayer
      ptyTabIds={props.mountedPtyIds}
      boxes={boxes}
      focusedPtyTabId={props.focusedPtyTabId}
      renderTerminal={props.renderTerminal}
    />
  )
})
