import { Columns2, GitBranch, Maximize2, Minimize2, Rows2, X } from "lucide-react"
import { useDraggable } from "@dnd-kit/core"
import type { ReactNode, RefCallback, SVGProps } from "react"
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
import { cn } from "@/lib/utils.js"
import { tabDndId, type TabDragData } from "../dock/tab-dnd-types.js"
import { deckTileStyle, processIdentity } from "./process-identity.js"

/** Simple Icons Neovim mark — monochrome via currentColor. */
function NeovimIcon(props: SVGProps<SVGSVGElement>) {
  const { className, ...rest } = props
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-hidden
      className={cn("size-3 shrink-0 fill-current", className)}
      {...rest}
    >
      <path d="M2.214 4.954v13.615L7.655 24V10.314L3.312 3.845 2.214 4.954zm4.999 17.98l-4.557-4.548V5.136l.59-.596 3.967 5.908v12.485zm14.573-4.457l-.862.937-4.24-6.376V0l5.068 5.092.034 13.385zM7.431.001l12.998 19.835-3.637 3.637L3.787 3.683 7.43 0z" />
    </svg>
  )
}

/** Secondary chrome: always visible at reduced opacity; full on hover/focus-visible. */
const secondaryControlClass =
  "text-muted-foreground/70 hover:text-foreground opacity-70 hover:opacity-100 focus-visible:opacity-100 group-hover/mux-pane:opacity-100 group-focus-within/mux-pane:opacity-100"

export type MuxPaneChromeProps = {
  title: string
  focused: boolean
  paneId: string
  panelId: PanelId
  zoomed: boolean
  canZoom: boolean
  /** Foreground process basename for the deck tile. */
  processName?: string | null
  /** When false, title is not a drag handle (e.g. zoomed solo). */
  draggable?: boolean
  onSplitRight: () => void
  onSplitDown: () => void
  /** Open Git workspace in a new split beside this pane. */
  onOpenGit?: () => void
  /** Open Neovim (PTY) in a new split beside this pane. */
  onOpenNeovim?: () => void
  onZoom: () => void
  onClose: () => void
  /**
   * Resolve a display shortcut for a command id (e.g. `mux.openGit` → `Mod-k g`).
   * App layer owns the binding table; UI must not import mux-keymap.
   */
  shortcutFor?: (commandId: string) => string | undefined
  /** Portal target for pane-specific header chrome (e.g. Git view tabs). */
  contextRef?: RefCallback<HTMLElement | null>
  className?: string
  /** Content in the flexible center of the chrome (e.g. editor buffer tabs). */
  center?: ReactNode
  trailing?: ReactNode
  /** Dirty indicator for editor panes. */
  dirty?: boolean
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
    draggable = true,
    onSplitRight,
    onSplitDown,
    onOpenGit,
    onOpenNeovim,
    onZoom,
    onClose,
    shortcutFor,
    contextRef,
    className,
    center,
    trailing,
    dirty = false,
  } = props

  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useDraggable({
    id: tabDndId(panelId, paneId),
    disabled: !draggable || zoomed,
    data: {
      type: "tab",
      panelId,
      tabId: paneId,
      label: title,
    } satisfies TabDragData,
  })

  const identity = processIdentity(processName)
  const tileStyle = deckTileStyle(identity)
  const gitShortcut = shortcutFor?.("mux.openGit")
  const nvimShortcut = shortcutFor?.("mux.openNeovim")
  const zoomShortcut = shortcutFor?.("mux.zoomPane")

  const secondaryControls = (
    <>
      {trailing}
      {onOpenGit ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={gitShortcut ? `Open Git (${gitShortcut})` : "Open Git"}
          title={gitShortcut ? `Open Git (${gitShortcut})` : "Open Git"}
          data-yaade-mux-open-git=""
          className={secondaryControlClass}
          onClick={onOpenGit}
        >
          <GitBranch />
        </Button>
      ) : null}
      {onOpenNeovim ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={nvimShortcut ? `Open Neovim (${nvimShortcut})` : "Open Neovim"}
          title={nvimShortcut ? `Open Neovim (${nvimShortcut})` : "Open Neovim"}
          data-yaade-mux-open-nvim=""
          className={secondaryControlClass}
          onClick={onOpenNeovim}
        >
          <NeovimIcon />
        </Button>
      ) : null}
      {canZoom ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={zoomed ? "Restore pane" : "Zoom pane"}
          title={
            zoomShortcut
              ? `${zoomed ? "Restore" : "Zoom"} (${zoomShortcut})`
              : zoomed
                ? "Restore pane"
                : "Zoom pane"
          }
          data-yaade-mux-zoom=""
          className={secondaryControlClass}
          onClick={onZoom}
        >
          {zoomed ? (
            <Minimize2 />
          ) : (
            <Maximize2 />
          )}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Close pane"
        title="Close pane"
        data-yaade-mux-close-pane=""
        className={secondaryControlClass}
        onClick={onClose}
      >
        <X />
      </Button>
    </>
  )

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
            "group/mux-chrome relative flex h-7 shrink-0 items-center gap-0.5 border-b px-1.5",
            "border-border bg-card",
            focused && "bg-secondary/30",
            // Title-only panes keep a short focus hairline over the process tile.
            // Tabbed panes own their own indicator on the active tab.
            focused &&
              !center &&
              "after:absolute after:top-0 after:left-2 after:h-px after:w-16 after:bg-primary",
            isDragging && "opacity-45",
            className,
          )}
          onDoubleClick={event => {
            // Ignore double-clicks on buttons / controls.
            if ((event.target as HTMLElement).closest("button") && !(event.target as HTMLElement).closest("[data-yaade-mux-pane-title]")) {
              return
            }
            if (canZoom) onZoom()
          }}
        >
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={title || "Pane"}
            title={title || undefined}
            data-yaade-mux-pane-title=""
            data-yaade-mux-pane-drag=""
            className={cn(
              "h-6 shrink justify-start gap-1.5 px-1",
              title ? "max-w-[32%]" : "max-w-8",
              draggable && !zoomed
                ? "cursor-grab touch-none active:cursor-grabbing"
                : "",
            )}
            {...(draggable && !zoomed ? { ...attributes, ...listeners } : {})}
          >
            <span
              aria-hidden
              data-yaade-mux-pane-process={processName ?? ""}
              style={tileStyle}
              className="flex size-3.5 shrink-0 items-center justify-center rounded-sm text-4xs font-semibold leading-none ring-1 ring-border"
            >
              {identity.glyph}
            </span>
            {dirty ? (
              <span
                aria-label="Unsaved changes"
                data-yaade-mux-pane-dirty=""
                className="size-1.5 shrink-0 rounded-full bg-primary"
              />
            ) : null}
            {title ? (
              <span
                className={cn(
                  "min-w-0 truncate text-xs font-medium",
                  focused ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {title}
              </span>
            ) : null}
          </Button>
          <div
            ref={contextRef}
            data-yaade-session-header-context=""
            className="flex min-h-0 min-w-0 flex-1 items-stretch self-stretch overflow-hidden"
          >
            {center}
          </div>
          <div
            className="flex shrink-0 items-center gap-0.5"
            onPointerDown={event => event.stopPropagation()}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Split right"
              data-yaade-mux-split="right"
              className="text-muted-foreground hover:text-foreground"
              onClick={onSplitRight}
            >
              <Columns2 />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Split down"
              data-yaade-mux-split="down"
              className="text-muted-foreground hover:text-foreground"
              onClick={onSplitDown}
            >
              <Rows2 />
            </Button>
            {secondaryControls}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent data-yaade-mux-pane-context-menu="">
        <ContextMenuItem onSelect={onSplitRight}>Split Right</ContextMenuItem>
        <ContextMenuItem onSelect={onSplitDown}>Split Down</ContextMenuItem>
        {onOpenGit ? (
          <ContextMenuItem onSelect={onOpenGit}>
            Open Git
            {gitShortcut ? <ContextMenuShortcut>{gitShortcut}</ContextMenuShortcut> : null}
          </ContextMenuItem>
        ) : null}
        {onOpenNeovim ? (
          <ContextMenuItem onSelect={onOpenNeovim}>
            Open Neovim
            {nvimShortcut ? <ContextMenuShortcut>{nvimShortcut}</ContextMenuShortcut> : null}
          </ContextMenuItem>
        ) : null}
        {canZoom ? (
          <ContextMenuItem onSelect={onZoom}>
            {zoomed ? "Restore Pane" : "Zoom Pane"}
            {zoomShortcut ? <ContextMenuShortcut>{zoomShortcut}</ContextMenuShortcut> : null}
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
