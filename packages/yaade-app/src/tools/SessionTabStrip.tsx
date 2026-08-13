import { useRef, useState } from "react";
import { PanelLeft, Plus, X } from "lucide-react";
import type { AppSession, SessionId } from "@yaade/rpc";
import { Button, Input } from "@yaade/ui/primitives";

export type SessionTabStripProps = {
  readonly sessions: readonly AppSession[];
  readonly activeSessionId?: SessionId;
  readonly onSelect: (id: SessionId) => void;
  readonly onClose: (id: SessionId) => void;
  readonly onCreate: () => void;
  readonly onRename: (id: SessionId, title: string) => void;
  readonly onReorder: (ids: readonly SessionId[]) => void;
  readonly onOpenSidebar: () => void;
};

export function SessionTabStrip(props: SessionTabStripProps) {
  const dragId = useRef<SessionId | null>(null);
  const [editingId, setEditingId] = useState<SessionId | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  const finishRename = (session: AppSession) => {
    const next = draftTitle.trim();
    setEditingId(null);
    if (next && next !== session.title) props.onRename(session.id, next);
  };

  return (
    <header
      className="flex h-11 shrink-0 items-center border-b border-border bg-card/80 backdrop-blur-xl"
      data-yaade-session-tabs
    >
      <div className="flex h-full shrink-0 items-center border-r border-border px-2 md:hidden">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Open tool sidebar"
          onClick={props.onOpenSidebar}
        >
          <PanelLeft />
        </Button>
      </div>
      <nav
        className="flex h-full min-w-0 flex-1 items-end gap-1 overflow-x-auto px-2 pt-1.5"
        aria-label="Sessions"
        role="tablist"
      >
        {props.sessions.map((session, index) => {
          const active = session.id === props.activeSessionId;
          return (
            <div
              key={session.id}
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              data-active={active ? "true" : undefined}
              draggable={editingId !== session.id}
              onDragStart={() => {
                dragId.current = session.id;
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                const from = dragId.current;
                dragId.current = null;
                if (!from || from === session.id) return;
                const ids = props.sessions.map((item) => item.id);
                const fromIndex = ids.indexOf(from);
                if (fromIndex < 0) return;
                ids.splice(fromIndex, 1);
                ids.splice(index, 0, from);
                props.onReorder(ids);
              }}
              className="group relative flex h-8 min-w-28 shrink-0 items-center rounded-t-lg border border-b-0 border-transparent px-1 transition-[color,background-color,border-color] duration-[var(--yaade-motion-hot)] data-[active=true]:border-border data-[active=true]:bg-background"
            >
              <span
                className="absolute inset-x-2 top-0 h-0.5 origin-center scale-x-0 rounded-full bg-primary transition-transform duration-[var(--yaade-motion-menu)] ease-[var(--yaade-ease-out)] group-data-[active=true]:scale-x-100"
                aria-hidden
              />
              {editingId === session.id ? (
                <Input
                  aria-label={`Rename ${session.title}`}
                  className="h-6 min-w-24 border-primary/50 bg-background px-1.5"
                  autoFocus
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  onBlur={() => finishRename(session)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") finishRename(session);
                    if (event.key === "Escape") setEditingId(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate px-2 text-left text-xs font-medium text-muted-foreground outline-none transition-colors group-data-[active=true]:text-foreground"
                  onClick={() => props.onSelect(session.id)}
                  onDoubleClick={() => {
                    setDraftTitle(session.title);
                    setEditingId(session.id);
                  }}
                >
                  {session.title}
                </button>
              )}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Close ${session.title}`}
                className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-data-[active=true]:opacity-70"
                onClick={() => props.onClose(session.id)}
              >
                <X />
              </Button>
            </div>
          );
        })}
      </nav>
      <div className="flex h-full shrink-0 items-center border-l border-border/70 px-2">
        <Button
          size="sm"
          variant="secondary"
          aria-label="New session"
          onClick={props.onCreate}
        >
          <Plus data-icon="inline-start" />
          <span className="hidden sm:inline">New session</span>
        </Button>
      </div>
    </header>
  );
}
