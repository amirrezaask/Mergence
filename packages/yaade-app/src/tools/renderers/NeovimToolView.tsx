import { useEffect, useRef, useState } from "react"
import { AnimatePresence } from "motion/react"
import { div as MotionDiv } from "motion/react-m"
import { AlertCircle, Code2, Copy, LoaderCircle, RotateCcw } from "lucide-react"
import type { ToolUse } from "@yaade/rpc"
import {
  NeovimSurface,
  registerNeovimSurface,
  unregisterNeovimSurface,
  type NeovimFailureCategory,
  type NeovimSurfaceStatus,
} from "@yaade/ui/neovim"
import { Button } from "@yaade/ui/primitives"
import { cn, yaadeMotion } from "@yaade/ui"
import type { ToolRendererProps } from "../tool-registry.js"

type Props = ToolRendererProps & {
  readonly onAction?: (action: "cancel" | "restart" | "archive") => void
}

function initialStatus(use: ToolUse): NeovimSurfaceStatus {
  if (use.status === "failed" || use.status === "cancelled" || use.status === "disconnected") return "failed"
  if (use.output.kind !== "neovim") return "failed"
  if (use.output.processState === "failed" || use.output.processState === "disconnected") return "failed"
  if (use.output.processState === "exited") return "exited"
  return "starting"
}

function statusLabel(status: NeovimSurfaceStatus, category: NeovimFailureCategory | null): string {
  if (status === "failed") {
    if (category === "webgl") return "WebGL2 renderer unavailable"
    if (category === "api") return "Neovim API is incompatible"
    if (category === "protocol") return "Neovim redraw protocol error"
    if (category === "host" || category === "process") return "Neovim process failed"
    return "Neovim channel unavailable"
  }
  switch (status) {
    case "ready":
      return "Connected"
    case "reconnecting":
      return "Reconnecting"
    case "exited":
      return "Neovim exited"
    case "connecting":
      return "Connecting to Neovim"
    default:
      return "Starting Neovim"
  }
}

export function NeovimToolView(props: Props) {
  const { use } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const surfaceRef = useRef<NeovimSurface | null>(null)
  const [status, setStatus] = useState<NeovimSurfaceStatus>(() => initialStatus(use))
  const [failureCategory, setFailureCategory] = useState<NeovimFailureCategory | null>(null)
  const [error, setError] = useState<string | undefined>(use.error)
  const [notice, setNotice] = useState<string | undefined>()
  const output = use.output.kind === "neovim" ? use.output : null
  const canMount = Boolean(
    output &&
    use.status !== "failed" &&
    use.status !== "cancelled" &&
    use.status !== "disconnected" &&
    output.processState === "running" &&
    use.status === "running",
  )

  useEffect(() => {
    if (!canMount || !output) return
    const canvas = canvasRef.current
    const input = inputRef.current
    if (!canvas || !input) return
    const surface = new NeovimSurface({
      canvas,
      input,
      toolUseId: use.id,
      generation: output.generation,
      theme: props.theme,
      fontSize: props.fontSize,
      onStatus: (next, nextError, category) => {
        setStatus(next)
        setFailureCategory(current => category ?? (next === "ready" ? null : current))
        if (nextError) setError(nextError)
        else if (next === "ready") setError(undefined)
      },
      onNotice: message => {
        setNotice(message)
        window.setTimeout(() => setNotice(current => current === message ? undefined : current), 2_500)
      },
    })
    surfaceRef.current = surface
    // Mount before registering so queued Search locations see an active
    // connection lifecycle rather than calling openLocation on an unmounted
    // surface during the same React commit.
    surface.mount()
    registerNeovimSurface(use.id, surface)
    return () => {
      unregisterNeovimSurface(use.id, surface)
      surface.dispose()
      if (surfaceRef.current === surface) surfaceRef.current = null
    }
  }, [canMount, use.id])

  useEffect(() => {
    surfaceRef.current?.updateTheme(props.theme, props.fontSize)
  }, [props.fontSize, props.theme])

  useEffect(() => {
    if (output) surfaceRef.current?.updateGeneration(output.generation)
  }, [output?.generation])

  useEffect(() => {
    if (canMount) return
    if (output?.processState === "exited") setStatus("exited")
    else if (output?.processState === "failed" || output?.processState === "disconnected" || use.status === "failed" || use.status === "cancelled" || use.status === "disconnected") setStatus("failed")
    else setStatus("starting")
  }, [canMount, output?.processState, use.status])

  useEffect(() => {
    surfaceRef.current?.setVisible(props.visible !== false)
  }, [props.visible])

  useEffect(() => {
    if (use.error) setError(use.error)
  }, [use.error])

  const isError = status === "failed" || status === "exited"
  const processFailure = status === "exited" || failureCategory === "process" || failureCategory === "host"
  const retryableFailure = status === "failed" && !processFailure && failureCategory !== "api" && failureCategory !== "protocol"
  const copyableFailure = status === "failed" && (failureCategory === "api" || failureCategory === "protocol")
  const copyDiagnostics = () => {
    if (!error) return
    const clipboard = navigator.clipboard
    if (!clipboard) {
      setNotice("Clipboard permission is unavailable")
      return
    }
    void clipboard.writeText(error).then(
      () => setNotice("Diagnostics copied"),
      () => setNotice("Clipboard permission is unavailable"),
    )
  }
  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
      data-yaade-neovim-surface=""
      data-yaade-neovim-tool-use={use.id}
      data-yaade-neovim-status={status}
      data-yaade-neovim-failure={failureCategory ?? ""}
      data-yaade-neovim-generation={output?.generation ?? ""}
      data-yaade-neovim-renderer="webgl2"
    >
      <canvas
        ref={canvasRef}
        className="block h-full min-h-0 min-w-0 flex-1 outline-none"
        data-yaade-neovim-canvas=""
        aria-label="Neovim editor"
        onFocus={() => surfaceRef.current?.focus()}
      />
      <textarea
        ref={inputRef}
        className="pointer-events-none absolute left-0 top-0 size-px resize-none border-0 bg-transparent p-0 opacity-0 outline-none"
        data-yaade-neovim-input=""
        aria-label="Neovim keyboard input"
        tabIndex={-1}
      />
      <AnimatePresence initial={false} mode="wait">
        {status !== "ready" ? (
          <MotionDiv
            key={status}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={yaadeMotion.overlayTransition}
            className={cn(
              "absolute inset-0 grid place-items-center bg-background/90 p-4",
              isError ? "text-destructive" : "text-muted-foreground",
            )}
            data-yaade-neovim-overlay={status}
          >
            <div className="flex max-w-md flex-col items-center gap-2 text-center">
              {isError ? <AlertCircle className="size-5" aria-hidden /> : <LoaderCircle className="size-5 animate-spin" aria-hidden />}
              <p className="text-sm font-medium">{statusLabel(status, failureCategory)}</p>
              {error ? <p className="max-w-sm break-words text-2xs text-muted-foreground">{error}</p> : null}
              {retryableFailure ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-1"
                  onClick={() => surfaceRef.current?.retry()}
                  data-yaade-neovim-retry=""
                >
                  <RotateCcw data-icon="inline-start" />
                  Retry connection
                </Button>
              ) : null}
              {copyableFailure ? (
                <Button type="button" size="sm" variant="outline" className="mt-1" onClick={copyDiagnostics} data-yaade-neovim-copy-diagnostics="">
                  <Copy data-icon="inline-start" />
                  Copy diagnostics
                </Button>
              ) : null}
              {processFailure ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-1"
                  onClick={() => props.onAction?.("restart")}
                  disabled={!props.onAction}
                  data-yaade-neovim-restart=""
                >
                  <RotateCcw data-icon="inline-start" />
                  Restart Neovim
                </Button>
              ) : null}
            </div>
          </MotionDiv>
        ) : null}
      </AnimatePresence>
      <span className="sr-only" data-yaade-neovim-ready={status === "ready" ? "true" : "false"}>
        <Code2 aria-hidden />
      </span>
      <span className="sr-only" aria-live="polite">{notice ?? ""}</span>
    </div>
  )
}

export default NeovimToolView
