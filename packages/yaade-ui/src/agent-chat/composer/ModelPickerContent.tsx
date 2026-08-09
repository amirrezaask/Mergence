import { memo, useMemo, useState } from "react"
import type { ProviderDriverKind, ProviderInstanceId } from "./contracts/types.js"
import type { ProviderInstanceEntry } from "./providerInstances.js"
import type { ModelEsque } from "./providerIconUtils.js"
import { getTriggerDisplayModelName } from "./providerIconUtils.js"
import { ProviderInstanceIcon } from "./ProviderInstanceIcon.js"
import { cn } from "./lib/cn.js"
import { Button } from "./ui/button.js"

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  activeInstanceId: ProviderInstanceId
  model: string
  lockedProvider: ProviderDriverKind | null
  lockedContinuationGroupKey?: string | null
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>
  terminalOpen?: boolean
  onRequestClose: () => void
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void
}) {
  const [sidebarInstanceId, setSidebarInstanceId] = useState(props.activeInstanceId)
  const [query, setQuery] = useState("")

  const activeEntry =
    props.instanceEntries.find(entry => entry.instanceId === sidebarInstanceId) ??
    props.instanceEntries[0] ??
    null

  const models = useMemo(() => {
    if (!activeEntry) return [] as ModelEsque[]
    const all = props.modelOptionsByInstance.get(activeEntry.instanceId) ?? []
    const q = query.trim().toLowerCase()
    if (!q) return [...all]
    return all.filter(
      model =>
        model.slug.toLowerCase().includes(q) ||
        model.name.toLowerCase().includes(q) ||
        (model.shortName?.toLowerCase().includes(q) ?? false),
    )
  }, [activeEntry, props.modelOptionsByInstance, query])

  return (
    <div
      data-model-picker-content=""
      className="flex h-[min(28rem,70vh)] w-[min(36rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
    >
      <aside className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-border bg-muted/30 p-1.5">
        {props.instanceEntries.map(entry => {
          const selected = entry.instanceId === (activeEntry?.instanceId ?? "")
          return (
            <button
              key={entry.instanceId}
              type="button"
              disabled={!entry.available}
              title={entry.unavailableReason}
              data-yaade-list-item=""
              data-model-picker-provider={entry.driverKind}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                !entry.available && "opacity-50",
              )}
              onClick={() => setSidebarInstanceId(entry.instanceId)}
            >
              <ProviderInstanceIcon
                driverKind={entry.driverKind}
                displayName={entry.displayName}
                accentColor={entry.accentColor}
                className="size-4"
                iconClassName="size-4"
              />
              <span className="min-w-0 truncate">{entry.displayName}</span>
            </button>
          )
        })}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-border p-2">
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.currentTarget.value)}
            placeholder="Search models…"
            aria-label="Search models"
            data-model-picker-search=""
            className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto p-1"
          data-yaade-list-panel="composer-models"
          role="listbox"
        >
          {models.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">No results</p>
          ) : (
            models.map(model => {
              const disabledReason = activeEntry
                ? props.getModelDisabledReason?.(activeEntry.instanceId, model.slug) ?? null
                : "No provider"
              const selected =
                activeEntry?.instanceId === props.activeInstanceId && model.slug === props.model
              return (
                <Button
                  key={`${activeEntry?.instanceId ?? ""}:${model.slug}`}
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabledReason !== null || !activeEntry}
                  title={disabledReason ?? undefined}
                  data-yaade-list-item=""
                  data-model-slug={model.slug}
                  aria-selected={selected}
                  className={cn(
                    "h-auto w-full justify-start gap-2 rounded-md px-2 py-2 text-left font-normal",
                    selected && "bg-accent",
                  )}
                  onClick={() => {
                    if (!activeEntry || disabledReason) return
                    props.onInstanceModelChange(activeEntry.instanceId, model.slug)
                    props.onRequestClose()
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {getTriggerDisplayModelName(model)}
                  </span>
                  {model.isDefault ? (
                    <span className="text-[10px] text-muted-foreground">Default</span>
                  ) : null}
                </Button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
})
