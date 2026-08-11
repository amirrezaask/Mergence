import { Badge } from "@yaade/ui/primitives"
import { isDevBuild } from "./build-branding.js"

/**
 * Corner chip so a Vite tab is visually distinct from a release build even
 * when the favicon is hard to see at 16×16.
 */
export function BuildModeBadge() {
  if (!isDevBuild()) return null
  return (
    <div
      className="pointer-events-none fixed top-2 right-2 z-[200]"
      data-yaade-build-badge="dev"
    >
      <Badge
        variant="warning"
        className="rounded-md px-1.5 py-0 text-4xs font-semibold tracking-wide shadow-sm"
      >
        DEV
      </Badge>
    </div>
  )
}
