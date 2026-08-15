import type { KeyboardEvent } from "react"
import { XIcon } from "lucide-react"
import { cn } from "@/lib/utils.js"

export type ModalEditorBuffer = {
  tabId: string
  label: string
  dirty: boolean
  preview?: boolean
}

export type ModalEditorTabBarProps = {
  buffers: ModalEditorBuffer[]
  activeTabId: string | null
  focused?: boolean
  onActivateBuffer: (tabId: string) => void
  onCloseBuffer: (tabId: string) => void
  className?: string
}

export function ModalEditorTabBar(props: ModalEditorTabBarProps) {
  const {
    buffers,
    activeTabId,
    focused = false,
    onActivateBuffer,
    onCloseBuffer,
    className,
  } = props

  return (
    <div
      data-yaade-modal-editor-tabs=""
      data-yaade-session-header-tabs="editor"
      role="tablist"
      aria-label="Open buffers"
      onKeyDown={handleBufferTabKeyDown}
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-1 items-stretch gap-px overflow-x-auto",
        className,
      )}
    >
      {buffers.length === 0 ? (
        <p className="flex items-center px-1.5 text-3xs text-muted-foreground">
          No open buffers — {formatModPHint()}
        </p>
      ) : (
        buffers.map(buffer => {
          const active = buffer.tabId === activeTabId
          return (
            <div
              key={buffer.tabId}
              data-yaade-modal-editor-tab={buffer.tabId}
              data-active={active ? "" : undefined}
              data-yaade-session-tab-pill=""
              className={cn(
                "group relative flex max-w-40 min-w-0 shrink-0 cursor-pointer items-stretch rounded-sm border",
                active
                  ? "border-border/50 bg-muted/60 text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground",
              )}
              data-preview={buffer.preview ? "" : undefined}
              onMouseDown={event => {
                if (event.button === 1) {
                  event.preventDefault()
                  onCloseBuffer(buffer.tabId)
                  return
                }
                if (event.button !== 0) return
                if ((event.target as HTMLElement).closest("button[aria-label^='Close ']")) {
                  return
                }
                onActivateBuffer(buffer.tabId)
              }}
            >
              {active && focused ? (
                <span
                  data-yaade-pane-tab-indicator=""
                  className="pointer-events-none absolute inset-x-1.5 top-0 h-px bg-primary"
                  aria-hidden
                />
              ) : null}
              <button
                type="button"
                role="tab"
                id={`yaade-editor-tab-${encodeURIComponent(buffer.tabId)}`}
                aria-controls="yaade-modal-editor-tabpanel"
                aria-selected={active}
                aria-label={`${buffer.label}${buffer.dirty ? ", unsaved changes" : ""}`}
                data-dirty={buffer.dirty ? "" : undefined}
                tabIndex={active ? 0 : -1}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-0.5 px-1.5 text-left text-3xs font-medium leading-none outline-none focus-visible:underline focus-visible:underline-offset-2",
                  buffer.preview && "italic",
                )}
                onClick={() => onActivateBuffer(buffer.tabId)}
                title={buffer.label}
              >
                <span className="min-w-0 truncate">{buffer.label}</span>
                {buffer.dirty ? (
                  <span
                    data-yaade-buffer-dirty=""
                    className="size-1 shrink-0 rounded-full bg-primary"
                    aria-label="Unsaved changes"
                  />
                ) : null}
              </button>
              <button
                type="button"
                aria-label={`Close ${buffer.label}`}
                className="mr-1 inline-flex size-4 shrink-0 self-center items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
                onClick={event => {
                  event.stopPropagation()
                  onCloseBuffer(buffer.tabId)
                }}
              >
                <XIcon className="size-2.5" />
              </button>
            </div>
          )
        })
      )}
    </div>
  )
}

function formatModPHint(): string {
  const mod =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
      ? "⌘"
      : "Ctrl"
  return `${mod}P to open a file`
}

function handleBufferTabKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]')]
  if (tabs.length === 0) return
  const current = Math.max(0, tabs.indexOf(document.activeElement as HTMLButtonElement))
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
  event.preventDefault()
  tabs[next]?.focus()
  tabs[next]?.click()
}
