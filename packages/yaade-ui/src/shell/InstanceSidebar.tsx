import { Plus } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "../components/ui/button.js"
import { cn } from "../lib/utils.js"
import { SidebarShell } from "./SidebarShell.js"
import { SidebarProcessItem } from "./SidebarProcessItem.js"

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
    <SidebarShell
      className={cn("w-56 shrink-0", className)}
      aria-label={title}
      dataAttributes={{ "data-yaade-instance-sidebar": dataPrefix }}
      header={
        <>
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
        </>
      }
      contentAs="nav"
      contentClassName="overflow-y-auto p-1.5"
      contentProps={{
        "data-yaade-list-panel": listPanelId,
      }}
    >
      {items.length === 0 ? (
        <p className="px-2 py-3 text-3xs text-muted-foreground">{emptyLabel}</p>
      ) : (
          items.map(item => {
          const selected = activeId === item.id
          return (
            <SidebarProcessItem
              key={item.id}
              item={{
                ...item,
                selected,
                onSelect: () => onSelect(item.id),
                onClose: onClose ? () => onClose(item.id) : undefined,
              }}
              variant="compact"
            />
          )
        })
      )}
    </SidebarShell>
  )
}
