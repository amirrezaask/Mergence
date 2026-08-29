import { useLayoutEffect, useRef } from "react"
import {
  acquireTerminalSurfacePlacement,
  subscribeResidentTerminalSurface,
} from "./terminal-surface-placement.js"

/**
 * Moves the one resident, imperative terminal DOM mount into this layout slot.
 * The parser, renderer, transport subscription, canvas, and textarea stay owned
 * by the canonical TerminalPanel controller.
 */
export function TerminalSurfacePlacement(props: {
  readonly terminalId: string
  readonly focused?: boolean
  readonly visible?: boolean
}) {
  const slotRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const slot = slotRef.current
    if (!slot) return
    let release: (() => void) | null = null
    const acquire = () => {
      release?.()
      release = acquireTerminalSurfacePlacement(
        props.terminalId,
        slot,
        props.visible ?? true,
      )
    }
    acquire()
    const unsubscribe = subscribeResidentTerminalSurface(props.terminalId, acquire)
    return () => {
      unsubscribe()
      release?.()
    }
  }, [props.terminalId, props.visible])

  useLayoutEffect(() => {
    if (!props.focused) return
    const input = slotRef.current?.querySelector<HTMLTextAreaElement>(
      "[data-ghostty-terminal-input]",
    )
    input?.focus({ preventScroll: true })
  }, [props.focused])

  return (
    <div
      ref={slotRef}
      className="relative h-full min-h-0 w-full overflow-hidden"
      data-yaade-terminal-placement={props.terminalId}
      data-focused={props.focused ? "" : undefined}
    />
  )
}
