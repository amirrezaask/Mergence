import { useRef } from "react";
import { Plus, X } from "lucide-react";
import type { AppSession, SessionId } from "@yaade/rpc";
import { Button } from "@yaade/ui/primitives";

export type SessionTabStripProps = {
  readonly sessions: readonly AppSession[];
  readonly activeSessionId?: SessionId;
  readonly onSelect: (id: SessionId) => void;
  readonly onClose: (id: SessionId) => void;
  readonly onCreate: () => void;
  readonly onRename: (id: SessionId, title: string) => void;
  readonly onReorder: (ids: readonly SessionId[]) => void;
};

export function SessionTabStrip(props: SessionTabStripProps) {
  const dragId = useRef<SessionId | null>(null);
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
      <nav
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        aria-label="Sessions"
        role="tablist"
      >
        {props.sessions.map((session, index) => (
          <div
            key={session.id}
            role="tab"
            tabIndex={session.id === props.activeSessionId ? 0 : -1}
            aria-selected={session.id === props.activeSessionId}
            draggable
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
            className="flex shrink-0 items-center rounded-md border border-transparent bg-muted/40 pl-1"
          >
            <Button
              variant={
                session.id === props.activeSessionId ? "secondary" : "ghost"
              }
              size="sm"
              onClick={() => props.onSelect(session.id)}
              onDoubleClick={() => {
                const next = window
                  .prompt("Rename session", session.title)
                  ?.trim();
                if (next) props.onRename(session.id, next);
              }}
            >
              {session.title}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Close ${session.title}`}
              onClick={() => props.onClose(session.id)}
            >
              <X />
            </Button>
          </div>
        ))}
      </nav>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="New session"
        onClick={props.onCreate}
      >
        <Plus />
      </Button>
    </header>
  );
}
