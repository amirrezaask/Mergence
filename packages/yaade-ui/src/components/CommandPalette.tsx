import { useMemo } from "react"
import { Badge } from "@/components/ui/badge.js"
import { KeyBindingKbd } from "./KeyBindingKbd.js"
import { PaletteShell, type PaletteShellItem } from "./palette/PaletteShell.js"

interface CommandDescriptor {
  id: string
  title: string
  category?: string
  keybinding?: string
  aliases?: string[]
  recent?: boolean
}

export function CommandPalette({
  open,
  onOpenChange,
  commands,
  onRun,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  commands: CommandDescriptor[]
  onRun: (id: string) => void
}) {
  const items = useMemo<PaletteShellItem<CommandDescriptor>[]>(
    () =>
      commands.map(cmd => ({
        key: cmd.id,
        value: `${cmd.id} ${cmd.title} ${(cmd.aliases ?? []).join(" ")}`,
        data: cmd,
      })),
    [commands],
  )

  return (
    <PaletteShell
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Search commands…"
      placeholder="Search commands…"
      items={items}
      onSelect={cmd => onRun(cmd.id)}
      emptyLabel="No results."
      requireQueryForSelection={false}
      rowLayout="single"
      renderItem={cmd => (
        <span className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <span
            data-slot="palette-row-content"
            className="flex min-w-0 items-baseline gap-2"
          >
            <span
              data-slot="palette-row-title"
              className="min-w-0 truncate font-medium leading-tight"
            >
              {cmd.title}
            </span>
            {cmd.category ? (
              <span
                data-slot="palette-row-meta"
                className="shrink-0 truncate text-xs leading-tight text-muted-foreground"
              >
                {cmd.category}
              </span>
            ) : null}
            {cmd.recent ? (
              <Badge
                variant="secondary"
                className="shrink-0 px-1.5 py-0 text-3xs leading-normal"
              >
                Recent
              </Badge>
            ) : null}
          </span>
          {cmd.keybinding ? (
            <span
              data-slot="palette-row-action"
              className="flex shrink-0 items-center self-center"
            >
              <KeyBindingKbd binding={cmd.keybinding} />
            </span>
          ) : null}
        </span>
      )}
    />
  )
}
