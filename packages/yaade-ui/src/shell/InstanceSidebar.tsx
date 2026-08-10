import { Plus, X } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "../components/ui/button.js"
import { cn } from "../lib/utils.js"

export type InstanceSidebarItem = {
  id: string
  label: string
  subtitle?: string
  icon?: ReactNode
}

export type InstanceSidebarProps = {
  title: string
  titleIcon?: ReactNode
  items: readonly InstanceSidebarItem[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onClose?: (id: string) => void
  emptyLabel: string
  listPanelId: string
  newLabel?: string
  className?: string
  /** Value for `data-yaade-instance-sidebar` (e.g. `agents`, `terminals`). */
  dataPrefix: string
}

export function InstanceSidebar({
  title,
  titleIcon,
  items,
  activeId,
  onSelect,
  onNew,
  onClose,
  emptyLabel,
  listPanelId,
  newLabel = "New",
  className,
  dataPrefix,
}: InstanceSidebarProps) {
  return (
    <aside
      className={cn(
        "flex w-56 shrink-0 flex-col border-r border-border bg-secondary/10",
        className,
      )}
      data-yaade-instance-sidebar={dataPrefix}
      aria-label={title}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2.5">
        {titleIcon}
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          data-yaade-instance-sidebar-new=""
          onClick={onNew}
        >
          <Plus data-icon="inline-start" />
          {newLabel}
        </Button>
      </div>
      <nav
        className="min-h-0 flex-1 overflow-y-auto p-1.5"
        data-yaade-list-panel={listPanelId}
      >
        {items.length === 0 ? (
          <p className="px-2 py-3 text-3xs text-muted-foreground">{emptyLabel}</p>
        ) : (
          items.map(item => {
            const selected = activeId === item.id
            return (
              <div
                key={item.id}
                data-yaade-list-item=""
                className={cn(
                  "group mb-0.5 flex w-full shrink-0 items-stretch gap-0.5 rounded-md",
                  selected && "bg-accent",
                )}
              >
                <button
                  type="button"
                  data-yaade-instance-sidebar-item={item.id}
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                    selected
                      ? "text-accent-foreground"
                      : "hover:bg-accent/60",
                  )}
                  onClick={() => onSelect(item.id)}
                >
                  {item.icon}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">
                      {item.label}
                    </span>
                    {item.subtitle ? (
                      <span className="block truncate text-3xs text-muted-foreground capitalize">
                        {item.subtitle}
                      </span>
                    ) : null}
                  </span>
                </button>
                {selected && onClose ? (
                  <div className="flex shrink-0 items-center pr-1">
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Close ${item.label}`}
                      data-yaade-instance-sidebar-close={item.id}
                      onClick={() => onClose(item.id)}
                    >
                      <X />
                    </Button>
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </nav>
    </aside>
  )
}
