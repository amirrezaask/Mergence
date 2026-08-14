import { KeyBindingKbd } from "@/components/KeyBindingKbd.js"
import { cn } from "@/lib/utils.js"

export type WhichKeyEntry = {
  key: string
  desc: string
  group?: string
}

export type WhichKeyGroup = {
  id: string
  label: string
}

export function WhichKeyPanel({
  prefix,
  entries,
  groups,
  onSelect,
  variant = "bar",
}: {
  prefix: string
  entries: WhichKeyEntry[]
  groups?: readonly WhichKeyGroup[]
  onSelect?: (key: string) => void
  variant?: "bar" | "overlay"
}) {
  const clustered = clusterEntries(entries, groups)
  const overlay = variant === "overlay"

  return (
    <div
      className={cn(
        overlay
          ? "rounded-md border border-border bg-popover/96 shadow-lg backdrop-blur-xl"
          : "border-t border-primary/35 bg-popover px-4 py-2.5",
      )}
      data-yaade-which-key=""
      data-variant={variant}
      role="dialog"
      aria-label="Prefix commands"
    >
      <div
        className={cn(
          "flex items-baseline gap-2 text-xs text-foreground",
          overlay
            ? "border-b border-border px-3 py-2"
            : "mb-2",
        )}
      >
        <KeyBindingKbd binding={prefix} />
        <span className="text-muted-foreground">then</span>
      </div>
      <div
        className={cn(
          overlay
            ? "grid grid-cols-1 gap-4 p-3 sm:grid-cols-3"
            : "flex flex-wrap gap-x-6 gap-y-2",
        )}
      >
        {clustered.map(cluster => (
          <div key={cluster.id} className="flex min-w-0 flex-col gap-1">
            {cluster.label ? (
              <p className="px-1 text-3xs font-medium tracking-wide text-muted-foreground uppercase">
                {cluster.label}
              </p>
            ) : null}
            <div className={overlay ? "flex flex-col gap-0.5" : "flex flex-wrap gap-x-6 gap-y-2"}>
              {cluster.items.map(entry => {
                const row = (
                  <>
                    <KeyBindingKbd
                      binding={entry.key}
                      className="min-w-5 justify-center"
                    />
                    <span className="min-w-0 truncate text-sm text-muted-foreground">
                      {entry.desc}
                    </span>
                  </>
                )
                if (!onSelect) {
                  return (
                    <div key={entry.key} className="flex min-w-[148px] items-baseline gap-2">
                      {row}
                    </div>
                  )
                }
                return (
                  <button
                    key={entry.key}
                    type="button"
                    data-yaade-which-key-item={entry.key}
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                    onClick={() => onSelect(entry.key)}
                  >
                    {row}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function clusterEntries(
  entries: WhichKeyEntry[],
  groups?: readonly WhichKeyGroup[],
): readonly { id: string; label: string; items: WhichKeyEntry[] }[] {
  if (!groups || groups.length === 0) {
    return [{ id: "all", label: "", items: entries }]
  }
  return groups
    .map(group => ({
      id: group.id,
      label: group.label,
      items: entries.filter(entry => entry.group === group.id),
    }))
    .filter(group => group.items.length > 0)
}
