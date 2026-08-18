import {
  ChevronDown,
  Columns2,
  Maximize2,
  Minimize2,
  Rows2,
  X,
} from "lucide-react"
import { useDraggable } from "@dnd-kit/core"
import type { MouseEvent, ReactNode, RefCallback } from "react"
import type { PanelId } from "@yaade/shared"
import { Button } from "@/components/ui/button.js"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js"
import { formatKeyBinding } from "@/lib/format-key.js"
import { cn } from "@/lib/utils.js"
import { AgentProviderIcon } from "../home/AgentProviderIcon.js"
import { tabDndId, type TabDragData } from "../dock/tab-dnd-types.js"
import { processIdentity } from "./process-identity.js"

export type MuxPaneChromeProps = {
  title: string
  focused: boolean
  paneId: string
  panelId: PanelId
  zoomed: boolean
  canZoom: boolean
  /** Foreground process basename for the identity glyph. */
  processName?: string | null
  /** Provider running in a terminal (`terminal` for a shell). */
  terminalProvider?: string | null
  onSplitButton?: (
    direction: "right" | "down",
    event: MouseEvent<HTMLButtonElement>,
  ) => void
  /** Wrap a split control, for example with a tool picker popover. */
  wrapSplitButton?: (
    direction: "right" | "down",
    button: ReactNode,
  ) => ReactNode
  onSplitRight: () => void
  onSplitDown: () => void
  onZoom: () => void
  onClose: () => void
  /** Open a pane-specific context editor from the title bar. */
  onOpenContext?: () => void
  /** Whether the pane context editor is currently open. */
  contextOpen?: boolean
  /**
   * Resolve a display shortcut for a command id (e.g. `mux.zoomPane` → `Mod-k z`).
   * App layer owns the binding table; UI must not import mux-keymap.
   */
  shortcutFor?: (commandId: string) => string | undefined
  /** Portal target for pane-specific header chrome (e.g. Git view tabs). */
  contextRef?: RefCallback<HTMLElement | null>
  className?: string
}

function SplitControl(props: {
  direction: "right" | "down"
  icon: ReactNode
  shortcut?: string
  onSplit: () => void
  onSplitButton?: (
    direction: "right" | "down",
    event: MouseEvent<HTMLButtonElement>,
  ) => void
  wrapSplitButton?: (
    direction: "right" | "down",
    button: ReactNode,
  ) => ReactNode
}) {
  const handleSplit = (event: MouseEvent<HTMLButtonElement>) => {
    if (props.onSplitButton) props.onSplitButton(props.direction, event)
    else props.onSplit()
  }
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={props.direction === "right" ? "Split right" : "Split down"}
      title={
        props.shortcut
          ? `${props.direction === "right" ? "Split right" : "Split down"} (${formatKeyBinding(props.shortcut)})`
          : undefined
      }
      data-yaade-mux-split={props.direction}
      className="text-muted-foreground/55 opacity-60 hover:text-foreground hover:opacity-100 focus-visible:text-foreground focus-visible:opacity-100 group-hover/mux-chrome:opacity-100 group-focus-within/mux-chrome:opacity-100"
      onClick={handleSplit}
      onContextMenu={event => {
        if (!props.onSplitButton || (!event.metaKey && !event.ctrlKey)) return
        event.preventDefault()
        event.stopPropagation()
        handleSplit(event)
      }}
    >
      {props.icon}
    </Button>
  )
  return props.wrapSplitButton?.(props.direction, button) ?? button
}

export function MuxPaneChrome(props: MuxPaneChromeProps) {
  const {
    title,
    focused,
    paneId,
    panelId,
    zoomed,
    canZoom,
    processName,
    terminalProvider,
    onSplitButton,
    wrapSplitButton,
    onSplitRight,
    onSplitDown,
    onZoom,
    onClose,
    onOpenContext,
    contextOpen = false,
    shortcutFor,
    contextRef,
    className,
  } = props

  const draggable = !zoomed
  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useDraggable({
    id: tabDndId(panelId, paneId),
    disabled: !draggable,
    data: {
      type: "tab",
      panelId,
      tabId: paneId,
      label: title,
    } satisfies TabDragData,
  })

  const identity = processIdentity(processName)
  const splitRightShortcut = shortcutFor?.("mux.splitRight")
  const splitDownShortcut = shortcutFor?.("mux.splitDown")
  const zoomShortcut = shortcutFor?.("mux.zoomPane")
  const zoomLabel = zoomed ? "Restore pane" : "Zoom pane"
  const zoomTitle = zoomShortcut
    ? `${zoomed ? "Restore" : "Zoom"} (${formatKeyBinding(zoomShortcut)})`
    : zoomLabel
  const contextTrigger = onOpenContext ? (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label="Set tool context"
      aria-haspopup="dialog"
      aria-expanded={contextOpen}
      data-yaade-mux-context-trigger=""
      className="size-5 text-muted-foreground/55 opacity-70 hover:text-foreground hover:opacity-100 focus-visible:text-foreground focus-visible:opacity-100"
      onPointerDown={event => event.stopPropagation()}
      onClick={event => {
        event.stopPropagation()
        onOpenContext()
      }}
    >
      {terminalProvider ? (
        <AgentProviderIcon agent={terminalProvider} className="size-3.5" />
      ) : (
        <ChevronDown />
      )}
    </Button>
  ) : null

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          data-yaade-mux-pane-chrome={paneId}
          data-panel-id={panelId.id}
          data-focused={focused ? "" : undefined}
          data-zoomed={zoomed ? "" : undefined}
          data-dragging={isDragging ? "" : undefined}
          className={cn(
            "group/mux-chrome relative flex h-7 shrink-0 items-center gap-0.5 px-1.5",
            "bg-transparent",
            draggable && "cursor-grab touch-none active:cursor-grabbing",
            isDragging && "opacity-45",
            className,
          )}
          {...(draggable ? listeners : {})}
          onDoubleClick={event => {
            const target = event.target
            if (
              target instanceof Element &&
              target.closest("button") &&
              !target.closest("[data-yaade-mux-pane-title]")
            ) {
              return
            }
            if (canZoom) onZoom()
          }}
        >
          <div
            aria-label={title || "Pane"}
            data-yaade-mux-pane-drag=""
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 self-stretch px-1.5",
              draggable ? "cursor-grab touch-none active:cursor-grabbing" : "",
            )}
            {...(draggable ? attributes : {})}
          >
            {terminalProvider ? (
              contextTrigger ?? (
                <span
                  aria-hidden
                  data-yaade-mux-pane-process={processName ?? ""}
                  className="grid size-5 shrink-0 place-items-center"
                >
                  <AgentProviderIcon
                    agent={terminalProvider}
                    className="size-3.5"
                  />
                </span>
              )
            ) : (
              <>
                <span
                  aria-hidden
                  data-yaade-mux-pane-process={processName ?? ""}
                  className="shrink-0 font-mono text-xs font-medium text-muted-foreground/55"
                >
                  {identity.glyph}
                </span>
                {contextTrigger}
              </>
            )}
            <span
              data-yaade-mux-pane-title=""
              className={cn(
                "min-w-0 truncate font-sans text-xs font-medium tracking-[-0.015em]",
                focused ? "text-foreground/65" : "text-muted-foreground/55",
              )}
            >
              {title || "Pane"}
            </span>
          </div>
          <div
            ref={contextRef}
            data-yaade-session-header-context=""
            className="flex min-h-0 min-w-0 flex-1 items-stretch self-stretch overflow-hidden"
            onPointerDown={event => {
              const target = event.target
              if (
                target instanceof Element &&
                target.closest("button,input,[role='tab'],[data-no-pane-drag]")
              ) {
                event.stopPropagation()
              }
            }}
          />
          <div
            className="flex shrink-0 items-center gap-0.5"
            onPointerDown={event => event.stopPropagation()}
          >
            <SplitControl
              direction="right"
              icon={<Columns2 />}
              shortcut={splitRightShortcut}
              onSplit={onSplitRight}
              onSplitButton={onSplitButton}
              wrapSplitButton={wrapSplitButton}
            />
            <SplitControl
              direction="down"
              icon={<Rows2 />}
              shortcut={splitDownShortcut}
              onSplit={onSplitDown}
              onSplitButton={onSplitButton}
              wrapSplitButton={wrapSplitButton}
            />
            {canZoom ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={zoomLabel}
                aria-pressed={zoomed}
                title={zoomTitle}
                data-yaade-mux-zoom=""
                className="text-muted-foreground/55 opacity-60 hover:text-foreground hover:opacity-100 focus-visible:text-foreground focus-visible:opacity-100 group-hover/mux-chrome:opacity-100 group-focus-within/mux-chrome:opacity-100"
                onClick={onZoom}
              >
                {zoomed ? <Minimize2 /> : <Maximize2 />}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Close pane"
              title="Close pane"
              data-yaade-mux-close-pane=""
              className="text-muted-foreground/55 opacity-60 hover:text-foreground hover:opacity-100 focus-visible:text-foreground focus-visible:opacity-100 group-hover/mux-chrome:opacity-100 group-focus-within/mux-chrome:opacity-100"
              onClick={onClose}
            >
              <X />
            </Button>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent data-yaade-mux-pane-context-menu="">
        <ContextMenuItem onSelect={onSplitRight}>
          Split Right
          {splitRightShortcut ? (
            <ContextMenuShortcut>{formatKeyBinding(splitRightShortcut)}</ContextMenuShortcut>
          ) : null}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onSplitDown}>
          Split Down
          {splitDownShortcut ? (
            <ContextMenuShortcut>{formatKeyBinding(splitDownShortcut)}</ContextMenuShortcut>
          ) : null}
        </ContextMenuItem>
        {canZoom ? (
          <ContextMenuItem onSelect={onZoom}>
            {zoomed ? "Restore Pane" : "Zoom Pane"}
            {zoomShortcut ? (
              <ContextMenuShortcut>{formatKeyBinding(zoomShortcut)}</ContextMenuShortcut>
            ) : null}
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={onClose}>
          Close Pane
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
