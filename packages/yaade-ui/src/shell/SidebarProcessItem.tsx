import type { ReactNode } from "react"
import { X } from "lucide-react"
import { Badge } from "../components/ui/badge.js"
import {
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../components/ui/sidebar.js"
import { Button } from "../components/ui/button.js"
import { cn } from "../lib/utils.js"

export type SidebarProcessItemData = {
  id: string
  label: string
  subtitle?: string
  icon?: ReactNode
  selected?: boolean
  status?: string
  statusVariant?: "default" | "secondary" | "destructive" | "outline"
  onSelect: () => void
  onClose?: () => void
}

export function SidebarProcessItem({
  item,
  variant,
  onSelect = item.onSelect,
}: {
  item: SidebarProcessItemData
  variant: "compact" | "menu"
  onSelect?: () => void
}) {
  if (variant === "compact") {
    return (
      <div
        data-yaade-list-item=""
        className={cn(
          "group mb-0.5 flex w-full shrink-0 items-stretch gap-0.5 rounded-md",
          item.selected && "bg-accent",
        )}
      >
        <button
          type="button"
          data-yaade-instance-sidebar-item={item.id}
          aria-current={item.selected ? "true" : undefined}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
            item.selected ? "text-accent-foreground" : "hover:bg-accent/60",
          )}
          onClick={onSelect}
        >
          {item.icon}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">{item.label}</span>
            {item.subtitle ? (
              <span className="block truncate text-3xs text-muted-foreground">
                {item.subtitle}
              </span>
            ) : null}
          </span>
        </button>
        {item.selected && item.onClose ? (
          <div className="flex shrink-0 items-center pr-1">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={`Close ${item.label}`}
              data-yaade-instance-sidebar-close={item.id}
              onClick={event => {
                event.stopPropagation()
                item.onClose?.()
              }}
            >
              <X />
            </Button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <SidebarMenuItem
      className="shrink-0"
      data-yaade-project-process-item={item.id}
      data-yaade-list-item=""
    >
      <SidebarMenuButton
        type="button"
        isActive={item.selected}
        tooltip={item.label}
        onClick={onSelect}
        className="h-auto min-h-8 py-1.5"
        aria-current={item.selected ? "true" : undefined}
        data-yaade-instance-sidebar-item={item.id}
      >
        {item.icon}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-xs">{item.label}</span>
          {item.subtitle ? (
            <span className="truncate text-3xs text-sidebar-foreground/60">
              {item.subtitle}
            </span>
          ) : null}
        </span>
      </SidebarMenuButton>
      {item.status ? (
        <SidebarMenuBadge>
          <Badge variant={item.statusVariant ?? "secondary"} className="h-4 px-1 text-4xs">
            {item.status}
          </Badge>
        </SidebarMenuBadge>
      ) : null}
      {item.onClose ? (
        <SidebarMenuAction
          type="button"
          showOnHover
          aria-label={`Close ${item.label}`}
          onClick={event => {
            event.stopPropagation()
            item.onClose?.()
          }}
          data-yaade-instance-sidebar-close={item.id}
        >
          <X />
        </SidebarMenuAction>
      ) : null}
    </SidebarMenuItem>
  )
}
