import * as React from "react"
import { SidebarMenuSubButton } from "@/components/ui/sidebar.js"
import { yaadeFocusRingClass, yaadeInteractiveRowClass } from "@/motion/tokens.js"
import { cn } from "@/lib/utils.js"

export type ListRowProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: React.Ref<HTMLButtonElement>
  size?: "sm" | "md"
  isActive?: boolean
}

export function ListRow({
  className,
  size = "sm",
  isActive = false,
  children,
  ref,
  ...props
}: ListRowProps) {
  return (
    <SidebarMenuSubButton
      asChild
      size={size}
      isActive={isActive}
      className={cn(
        "group h-auto min-h-[var(--yaade-location-row-height)] w-full shrink-0 flex-col items-stretch justify-center gap-0 overflow-hidden p-0 text-left text-foreground",
        yaadeInteractiveRowClass,
        yaadeFocusRingClass,
        className,
      )}
    >
      <button ref={ref} type="button" {...props}>
        {children}
      </button>
    </SidebarMenuSubButton>
  )
}
