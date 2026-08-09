import { useEffect, useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { AgentRunInfo } from "@yaade/workspace"
import { Bot, Clock3 } from "lucide-react"
import { Badge } from "../components/ui/badge.js"
import { Spinner } from "../components/ui/spinner.js"

export type AgentActivityListProps = {
  runs: readonly AgentRunInfo[]
  loading?: boolean
  hasMore?: boolean
  onLoadMore?: () => void
  hrefForRun: (run: AgentRunInfo) => string
}

function duration(run: AgentRunInfo): string {
  const start = Date.parse(run.startedAt ?? run.createdAt)
  const end = Date.parse(run.endedAt ?? run.lastActivityAt ?? run.createdAt)
  const minutes = Math.max(0, Math.round((end - start) / 60_000))
  return minutes < 1 ? "<1m" : `${minutes}m`
}

export function AgentActivityList({
  runs,
  loading = false,
  hasMore = false,
  onLoadMore,
  hrefForRun,
}: AgentActivityListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: runs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 58,
    overscan: 8,
    getItemKey: index => runs[index]?.runId ?? index,
  })
  const virtualRows = virtualizer.getVirtualItems()
  const finalIndex = virtualRows.at(-1)?.index ?? -1

  useEffect(() => {
    if (hasMore && !loading && finalIndex >= runs.length - 10) onLoadMore?.()
  }, [finalIndex, hasMore, loading, onLoadMore, runs.length])

  if (runs.length === 0 && !loading) {
    return (
      <div className="grid h-40 place-items-center rounded-md bg-secondary/40 text-xs text-muted-foreground">
        Completed and stopped agents will appear here.
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      className="h-80 overflow-y-auto rounded-md border border-border bg-secondary/20"
      data-yaade-list-panel="hq-agent-activity"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualRows.map(row => {
          const run = runs[row.index]
          if (!run) return null
          return (
            <a
              key={run.runId}
              href={hrefForRun(run)}
              className="absolute inset-x-0 flex h-[58px] shrink-0 items-center gap-3 border-b border-border/60 px-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              style={{ transform: `translateY(${row.start}px)` }}
              data-yaade-list-item
              data-yaade-agent-activity={run.runId}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
                <Bot className="size-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{run.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {run.provider} · {run.checkoutKey} · {run.endReason ?? run.processState}
                </span>
              </span>
              <Badge variant={run.activityState === "failed" ? "destructive" : "outline"}>
                {run.activityState}
              </Badge>
              <span className="hidden items-center gap-1 font-mono text-xs text-muted-foreground sm:flex">
                <Clock3 className="size-3" /> {duration(run)}
              </span>
            </a>
          )
        })}
      </div>
      {loading ? (
        <div className="sticky bottom-0 flex justify-center bg-background/80 py-2" role="status">
          <Spinner className="size-4" />
          <span className="sr-only">Loading agent activity</span>
        </div>
      ) : null}
    </div>
  )
}
