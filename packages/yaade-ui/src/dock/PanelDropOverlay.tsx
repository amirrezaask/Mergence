import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useDroppable } from "@dnd-kit/core"
import {
  PanelLeftIcon,
  PanelRightIcon,
  PanelTopIcon,
  PanelBottomIcon,
  SquareIcon,
} from "lucide-react"
import type { PanelId } from "@yaade/shared"
import {
  YAADE_LAYOUT_EPSILON,
  YAADE_RATE_MENU,
  prefersReducedMotion,
  radAnimationRate,
  radLerp,
} from "@yaade/shared"
import { cn } from "@/lib/utils.js"
import { usePanelDragSource } from "./PanelDragContext.js"
import { useDropHot } from "./TabDndRoot.js"
import { dropDndId } from "./tab-dnd-types.js"
import {
  computeDropSites,
  dropSitesRegistry,
  siteToAction,
  type DropSite,
  type DropSiteKind,
  type SiteRect,
} from "./panel-drop-zones.js"

function useElementSize(
  ref: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    if (!enabled) {
      setSize({ w: 0, h: 0 })
      return
    }
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const entry = entries[0]
      if (!entry) return
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    ro.observe(el)
    const r = el.getBoundingClientRect()
    setSize({ w: r.width, h: r.height })
    return () => ro.disconnect()
  }, [enabled, ref])
  return size
}

function useFontSize(ref: React.RefObject<HTMLDivElement | null>): number {
  const [fs, setFs] = useState(13)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const v = parseFloat(getComputedStyle(el).fontSize)
    if (!isNaN(v) && v > 0) setFs(v)
  }, [ref])
  return fs
}

function siteIcon(kind: DropSiteKind) {
  const cls = "size-3.5"
  switch (kind) {
    case "center":
      return <SquareIcon className={cls} />
    case "left":
      return <PanelLeftIcon className={cls} />
    case "right":
      return <PanelRightIcon className={cls} />
    case "top":
      return <PanelTopIcon className={cls} />
    case "bottom":
      return <PanelBottomIcon className={cls} />
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

function DropSiteTarget({
  panelId,
  site,
  entered,
  hot,
}: {
  panelId: PanelId
  site: DropSite
  entered: boolean
  hot: boolean
}) {
  const { setNodeRef } = useDroppable({
    id: dropDndId(panelId, site.id),
    data: { type: "split", panelId, zone: site.id },
  })

  return (
    <div
      ref={setNodeRef}
      data-drop-site={site.id}
      className={cn(
        "pointer-events-auto absolute flex items-center justify-center rounded-md border shadow-sm transition-[opacity,transform] duration-[var(--yaade-motion-dnd-site)] ease-out",
        entered ? "opacity-100" : "opacity-0",
        hot
          ? "border-primary bg-primary/20 text-primary"
          : "border-border bg-muted text-muted-foreground",
      )}
      style={{
        left: site.rect.x,
        top: site.rect.y,
        width: site.rect.w,
        height: site.rect.h,
        transform: entered
          ? hot
            ? "scale(1.05)"
            : "scale(1)"
          : "scale(var(--yaade-motion-squish-scale))",
      }}
    >
      {siteIcon(site.id)}
    </div>
  )
}

function AnimatedDropPreview({
  target,
  panelSize,
}: {
  target: SiteRect
  panelSize: { w: number; h: number }
}) {
  const elementRef = useRef<HTMLDivElement>(null)
  const currentRef = useRef<SiteRect | null>(null)

  useEffect(() => {
    const element = elementRef.current
    if (!element || target.w <= 0 || target.h <= 0) return
    let frame: number | null = null
    let lastFrame = performance.now()
    const current = currentRef.current ?? {
      x: target.x + target.w * 0.025,
      y: target.y + target.h * 0.025,
      w: target.w * 0.95,
      h: target.h * 0.95,
    }
    currentRef.current = current

    const paint = () => {
      const scaleX = current.w / target.w
      const scaleY = current.h / target.h
      element.style.transform =
        `translate3d(${current.x}px, ${current.y}px, 0) scale(${scaleX}, ${scaleY})`
    }

    if (prefersReducedMotion()) {
      Object.assign(current, target)
      element.style.opacity = "1"
      paint()
      return
    }

    element.style.willChange = "transform"
    element.style.opacity = "1"
    const tick = (now: number) => {
      const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000))
      lastFrame = now
      const rate = radAnimationRate(YAADE_RATE_MENU, dt)
      current.x = radLerp(current.x, target.x, rate)
      current.y = radLerp(current.y, target.y, rate)
      current.w = radLerp(current.w, target.w, rate)
      current.h = radLerp(current.h, target.h, rate)
      paint()

      const settled =
        Math.abs(current.x - target.x) < YAADE_LAYOUT_EPSILON &&
        Math.abs(current.y - target.y) < YAADE_LAYOUT_EPSILON &&
        Math.abs(current.w - target.w) < YAADE_LAYOUT_EPSILON &&
        Math.abs(current.h - target.h) < YAADE_LAYOUT_EPSILON
      if (settled) {
        Object.assign(current, target)
        paint()
        element.style.willChange = "auto"
      } else {
        frame = requestAnimationFrame(tick)
      }
    }
    paint()
    frame = requestAnimationFrame(tick)
    return () => {
      if (frame != null) cancelAnimationFrame(frame)
      element.style.willChange = "auto"
    }
  }, [panelSize.h, panelSize.w, target.h, target.w, target.x, target.y])

  return (
    <div
      ref={elementRef}
      className="pointer-events-none rounded-sm border border-primary/60 bg-primary/15 opacity-0 transition-opacity duration-[var(--yaade-motion-fast)] ease-[var(--yaade-ease-out)]"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: target.w,
        height: target.h,
        transformOrigin: "0 0",
        transform: `translate3d(${target.x + target.w * 0.025}px, ${target.y + target.h * 0.025}px, 0) scale(0.95)`,
      }}
    />
  )
}

export function PanelDropOverlay({
  panelId,
}: {
  panelId: PanelId
  /** @deprecated drops handled by TabDndRoot */
  onTabDrop?: unknown
}) {
  const tabDrag = usePanelDragSource()
  const dropHot = useDropHot()
  const containerRef = useRef<HTMLDivElement>(null)
  const active = tabDrag != null
  // ResizeObserver only while a tab drag is active — idle N-pane docks pay zero measure cost.
  const size = useElementSize(containerRef, active)
  const fontSize = useFontSize(containerRef)
  const samePanel =
    tabDrag?.panelId != null && tabDrag.panelId.id === panelId.id

  const sites = useMemo(
    () => (active ? computeDropSites(size.w, size.h, fontSize) : []),
    [active, size.w, size.h, fontSize],
  )
  const effectiveSites = samePanel ? sites.filter(s => s.id !== "center") : sites

  const hotSite: DropSite | null =
    dropHot && dropHot.panelId.id === panelId.id
      ? (effectiveSites.find(s => s.id === dropHot.zone) ?? null)
      : null

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (active && effectiveSites.length > 0) {
      dropSitesRegistry.set(el, effectiveSites)
    } else {
      dropSitesRegistry.delete(el)
    }
  }, [active, effectiveSites, panelId.id])

  return (
    <div
      ref={containerRef}
      className={cn("absolute inset-0 z-40", !active && "pointer-events-none")}
      data-yaade-panel-drop-overlay
      data-yaade-drop-panel={panelId.id}
    >
      {active && (
        <>
          {hotSite && (
            <AnimatedDropPreview target={hotSite.preview} panelSize={size} />
          )}

          {effectiveSites.map(site => (
            <DropSiteTarget
              key={site.id}
              panelId={panelId}
              site={site}
              entered={active}
              hot={hotSite?.id === site.id}
            />
          ))}
        </>
      )}
    </div>
  )
}

export { siteToAction }
