import * as React from "react"

import { cn } from "@/lib/utils.js"

/**
 * Chat transcript viewport. It deliberately does not auto-scroll: the runtime
 * owns follow-tail policy, while this component remains safe for streamed rows.
 */
export function MessageScroller({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-scroller"
      className={cn(
        "min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-smooth [scrollbar-gutter:stable]",
        className,
      )}
      {...props}
    />
  )
}
