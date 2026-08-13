import { PaletteShell, type PaletteShellItem } from "@yaade/ui"
import type { AppSession } from "@yaade/rpc"

export type SessionSwitcherEntry =
  | { readonly kind: "visible"; readonly session: AppSession }
  | { readonly kind: "archived"; readonly session: AppSession }

export type SessionSwitcherProps = {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly sessions: readonly AppSession[]
  readonly archived: readonly AppSession[]
  readonly activeSessionId?: AppSession["id"]
  readonly onSelect: (session: AppSession) => void
  readonly onRestore: (session: AppSession) => void
}

export function SessionSwitcher(props: SessionSwitcherProps) {
  const items: PaletteShellItem<SessionSwitcherEntry>[] = [
    ...props.sessions.map(session => ({
      key: session.id,
      value: `${session.title} active`,
      data: { kind: "visible" as const, session },
    })),
    ...props.archived.map(session => ({
      key: `archived:${session.id}`,
      value: `${session.title} archived restore`,
      data: { kind: "archived" as const, session },
    })),
  ]
  return (
    <PaletteShell
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Switch session"
      description="Jump to a visible session or restore an archived one."
      placeholder="Filter sessions…"
      size="picker"
      items={items}
      emptyLabel="No sessions."
      onSelect={entry => {
        if (entry.kind === "archived") props.onRestore(entry.session)
        else props.onSelect(entry.session)
        props.onOpenChange(false)
      }}
      renderItem={entry => (
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">{entry.session.title}</span>
          {entry.kind === "archived" ? (
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">archived</span>
          ) : entry.session.id === props.activeSessionId ? (
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">active</span>
          ) : null}
        </span>
      )}
    />
  )
}
